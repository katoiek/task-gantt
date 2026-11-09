// ビュー：ボード（フォルダ）ごとに複数の見え方（グループ・フィルタ・列・並べ替え・表示切替など）を持つ
// views: a board (folder) keeps several looks (grouping, filters, columns, sort, display toggles and more)
// ここは Obsidian に依存しない純粋な部分（作成・複製・改名・削除・並び順）。画面は view.ts
// this part is pure (create, duplicate, rename, delete, order); the screen is in view.ts

import type { Filter, FilterMatch, ZoomMode } from "./types";

// ビューの種類：ガントとカンバン / view types: Gantt and Kanban
export type ViewType = "gantt" | "kanban";

// 1 つのビューが持つ設定。画面はこのオブジェクトを直接読み書きする（コピーしない）
// what one view holds; the screen reads and writes this object directly (no copy)
export interface ViewConfig {
  groupBy: "folder" | "status" | "assignee" | "tag";
  colorBy: "status" | "assignee";
  flat: boolean;
  rollup: boolean;
  showEmptyFolders: boolean;
  progressLine: boolean;
  hideLabels: boolean;
  markOverdue: boolean;
  filters: Filter[];
  filterMatch: FilterMatch;
  visibleColumns: string[];
  columnWidths: Record<string, number>;
  sortBy: string;
  sortDir: "asc" | "desc";
  zoom: ZoomMode;
  collapsed: string[]; // 折りたたんだグループのキー / keys of the collapsed groups
  // カンバン用（ガントでは使わない）/ for Kanban (unused by Gantt)
  cardFields: string[]; // カードに出す列の id（担当・開始・期限が既定）/ ids of the columns shown on a card (assignee, start, due by default)
  manualOrder: boolean; // カードの並びに手動の順序を使う（false ならビューの並べ替え）/ order the cards by hand (false = the view's sort)
  cardOrder: Record<string, string[]>; // 列のキー → カード（ノートのパス）の手動の順序 / column key → the cards' manual order (note paths)
  laneBy: LaneBy; // スイムレーンの分け方（none = レーンなし）/ what the swimlanes split by (none = no lanes)
  collapsedLanes: string[]; // 折りたたんだレーンのキー（"<分け方>:<値>"）/ keys of the collapsed lanes ("<by>:<value>")
  collapsedColumns: string[]; // 折りたたんだ列のキー（ステータスの ID。未割当は UNASSIGNED_KEY）/ keys of the collapsed columns (a status id; UNASSIGNED_KEY for Unassigned)
  columnOrder: string[]; // 列（ステータス）の並び。空なら設定のステータスの順＝初期値 / the order of the columns (statuses); empty follows the settings' status order, the default
}

export type LaneBy = "none" | "assignee" | "folder";

export interface BoardView {
  id: string;
  name: string;
  type: ViewType;
  config: ViewConfig;
}

// 1 つのボードのビュー一覧と、開いているビュー / one board's views and the open one
export interface BoardViews {
  active: string;
  views: BoardView[];
}

// 設定をそのまま複製する（ビューどうしで配列やオブジェクトを共有しない）/ a deep copy (views never share arrays or objects)
export function cloneConfig(c: ViewConfig): ViewConfig {
  return JSON.parse(JSON.stringify(c)) as ViewConfig;
}

// ボードの鍵。フォルダのパス（先頭・末尾の / は無視）/ a board's key: its folder path, ignoring leading and trailing slashes
export function boardKey(folder: string): string {
  return "folder:" + folder.replace(/^\/+|\/+$/g, "");
}

function nextId(bv: BoardViews): string {
  const used = new Set(bv.views.map((v) => v.id));
  let n = bv.views.length + 1;
  while (used.has(`v${n}`)) n++;
  return `v${n}`;
}

// 同じ名前があれば「名前 2」「名前 3」… にする / de-duplicate a name with a counter ("Name 2", "Name 3" …)
export function uniqueName(bv: BoardViews, base: string): string {
  const names = new Set(bv.views.map((v) => v.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// 最初のビューを持つ一覧を作る / a list holding one first view
export function createBoardViews(name: string, config: ViewConfig, type: ViewType = "gantt"): BoardViews {
  return { active: "v1", views: [{ id: "v1", name, type, config }] };
}

// ビューを末尾に足して、そのビューを返す（開くのは呼び出し側）/ append a view and return it (the caller opens it)
export function addView(bv: BoardViews, name: string, config: ViewConfig, type: ViewType = "gantt"): BoardView {
  const view: BoardView = { id: nextId(bv), name: uniqueName(bv, name.trim() || "View"), type, config };
  bv.views.push(view);
  return view;
}

// 元のビューの設定をそっくり複製して、その右隣に足す / copy a view's whole config and insert the copy right after it
export function duplicateView(bv: BoardViews, id: string, copyName: (name: string) => string): BoardView | null {
  const i = bv.views.findIndex((v) => v.id === id);
  if (i < 0) return null;
  const src = bv.views[i];
  const view: BoardView = { id: nextId(bv), name: uniqueName(bv, copyName(src.name)), type: src.type, config: cloneConfig(src.config) };
  bv.views.splice(i + 1, 0, view);
  return view;
}

// 名前を変える（空・空白だけの名前は拒否）。同じ名前があれば連番 / rename (an empty name is refused); a taken name gets a counter
export function renameView(bv: BoardViews, id: string, name: string): boolean {
  const v = bv.views.find((x) => x.id === id);
  const trimmed = name.trim();
  if (!v || !trimmed || trimmed === v.name) return false;
  const others = { ...bv, views: bv.views.filter((x) => x.id !== id) };
  v.name = uniqueName(others, trimmed);
  return true;
}

// 削除する。最後の 1 つは残す。開いていたビューを消したら、左隣（なければ右隣）を開く
// delete one; the last view stays. Deleting the open one opens its left neighbour (or the right one)
export function deleteView(bv: BoardViews, id: string): boolean {
  if (bv.views.length <= 1) return false;
  const i = bv.views.findIndex((v) => v.id === id);
  if (i < 0) return false;
  bv.views.splice(i, 1);
  if (bv.active === id) bv.active = bv.views[Math.max(0, i - 1)].id;
  return true;
}

// 開いているビュー（無ければ先頭）/ the open view (the first when the saved one is gone)
export function activeView(bv: BoardViews): BoardView {
  return bv.views.find((v) => v.id === bv.active) ?? bv.views[0];
}

// フォルダの名前変更・移動に、ビューの鍵を追従させる（配下のフォルダの鍵も）/ follow a folder rename or move with the keys (sub-folders' keys too)
export function moveBoardKeys(map: Record<string, BoardViews>, oldPath: string, newPath: string): boolean {
  const from = boardKey(oldPath);
  const to = boardKey(newPath);
  let moved = false;
  for (const key of Object.keys(map)) {
    if (key !== from && !key.startsWith(from + "/")) continue;
    const next = to + key.slice(from.length);
    if (next === key || map[next]) continue; // 行き先に既にあれば上書きしない / never overwrite an existing entry
    map[next] = map[key];
    delete map[key];
    moved = true;
  }
  return moved;
}

// 保存データを読み込んだあとの手当て：壊れたボード（ビューが無い等）は捨て、足りない設定は base で補い、開いているビューが無ければ先頭にする。配列やオブジェクトは複製して返す
// repair loaded data: drop a broken board (no views, say), fill missing settings from `base`, fall back to the first view when the open one is gone; arrays and objects are cloned
export function repairBoardViews(raw: unknown, base: ViewConfig): Record<string, BoardViews> {
  const out: Record<string, BoardViews> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const bv = value as Partial<BoardViews> | null;
    if (!bv || !Array.isArray(bv.views)) continue;
    const views: BoardView[] = [];
    for (const v of bv.views as Partial<BoardView>[]) {
      if (!v || typeof v.id !== "string" || typeof v.name !== "string") continue;
      const config = cloneConfig({ ...base, ...(v.config ?? {}) });
      if (config.laneBy !== "assignee" && config.laneBy !== "folder") config.laneBy = "none";
      if (!Array.isArray(config.collapsedLanes)) config.collapsedLanes = [];
      config.manualOrder = config.manualOrder === true;
      if (!config.cardOrder || typeof config.cardOrder !== "object" || Array.isArray(config.cardOrder)) config.cardOrder = {};
      for (const k of Object.keys(config.cardOrder)) if (!Array.isArray(config.cardOrder[k])) delete config.cardOrder[k];
      views.push({ id: v.id, name: v.name, type: v.type === "kanban" ? "kanban" : "gantt", config });
    }
    if (!views.length) continue;
    out[key] = { active: views.some((v) => v.id === bv.active) ? (bv.active as string) : views[0].id, views };
  }
  return out;
}

// 全ビューの設定に同じ変更を加える（カスタムフィールドの列の追加・削除など、設定画面から）/ apply one change to every view's config (e.g. a custom field's column added or removed from the settings)
export function eachConfig(map: Record<string, BoardViews>, fn: (c: ViewConfig) => void): void {
  for (const bv of Object.values(map)) for (const v of bv.views) fn(v.config);
}

// ノートの名前変更・移動に、手動の順序のパスを追従させる（フォルダなら配下も）。変えたら true
// make the manual orders' paths follow a note's rename or move (and everything under a renamed folder); true when something changed
export function renameOrderPaths(map: Record<string, BoardViews>, oldPath: string, newPath: string): boolean {
  let changed = false;
  const prefix = oldPath + "/";
  eachConfig(map, (c) => {
    for (const [key, list] of Object.entries(c.cardOrder ?? {})) {
      const next = list.map((p) => (p === oldPath ? newPath : p.startsWith(prefix) ? newPath + "/" + p.slice(prefix.length) : p));
      if (next.some((p, i) => p !== list[i])) {
        c.cardOrder[key] = next;
        changed = true;
      }
    }
  });
  return changed;
}
