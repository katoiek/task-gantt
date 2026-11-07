// カンバンの振り分け：タスクをステータスごとの列に分ける。Obsidian に依存しない純粋な部分（画面は view.ts）
// the Kanban sorting: tasks into one column per status; the pure part (the screen is in view.ts)

import type { StatusDef, Task } from "./types";

export interface KanbanColumn {
  status: string | null; // null = 未割当（ステータスなし・設定にない ID）/ null = unassigned (no status, or an id the settings don't have)
  cards: Task[];
}

// タスクを列に分ける。先頭が未割当、続いてステータス（設定の順序そのまま）。タスクの並びは渡された順のまま。
// 親が表示中のサブタスクは、独立したカードにせず、親のカードの中に入る（親がフィルタで外れていれば、独立したカード）
// split tasks into columns: unassigned first, then the statuses in the settings' own order; the tasks keep the order given.
// A subtask whose parent is shown isn't a card of its own, it lives inside its parent's card (a filtered-out parent makes it a card)
export function buildKanbanColumns(tasks: Task[], statuses: StatusDef[]): KanbanColumn[] {
  const shown = new Set(tasks.map((t) => t.path));
  const ids = statuses.map((s) => s.id);
  const byStatus = new Map<string | null, Task[]>();
  for (const id of [null, ...ids]) byStatus.set(id, []);
  for (const t of tasks) {
    if (t.parent && shown.has(t.parent)) continue;
    byStatus.get(t.status && byStatus.has(t.status) ? t.status : null)!.push(t);
  }
  return [null, ...ids].map((status) => ({ status, cards: byStatus.get(status)! }));
}

// ステータス fromId を、targetId の前（after なら後ろ）へ動かした新しい並び。動かせなければ（同じ位置・知らない ID）null
// the statuses with fromId moved before targetId (after it when `after`); null when nothing would change (same place, unknown id)
export function moveStatus(statuses: StatusDef[], fromId: string, targetId: string, after: boolean): StatusDef[] | null {
  if (fromId === targetId) return null;
  const from = statuses.find((s) => s.id === fromId);
  if (!from || !statuses.some((s) => s.id === targetId)) return null;
  const rest = statuses.filter((s) => s.id !== fromId);
  const at = rest.findIndex((s) => s.id === targetId);
  const next = [...rest.slice(0, after ? at + 1 : at), from, ...rest.slice(after ? at + 1 : at)];
  return next.every((s, i) => s === statuses[i]) ? null : next;
}

// あるタスクの直下のサブタスク（渡された順）/ a task's direct subtasks (in the order given)
export function subtasksOf(all: Task[], parentPath: string): Task[] {
  return all.filter((t) => t.parent === parentPath);
}
