// カンバンの振り分け：タスクをステータスごとの列に分ける。Obsidian に依存しない純粋な部分（画面は view.ts）
// the Kanban sorting: tasks into one column per status; the pure part (the screen is in view.ts)

import type { StatusDef, Task } from "./types";

export interface KanbanColumn {
  status: string | null; // null = 未割当（ステータスなし・設定にない ID）/ null = unassigned (no status, or an id the settings don't have)
  cards: Task[];
}

// 列の並び：ビューに保存した並びを先に、知らない ID は捨て、足りないステータスは設定の順で後ろに足す（保存が無ければ設定の順＝初期値）
// column order: the order saved in the view first, unknown ids dropped, statuses missing from it appended in the settings' order (nothing saved = the settings' order, the default)
export function orderStatusIds(statuses: StatusDef[], saved: string[]): string[] {
  const all = statuses.map((s) => s.id);
  const known = new Set(all);
  const out: string[] = [];
  for (const id of saved) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const id of all) if (!out.includes(id)) out.push(id);
  return out;
}

// タスクを列に分ける。先頭が未割当、続いてステータス（orderStatusIds の並び）。タスクの並びは渡された順のまま。
// 親が表示中のサブタスクは、独立したカードにせず、親のカードの中に入る（親がフィルタで外れていれば、独立したカード）
// split tasks into columns: unassigned first, then the statuses (in orderStatusIds' order); the tasks keep the order given.
// A subtask whose parent is shown isn't a card of its own, it lives inside its parent's card (a filtered-out parent makes it a card)
export function buildKanbanColumns(tasks: Task[], statuses: StatusDef[], saved: string[]): KanbanColumn[] {
  const shown = new Set(tasks.map((t) => t.path));
  const ids = orderStatusIds(statuses, saved);
  const byStatus = new Map<string | null, Task[]>();
  for (const id of [null, ...ids]) byStatus.set(id, []);
  for (const t of tasks) {
    if (t.parent && shown.has(t.parent)) continue;
    byStatus.get(t.status && byStatus.has(t.status) ? t.status : null)!.push(t);
  }
  return [null, ...ids].map((status) => ({ status, cards: byStatus.get(status)! }));
}

// ID の並びで、fromId を targetId の前（after なら後ろ）へ動かした新しい並び。動かせなければ（同じ位置・知らない ID）null
// the id list with fromId moved before targetId (after it when `after`); null when nothing would change (same place, unknown id)
export function moveId(ids: string[], fromId: string, targetId: string, after: boolean): string[] | null {
  if (fromId === targetId || !ids.includes(fromId) || !ids.includes(targetId)) return null;
  const rest = ids.filter((id) => id !== fromId);
  const at = rest.indexOf(targetId) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), fromId, ...rest.slice(at)];
  return next.every((id, i) => id === ids[i]) ? null : next;
}

// あるタスクの直下のサブタスク（渡された順）/ a task's direct subtasks (in the order given)
export function subtasksOf(all: Task[], parentPath: string): Task[] {
  return all.filter((t) => t.parent === parentPath);
}
