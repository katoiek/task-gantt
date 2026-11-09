// カンバンの振り分け：タスクをステータスごとの列に分ける。Obsidian に依存しない純粋な部分（画面は view.ts）
// the Kanban sorting: tasks into one column per status; the pure part (the screen is in view.ts)

import type { StatusDef, Task } from "./types";
import type { LaneBy } from "./views";

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

// 折りたたみのキー。ステータスの ID、未割当だけは決まった文字列（ステータスの ID と重ならないよう ~ で始める）
// the key of a collapsed column: the status id, and a fixed string for Unassigned (it starts with ~ so it can't clash with a status id)
export const UNASSIGNED_KEY = "~unassigned";
export function columnKey(status: string | null): string {
  return status ?? UNASSIGNED_KEY;
}

// 1 つの列の折りたたみを切り替えた新しい一覧 / the list with one column's collapse toggled
export function toggleCollapsed(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

// まとめて折りたたむ・開く。all＝今出ている列すべて、empty＝カードが 0 件の列を足す（今の折りたたみは保つ）、none＝すべて開く
// collapse or expand in bulk: all = every column shown, empty = add the columns with no cards (the current ones stay), none = expand everything
export function collapseColumns(cols: KanbanColumn[], current: string[], mode: "all" | "empty" | "none"): string[] {
  if (mode === "none") return [];
  const shown = cols.map((c) => columnKey(c.status));
  if (mode === "all") return shown;
  const empties = cols.filter((c) => c.cards.length === 0).map((c) => columnKey(c.status));
  return [...new Set([...current.filter((k) => shown.includes(k)), ...empties])];
}

// ── スイムレーン / swimlanes ──
// レーンのキー。担当者なし・フォルダ直下は決まった文字列（~ で始め、実在の名前と重ならないようにする）
// lane keys: a fixed string for "no assignee" and "top level of the folder" (starting with ~ so it can't clash with a real name)
export const ROOT_LANE_KEY = "~root";

export function laneKeyOf(t: Task, by: LaneBy): string {
  if (by === "assignee") return t.assignee?.trim() || UNASSIGNED_KEY;
  if (by === "folder") return t.groups.length ? t.groups.join("/") : ROOT_LANE_KEY;
  return "";
}

export interface KanbanLane {
  key: string;
  count: number; // このレーンのカードの数（親の中のサブタスクは数えない）/ cards in this lane (subtasks inside a parent aren't counted)
  columns: KanbanColumn[]; // 全レーン共通の列の並び。カードだけがレーンごとに違う / the same columns in every lane; only the cards differ
}

// 列に分けたカードを、レーンに分ける。レーンの並びは、決まったキー（担当者なし・直下）が先頭、あとは名前順。カードの並びは保つ
// split the columns' cards into lanes: the fixed keys (no assignee, top level) first, then by name; the cards keep their order
export function splitLanes(cols: KanbanColumn[], keyOf: (t: Task) => string): KanbanLane[] {
  const keys = new Set<string>();
  for (const c of cols) for (const t of c.cards) keys.add(keyOf(t));
  const fixed = (k: string): boolean => k === UNASSIGNED_KEY || k === ROOT_LANE_KEY;
  const sorted = [...keys].sort((a, b) => (fixed(a) !== fixed(b) ? (fixed(a) ? -1 : 1) : a.localeCompare(b)));
  return sorted.map((key) => {
    const columns = cols.map((c) => ({ status: c.status, cards: c.cards.filter((t) => keyOf(t) === key) }));
    return { key, count: columns.reduce((n, c) => n + c.cards.length, 0), columns };
  });
}
