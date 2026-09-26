// ビューと部品（列定義など）の間で共有する型 / types shared between the view and its parts (column defs, etc.)
import type { App } from "obsidian";
import type { GanttSettings } from "./settings";
import type { Task } from "./types";

// ファイルの移動・リネーム / a file move or rename
export type Move = { from: string; to: string };

// mutate の fn の戻り値。false＝変化なし（記録しない）、true / void＝変化あり
// what mutate's fn returns: false = nothing changed (not recorded); true / void = changed
export type MutateResult = { moves?: Move[]; created?: string[]; deleted?: string[] } | boolean | void;

// 部品が GanttView 全体に触れずに使える窓口。ビューが実装する
// the narrow surface parts use instead of the whole GanttView; the view implements it
export interface BoardContext {
  readonly app: App;
  readonly settings: GanttSettings;
  readonly tasks: Task[]; // 表示中のボードの全タスク（背景 refresh で作り替わる）/ the board's tasks (rebuilt by background refreshes)
  readonly rollup: boolean; // 親を子孫の範囲で描くか / whether parents are drawn as the span of their descendants
  // 書き込みはすべてここを通す（取り消し可能になる）/ every write goes through here (makes it undoable)
  mutate(label: string, paths: string[], fn: () => Promise<MutateResult>): Promise<boolean>;
  refresh(): Promise<void>; // ディスクから読み直して再描画 / reload from disk and re-render
  rerender(): void; // メモリ上のタスクから再描画 / re-render from in-memory tasks

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
  // anchor の直下にポップオーバーを開く / open a popover under the anchor
  openPopover(anchor: HTMLElement, cls: string, build: (menu: HTMLElement, close: () => void) => void): void;
  // 範囲カレンダー / the range calendar
  openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>,
    single?: string // 単一日付モード（見出しに出す名前）/ single-date mode (the field name shown)
  ): void;
  // 入力欄に datalist の候補を付ける / attach datalist suggestions to an input
  attachSuggestions(inp: HTMLInputElement, fill: (list: HTMLDataListElement) => void): HTMLDataListElement;
  // Vault のタグを候補に出す / suggest the vault's tags
  attachSingleTagSuggestions(inp: HTMLInputElement, exclude?: string[]): void;
  // タグチップに色を塗る / colour a tag chip
  paintTagChip(chip: HTMLElement, tag: string): void;
  // タグ・フォルダの色メニュー / the tag / folder colour menu
  openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void;
}
