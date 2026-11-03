// ビューと部品（列定義など）の間で共有する型 / types shared between the view and its parts (column defs, etc.)
import type { App } from "obsidian";
import type { GanttSettings } from "./settings";
import type { GroupBy } from "./filter";

// ファイルの移動・リネーム / a file move or rename
export type Move = { from: string; to: string };

// mutate の fn の戻り値。false＝変化なし（記録しない）、true / void＝変化あり
// what mutate's fn returns: false = nothing changed (not recorded); true / void = changed
// ステータスの欄だけの変更（自動ステータス。取り消しはこの欄だけを戻す）/ a change to the status field alone (automatic status; undo puts back only this field)
export type StatusChange = { path: string; from?: string; to: string };

// statuses を返した操作はファイル全体ではなくステータスの欄だけを取り消す / an op that returns `statuses` is undone field by field, not as whole files
export type MutateResult = { moves?: Move[]; created?: string[]; deleted?: string[]; statuses?: StatusChange[] } | boolean | void;

// 部品が GanttView 全体に触れずに使える窓口。ビューが実装する
// the narrow surface parts use instead of the whole GanttView; the view implements it
export interface BoardContext {
  readonly app: App;
  readonly settings: GanttSettings;
  readonly rollup: boolean; // 親を子孫の範囲で描くか / whether parents are drawn as the span of their descendants
  readonly groupBy: GroupBy; // グループ化の軸（見出しと同じ値は行で繰り返さない）/ the grouping axis (rows don't repeat their heading's value)
  // 書き込みはすべてここを通す（取り消し可能になる）/ every write goes through here (makes it undoable)
  mutate(label: string, paths: string[], fn: () => Promise<MutateResult>): Promise<boolean>;
  // 開始・期限を書き、後続タスクへ連動する（取り消し可）。開始日だけの変更は期間を保って期限日も動かす。
  // 戻り値は実際に書いた期限日 / write start & due and cascade to successors (undoable); a start-only change keeps
  // the duration by moving the due date too. Returns the due date actually written
  reschedule(path: string, next: { start: string; end: string }, times?: { start?: string; end?: string }): Promise<string>;
  refresh(): Promise<void>; // ディスクから読み直して再描画 / reload from disk and re-render

  // ----- セル編集の UI 部品 / UI helpers for in-cell editing -----
  // セルを入力欄に差し替える（Enter/blur で保存、Esc で取消、同値なら書かない）
  // swap a cell for an input (Enter/blur saves, Esc cancels, an unchanged value is never written)
  inlineInput(
    cell: HTMLElement,
    value: string,
    repaint: () => void,
    commit: (v: string) => Promise<void>,
    configure?: (inp: HTMLInputElement) => void
  ): void;
  // 範囲カレンダー / the range calendar
  openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>,
    single?: string // 単一日付モード（見出しに出す名前）/ single-date mode (the field name shown)
  ): void;
  // タグ・担当者（多値）のチップと追加欄。値が変わったら changed を呼び、追加欄を返す
  // chips + an add field for tags or assignees (multi-valued); calls `changed` after an edit and returns the field
  chipList(host: HTMLElement, path: string, field: "tags" | "assignees", changed: () => void): HTMLInputElement;
  // タグチップに色を塗る / colour a tag chip
  paintTagChip(chip: HTMLElement, tag: string): void;
  // タグの右クリックメニュー（色）/ a tag's right-click menu (colour)
  openTagMenu(e: MouseEvent, tag: string): void;
  // 担当者のアバター（頭文字の丸）/ an assignee avatar (initials in a circle)
  avatar(parent: HTMLElement, who: string): void;
}
