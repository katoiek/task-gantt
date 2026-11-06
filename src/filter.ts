// フィルタ判定とグループ再マッピング（ビューから切り出した純粋関数）
// Filter matching and group remapping (pure functions extracted from the view)
import { Task, Filter, FilterMatch, StatusDef } from "./types";
import { anchorStart, anchorEnd, statusGroupOf } from "./model";
import { dayIndex, matchDate } from "./timeline";
import { linkLabel } from "./links";

export type GroupBy = "folder" | "status" | "assignee" | "tag";

// 統合フィルタ 1 件がタスクに合致するか / does one unified filter match a task
export function matchFilter(t: Task, f: Filter, statuses: StatusDef[], today: number): boolean {
  if (f.kind === "date") {
    const iso = f.field === "start" ? anchorStart(t) : anchorEnd(t);
    return matchDate(iso ? dayIndex(iso) : undefined, f, today);
  }
  // テキスト（タスク名）：大文字小文字を無視。空の入力は素通し / text (name): case-insensitive; empty query = no effect
  if (f.kind === "text") {
    const q = f.value.trim().toLowerCase();
    if (q === "") return true;
    const name = t.name.toLowerCase();
    switch (f.op) {
      case "is": return name === q;
      case "isNot": return name !== q;
      case "contains": return name.includes(q);
      case "notContains": return !name.includes(q);
      case "startsWith": return name.startsWith(q);
      case "endsWith": return name.endsWith(q);
    }
  }
  // カテゴリ（ステータス/グループ/担当者/タグ）：タスクの該当値集合を作って判定 / category: build the task's value set
  // グループは status から都度引く。設定に無い id やステータス未設定は空集合＝「未設定」扱いになり、
  // 「未完了（完了でもキャンセルでもない）」には含まれる
  // the group is derived from the status; an unknown id or no status yields an empty set, which
  // reads as "unset" — and therefore still counts as incomplete
  const group = f.field === "statusGroup" ? statusGroupOf(statuses, t.status) : undefined;
  const vals = f.field === "attention" ? attentionOf(t, statuses, today)
    : f.field === "status" ? (t.status ? [t.status] : [])
    : f.field === "statusGroup" ? (group ? [group] : [])
      : f.field === "assignee" ? t.assignees.map(linkLabel)
        : t.tags;
  if (f.op === "empty") return vals.length === 0;
  if (f.op === "notEmpty") return vals.length > 0;
  // 値 "" は「未設定」を表すセンチネル。フィールド内は OR。人は表示名で比べる（"Ben" と "[[Ben]]" は同じ人）
  // "" is the "unset" sentinel; OR within the field. People compare by display name ("Ben" and "[[Ben]]" are one person)
  const hit = f.values.some((v) => (v === "" ? vals.length === 0 : vals.includes(f.field === "assignee" ? linkLabel(v) : v)));
  return f.op === "isNot" ? !hit : hit;
}

// 気にかけるべき状態（フィルタ用）：止まっている（延期グループ）・期限切れ・急ぎ。終わった仕事には無い
// what needs attention (for filters): blocked (the Deferred group), overdue, urgent; finished work has none
export const ATTENTION = ["blocked", "overdue", "urgent"];
export function attentionOf(t: Task, statuses: StatusDef[], today: number): string[] {
  if (!isOpen(t, statuses)) return [];
  return [
    statusGroupOf(statuses, t.status) === "deferred" ? "blocked" : "",
    isOverdue(t, statuses, today) ? "overdue" : "",
    isUrgent(t) ? "urgent" : "",
  ].filter(Boolean);
}

// 統合フィルタを filterMatch（all=AND / any=OR）で結合して絞り込む / narrow tasks by filters combined with AND/OR
export function applyFilters(tasks: Task[], filters: Filter[], match: FilterMatch, statuses: StatusDef[], today: number): Task[] {
  if (filters.length === 0) return tasks;
  return tasks.filter((t) =>
    match === "any"
      ? filters.some((f) => matchFilter(t, f, statuses, today))
      : filters.every((f) => matchFilter(t, f, statuses, today))
  );
}

// 期限切れ＝期限が今日より前で、完了でもキャンセルでもない（「期限切れ」プリセットと同じ期限の読み方）
// overdue = due before today and neither completed nor cancelled (the due date read as the Overdue preset reads it)
export function isOverdue(t: Task, statuses: StatusDef[], today: number): boolean {
  const end = anchorEnd(t);
  return !!end && dayIndex(end) < today && isOpen(t, statuses);
}

// 残っている仕事＝完了でもキャンセルでもない / still outstanding = neither completed nor cancelled
export function isOpen(t: Task, statuses: StatusDef[]): boolean {
  const group = statusGroupOf(statuses, t.status);
  return group !== "completed" && group !== "cancelled";
}

// 割り込みの急ぎ仕事＝優先度が urgent / expedite / דחוף（大文字小文字は問わない）。ほかの値（high など）は普通の仕事
// urgent interrupting work = a priority of urgent / expedite / דחוף (any case); any other value (high, …) is normal work
const URGENT = new Set(["urgent", "expedite", "דחוף"]);
export function isUrgent(t: Task): boolean {
  return !!t.priority && URGENT.has(t.priority.trim().toLowerCase());
}

// 始まっている＝開始日（無ければ期限日）が今日以前、日付が無ければ始まっているとみなす / started = its start (else due) is today or earlier; no dates counts as started
const started = (t: Task, today: number): boolean => {
  const s = anchorStart(t);
  return !s || dayIndex(s) <= today;
};

// 割り込みと再開は、急ぎ仕事のノートの interrupts（「急ぎにする」で書く明示のリンク）だけから読む。推測はしない：リンクの無い急ぎ仕事は誰も止めない。
// 急ぎが始まって残っている間はリンク先が割り込み中。リンクしている急ぎが全部終わったら（完了・中止）再開待ちで、「再開」でリンクを消すまで残る。
// 一つでもまだ走っていれば割り込み中のまま（重なった割り込み）。リンク先のノートには何も書かず、ステータスも変えない
// interruptions and resumption are read only from urgent notes' `interrupts` (explicit links written by "Mark as urgent"); nothing is inferred, so
// urgent work without links stops nobody. While the urgent work has started and is outstanding, its targets are interrupted; once every urgent
// task linking a target is finished (completed or cancelled), the target waits to be resumed until "Resume" clears the links. If any is still
// running the target stays interrupted (overlapping interruptions). Nothing is written to the targets and their status doesn't change
export interface Interruptions {
  interrupted: Map<string, Task[]>; // 割り込まれたタスクのパス → まだ走っている急ぎ仕事 / interrupted task path → the urgent work still running
  resume: Map<string, Task[]>; // 再開を待つタスクのパス → 終わった急ぎ仕事（走っているものが無いときだけ）/ task path to resume → the finished urgent work (only when none still runs)
}
export function interruptions(tasks: Task[], statuses: StatusDef[], today: number): Interruptions {
  const interrupted = new Map<string, Task[]>();
  const resume = new Map<string, Task[]>();
  const add = (m: Map<string, Task[]>, p: string, u: Task) => m.set(p, [...(m.get(p) ?? []), u]);
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  for (const u of tasks) {
    for (const p of u.interrupts ?? []) {
      const t = byPath.get(p);
      if (!t || t === u || !isOpen(t, statuses)) continue;
      if (!isOpen(u, statuses)) add(resume, p, u);
      else if (isUrgent(u) && started(u, today)) add(interrupted, p, u);
    }
  }
  for (const p of interrupted.keys()) resume.delete(p);
  return { interrupted, resume };
}

// 「急ぎにする」ときの候補：同じ人の、ステータスが「始めた」ステータス（既定は In progress）の仕事だけ。To do や日付だけでは数えない
// candidates for "Mark as urgent": the same person's work whose status is the started status (In progress by default); To do or dates alone don't count
export function runningWorkOf(u: Task, tasks: Task[], startedId: string | undefined): Task[] {
  if (!startedId) return [];
  const people = new Set(u.assignees.map(linkLabel));
  return tasks.filter((t) => t.path !== u.path && !isUrgent(t) && t.status === startedId && t.assignees.some((a) => people.has(linkLabel(a))));
}

// 行の例外（強い順）。行には一番強いものと「ほかに何件」、詳細には全部を出す
// a row's exceptions, strongest first; the row shows the strongest plus how many more, the details show them all
export type Exception = "urgent" | "overdue" | "blocked" | "dependency" | "interrupted" | "resume";
export const EXCEPTIONS: Exception[] = ["urgent", "overdue", "blocked", "dependency", "interrupted", "resume"];
// いちばん強い例外 / the strongest exception of several
export function strongest(list: (Exception | undefined)[]): Exception | undefined {
  return EXCEPTIONS.find((e) => list.includes(e));
}
export function exceptionsOf(t: Task, statuses: StatusDef[], today: number, conflicts: Set<string>, ints: Interruptions): Exception[] {
  if (!isOpen(t, statuses)) return [];
  const has: Record<Exception, () => boolean> = {
    urgent: () => isUrgent(t),
    overdue: () => isOverdue(t, statuses, today),
    blocked: () => statusGroupOf(statuses, t.status) === "deferred",
    dependency: () => conflicts.has(t.path),
    interrupted: () => ints.interrupted.has(t.path),
    resume: () => ints.resume.has(t.path),
  };
  return EXCEPTIONS.filter((e) => has[e]());
}
export function exceptionOf(t: Task, statuses: StatusDef[], today: number, conflicts: Set<string>, ints: Interruptions): Exception | undefined {
  return exceptionsOf(t, statuses, today, conflicts, ints)[0];
}

// 次に始まるタスク：今日より後に始まる一番早いもの（日付の無いものは入らない）/ the next task to start: the earliest one starting after today (undated ones don't count)
export function nextToStart(tasks: Task[], today: number): Task | undefined {
  let best: Task | undefined;
  for (const t of tasks) {
    const s = anchorStart(t);
    if (s && dayIndex(s) > today && (!best || s < anchorStart(best)!)) best = t;
  }
  return best;
}

// 親タスクの要約：完了したサブタスクの数／（キャンセルを除く）全体、と次にやる（並び順で最初の残っている）サブタスク
// a parent's summary: subtasks done / all (cancelled left out), and the next one to do (the first outstanding one in order)
export function subtaskSummary(children: Task[], statuses: StatusDef[]): { done: number; total: number; next?: Task } {
  const counted = children.filter((c) => statusGroupOf(statuses, c.status) !== "cancelled");
  return {
    done: counted.filter((c) => statusGroupOf(statuses, c.status) === "completed").length,
    total: counted.length,
    next: counted.find((c) => isOpen(c, statuses)),
  };
}

// 残っている急ぎ仕事を兄弟の先頭へ、その次に再開を待つ仕事（それ以外の並びは cmp のまま）
// outstanding urgent work goes first among its siblings, then work waiting to be resumed (cmp orders the rest)
export function urgentFirst(statuses: StatusDef[], cmp: (a: Task, b: Task) => number, resume: ReadonlyMap<string, unknown> = new Map()): (a: Task, b: Task) => number {
  const hot = (t: Task) => (isUrgent(t) && isOpen(t, statuses) ? 0 : resume.has(t.path) ? 1 : 2);
  return (a, b) => hot(a) - hot(b) || cmp(a, b);
}

// グループ化の軸に合わせて groups を合成グループへ差し替える / remap `groups` to synthetic groups for the chosen axis
// 行の見出しが既に示している値（担当者・タグ）を除いた残り。見出しのキーは regroup と同じ作り方（担当者は表示名、タグはそのまま）。
// フラット表示の行は見出しが "" なので何も除かない
// the values left after dropping the one the row's heading already shows (an assignee or a tag); heading keys are built as in regroup
// (display name for an assignee, the tag as it is). Flat rows have the heading "", so nothing is dropped
export function besideHeading(values: string[], field: "assignees" | "tags", groupBy: GroupBy, heading: string): string[] {
  if (!heading || groupBy !== (field === "assignees" ? "assignee" : "tag")) return values;
  return values.filter((v) => (field === "assignees" ? linkLabel(v) : v) !== heading);
}

export function regroup(tasks: Task[], groupBy: GroupBy, flat: boolean, statuses: StatusDef[], noneLabel: string): Task[] {
  // フラットはグループを無視＝再マッピング不要（タグ複製で重複行が出るのも防ぐ）/ flat ignores groups: skip remap (also avoids tag-duplicated rows)
  if (groupBy === "folder" || flat) return tasks;
  // groups を合成グループへ差し替えて既存の buildRows を再利用。タグと担当者は多値なので、各グループへ複製する（無ければ (なし)）
  // remap groups to synthetic ones to reuse buildRows; tags and assignees are multi-valued, so a task is copied into each one's group
  const statusLabel = new Map(statuses.map((s) => [s.id, s.label]));
  return tasks.flatMap((t) => {
    const keys =
      groupBy === "status" ? (t.status ? [statusLabel.get(t.status) ?? t.status] : [])
        : groupBy === "tag" ? t.tags
          : [...new Set(t.assignees.map(linkLabel))];
    return (keys.length ? keys : [noneLabel]).map((key) => ({ ...t, groups: [key] }));
  });
}
