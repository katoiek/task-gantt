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
  const vals = f.field === "status" ? (t.status ? [t.status] : [])
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
  const group = statusGroupOf(statuses, t.status);
  return !!end && dayIndex(end) < today && group !== "completed" && group !== "cancelled";
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
