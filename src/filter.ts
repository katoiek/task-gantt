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
