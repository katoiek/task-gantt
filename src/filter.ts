// フィルタ判定とグループ再マッピング（ビューから切り出した純粋関数）
// Filter matching and group remapping (pure functions extracted from the view)
import { Task, Filter, FilterMatch, StatusDef, CustomValue } from "./types";
import { anchorStart, anchorEnd, statusGroupOf } from "./model";
import { dayIndex, matchDate } from "./timeline";
import { linkLabel } from "./links";

export type GroupBy = "folder" | "status" | "assignee" | "tag";

// カスタムフィールドの値を、比べる文字の一覧に。リストは要素ごと、空の文字は捨てる / a custom field's value as the texts to compare: a list per element, blanks dropped
function customItems(v: CustomValue | undefined): string[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [String(v)];
  return list.map((x) => String(x).trim()).filter((x) => x !== "");
}

// 統合フィルタ 1 件がタスクに合致するか / does one unified filter match a task
export function matchFilter(t: Task, f: Filter, statuses: StatusDef[], today: number): boolean {
  if (f.kind === "date") {
    // 開始・期限のほか、日付型のカスタムフィールド（日付部分のみ）/ start and due, and date-type custom fields (the date part only)
    const cv = f.field === "start" || f.field === "end" ? undefined : t.custom[f.field.slice(3)];
    const iso = f.field === "start" ? anchorStart(t) : f.field === "end" ? anchorEnd(t) : typeof cv === "string" && cv ? cv.slice(0, 10) : undefined;
    return matchDate(iso ? dayIndex(iso) : undefined, f, today);
  }
  // 数値（カスタムフィールド）：数値でない値は「空」として扱う / number (custom fields): a non-number counts as empty
  if (f.kind === "number") {
    const cv = t.custom[f.field.slice(3)];
    const n = typeof cv === "number" && Number.isFinite(cv) ? cv : undefined;
    if (f.op === "empty") return n === undefined;
    if (f.op === "notEmpty") return n !== undefined;
    if (!Number.isFinite(f.value)) return true; // 値がまだ無いフィルタは、絞り込まない / a filter without a value yet doesn't narrow
    if (n === undefined) return false; // 数値の無いタスクは、比較から外れる（空のときだけ別）/ a task without a number drops out of a comparison (only "empty" differs)
    switch (f.op) {
      case "eq": return n === f.value;
      case "ne": return n !== f.value;
      case "gt": return n > f.value;
      case "lt": return n < f.value;
      case "gte": return n >= f.value;
      case "lte": return n <= f.value;
    }
  }
  // テキスト（タスク名・文字型のカスタムフィールド）：大文字小文字を無視。空の入力は素通し。リストの値は、どれか 1 つでも当てはまれば一致（否定の演算は、どれも当てはまらないとき）
  // text (name, text-type custom fields): case-insensitive; an empty query = no effect. A list value matches when any element does (a negative op: when none does)
  if (f.kind === "text") {
    const items = f.field === "name" ? [t.name] : customItems(t.custom[f.field.slice(3)]);
    if (f.op === "empty") return items.length === 0;
    if (f.op === "notEmpty") return items.length > 0;
    const q = f.value.trim().toLowerCase();
    if (q === "") return true;
    const low = items.map((x) => x.toLowerCase());
    switch (f.op) {
      case "is": return low.some((x) => x === q);
      case "isNot": return !low.some((x) => x === q);
      case "contains": return low.some((x) => x.includes(q));
      case "notContains": return !low.some((x) => x.includes(q));
      case "startsWith": return low.some((x) => x.startsWith(q));
      case "endsWith": return low.some((x) => x.endsWith(q));
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
      : f.field === "assignee" ? (t.assignee ? [t.assignee] : [])
        : t.tags;
  if (f.op === "empty") return vals.length === 0;
  if (f.op === "notEmpty") return vals.length > 0;
  // 値 "" は「未設定」を表すセンチネル。フィールド内は OR / "" is the "unset" sentinel; OR within the field
  const hit = f.values.some((v) => (v === "" ? vals.length === 0 : vals.includes(v)));
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

// グループ化の軸に合わせて groups を合成グループへ差し替える / remap `groups` to synthetic groups for the chosen axis
export function regroup(tasks: Task[], groupBy: GroupBy, flat: boolean, statuses: StatusDef[], noneLabel: string): Task[] {
  // フラットはグループを無視＝再マッピング不要（タグ複製で重複行が出るのも防ぐ）/ flat ignores groups: skip remap (also avoids tag-duplicated rows)
  if (groupBy === "folder" || flat) return tasks;
  // タグは多値＝1タスクを各タグのグループへ複製（タグ無しは (なし)）/ tags are multi-valued: duplicate a task into each tag's group
  if (groupBy === "tag") {
    const out: Task[] = [];
    for (const t of tasks) {
      if (t.tags.length === 0) out.push({ ...t, groups: [noneLabel] });
      else for (const tag of t.tags) out.push({ ...t, groups: [tag] });
    }
    return out;
  }
  // groups を単一の合成グループへ差し替えて既存の buildRows を再利用 / remap groups to reuse buildRows
  const statusLabel = new Map(statuses.map((s) => [s.id, s.label]));
  return tasks.map((t) => {
    const key =
      groupBy === "status"
        ? t.status ? statusLabel.get(t.status) ?? t.status : noneLabel
        : t.assignee ? linkLabel(t.assignee) : noneLabel;
    return { ...t, groups: [key] };
  });
}
