// 中核データ型 / Core data types

// ステータス定義（設定でカスタマイズ可能）/ Status definition (customizable in settings)
export interface StatusDef {
  id: string; // フロントマター status 値と対応 / matches the `status` frontmatter value
  label: string;
  color: string; // バー色 / bar color (CSS color)
}

// 依存の種類（SF は未対応）/ dependency type (SF unsupported)
export type DepType = "FS" | "SS" | "FF";

// 依存（先行タスクへの参照＋種類）/ a dependency: predecessor path + type
export interface Dep {
  path: string; // 先行タスクのパス（解決済み）/ resolved predecessor path
  type: DepType;
}

// 1 ファイル = 1 タスク / one file = one task
export interface Task {
  path: string; // ファイルパス（一意キー）/ file path (unique key)
  name: string; // ファイル名（拡張子なし）/ basename without extension
  groups: string[]; // スコープから見たフォルダ階層 / folder chain relative to the scope
  start?: string; // YYYY-MM-DD
  end?: string; // YYYY-MM-DD
  status?: string; // StatusDef.id を参照
  assignee?: string;
  deps: Dep[]; // 先行タスクへの依存（解決済み）/ resolved dependencies on predecessors
  progress?: number; // 0-100
  milestone: boolean;
}

// グループ（フォルダ）見出し or タスク、を一列に並べた表示行 / a display row
export interface Row {
  kind: "group" | "task";
  group: string; // グループ行＝フォルダ名 / folder name for group rows
  depth: number; // 入れ子の深さ（インデント用）/ nesting depth for indentation
  key?: string; // グループ行の一意キー（折りたたみ用）/ unique folder key for collapse state
  task?: Task;
  // グループ行のまとめバー範囲（配下タスクの集約）/ rolled-up span for a group row
  span?: { start: string; end: string };
}

// 専用ビューに渡す状態 / state passed to the dedicated view
export interface GanttViewState {
  folder: string; // 表示対象フォルダのパス / scoped folder path ("" = vault root)
}

export const VIEW_TYPE_GANTT = "task-gantt-view";
// Fit = ペイン幅に収まるよう自動スケール / Fit = auto-scale to the pane width
export type ZoomMode = "Day" | "Week" | "Month" | "Fit";
