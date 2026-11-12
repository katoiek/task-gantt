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

// ── 手動の並び順 / manual order ──
// 手動の順序（パスの一覧）に入っているカードを、その順で先に。入っていないカードは、渡された順のまま後ろに
// the cards in the manual order (a list of paths) first, in that order; cards not in it keep the order given and follow
export function applyManualOrder(cards: Task[], order: string[]): Task[] {
  const byPath = new Map(cards.map((t) => [t.path, t]));
  const listed: Task[] = [];
  for (const p of order) {
    const t = byPath.get(p);
    if (t && !listed.includes(t)) listed.push(t);
  }
  return [...listed, ...cards.filter((t) => !listed.includes(t))];
}

// カードを refPath の前（after なら後ろ）に入れた、新しい手動の順序。shown は今その列に出ているカードの順（表示の順がそのまま土台）。
// ref が無ければ末尾。今は出ていない（フィルタで外れた）カードのパスは、末尾に残す。動かすカード自身は、元の位置から外す
// the new manual order with `path` placed before refPath (after it when `after`). `shown` is the column's cards as displayed (the base).
// No ref = the end. Paths not shown now (filtered out) stay at the tail; the moved card is lifted out of its old place
export function placeInOrder(order: string[], shown: string[], path: string, refPath: string | null, after: boolean): string[] {
  const list = shown.filter((p) => p !== path);
  const at = refPath ? list.indexOf(refPath) : -1;
  if (at < 0) list.push(path);
  else list.splice(at + (after ? 1 : 0), 0, path);
  const hidden = order.filter((p) => p !== path && !shown.includes(p));
  return [...list, ...hidden];
}

// ── カードへのドロップ位置 / where on a card a drop lands ──
// カードの上 30% は「前に入れる」、下 30% は「後ろに入れる」、真ん中は「そのカードのサブタスクにする」
// the top 30% of a card means "place before it", the bottom 30% "place after it", the middle "make it that card's subtask"
export type CardZone = "before" | "child" | "after";
export function cardZone(y: number, top: number, height: number): CardZone {
  const r = height > 0 ? (y - top) / height : 0.5;
  return r < 0.3 ? "before" : r > 0.7 ? "after" : "child";
}

// 行の手動の順序で比べる関数。順序（パスの一覧）に入っているタスクが先で、その並び順。入っていないタスクは、そのあとで、base の比べ方のまま
// a comparator for the manual row order: tasks in the order list come first, in that order; tasks not in it follow, compared by `base`
export function manualRowCompare(order: string[], base: (a: Task, b: Task) => number): (a: Task, b: Task) => number {
  const rank = new Map(order.map((p, i) => [p, i]));
  return (a, b) => {
    const ra = rank.get(a.path);
    const rb = rank.get(b.path);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return base(a, b);
  };
}
