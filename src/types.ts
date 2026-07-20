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
  // 時刻（任意）。frontmatter が "YYYY-MM-DDTHH:mm" のとき設定される。レイアウトは日単位のまま
  // optional time of day, set when frontmatter is "YYYY-MM-DDTHH:mm"; layout stays day-based
  startTime?: string; // HH:mm
  endTime?: string; // HH:mm
  status?: string; // StatusDef.id を参照
  assignee?: string;
  deps: Dep[]; // 先行タスクへの依存（解決済み）/ resolved dependencies on predecessors
  progress?: number; // 0-100
  milestone: boolean;
  parent?: string; // 親タスクのパス（解決済み）/ resolved parent task path
  tags: string[]; // タグ（# 抜き・本文/フロントマター両方を統合）/ tags (without #, frontmatter + inline)
}

// ── 日付フィルタ（Wrike 風の 開始日/期限日 絞り込み）/ date filter (Wrike-style start/due filtering) ──
// 対象フィールド（開始日 / 期限日）/ target field (start date / due date)
export type DateField = "start" | "end";
// 演算子（画像7の7種）/ operators (the 7 shown in the Wrike UI)
export type DateOp =
  | "is" // 一致 / equals
  | "before" // より前 / strictly before
  | "after" // より後 / strictly after
  | "onOrBefore" // 以前 / on or before
  | "onOrAfter" // 以後 / on or after
  | "empty" // 未設定 / no date
  | "notEmpty"; // 設定あり / has a date
// 相対日の単位・方向 / relative-date unit & direction
export type DateUnit = "day" | "week" | "month";
export type DateDir = "ago" | "fromNow";
// 値（演算子により選べる種類が変わる）/ the value (which kinds are allowed depends on the operator)
export type DateValue =
  | { kind: "preset"; preset: "yesterday" | "today" | "tomorrow" } // クイック / quick presets
  | { kind: "specific"; date: string } // 具体日（ISO YYYY-MM-DD）/ a fixed calendar date
  | { kind: "relative"; amount: number; unit: DateUnit; dir: DateDir } // 相対日（今日基準・毎回再計算）/ relative to today, recomputed each render
  | { kind: "range"; from: string; to: string }; // 期間（op="is" のみ・ISO 両端）/ a date range (op "is" only)
// 日付フィルタ 1 件 / one date filter (start/due)
export interface DateFilterItem {
  kind: "date";
  field: DateField;
  op: DateOp;
  value?: DateValue; // empty/notEmpty では未使用 / unused for empty/notEmpty
}

// ── カテゴリ系フィルタ（ステータス/担当者/タグ）/ category filter (status/assignee/tag) ──
export type CategoryField = "status" | "assignee" | "tag";
// と一致 / 以外 / 未設定 / 設定あり / is / is not / is empty / is not empty
export type CategoryOp = "is" | "isNot" | "empty" | "notEmpty";
export interface CategoryFilter {
  kind: "category";
  field: CategoryField;
  op: CategoryOp;
  values: string[]; // is/isNot の対象値（フィールド内は OR）。ステータスは id を格納 / selected values (OR within field); status stores ids
}

// ── テキスト系フィルタ（タスク名）/ text filter (task name) ──
export type TextField = "name";
// と一致 / 以外 / を含む / を含まない / で始まる / で終わる
export type TextOp = "is" | "isNot" | "contains" | "notContains" | "startsWith" | "endsWith";
export interface TextFilter {
  kind: "text";
  field: TextField;
  op: TextOp;
  value: string; // 空文字は素通し（絞り込まない）/ empty string = no effect
}

// 統合フィルタ（カテゴリ or 日付 or テキスト）と結合方法 / a unified filter + how multiple filters combine
export type Filter = CategoryFilter | DateFilterItem | TextFilter;
export type FilterMatch = "all" | "any"; // all=AND / any=OR

// フィルタ構成のプリセット（filters＋一致条件をひとまとめに）/ a saved filter configuration
export interface FilterPreset {
  name: string;
  filters: Filter[];
  filterMatch: FilterMatch;
}

// グループ（フォルダ）見出し or タスク、を一列に並べた表示行 / a display row
export interface Row {
  kind: "group" | "task";
  group: string; // グループ行＝フォルダ名 / folder name for group rows
  depth: number; // 入れ子の深さ（インデント用）/ nesting depth for indentation
  key?: string; // グループ行の一意キー（折りたたみ用）/ unique folder key for collapse state
  task?: Task;
  // グループ行/親タスク行のまとめバー範囲（配下の集約）/ rolled-up span for a group or parent-task row
  span?: { start: string; end: string };
  hasChildren?: boolean; // 親タスク行（子サブタスクを持つ）/ a parent task row (has subtasks)
}

// 専用ビューに渡す状態 / state passed to the dedicated view
export interface GanttViewState {
  folder: string; // 表示対象フォルダのパス / scoped folder path ("" = vault root)
}

export const VIEW_TYPE_GANTT = "task-gantt-view";
// Fit = ペイン幅に収まるよう自動スケール / Fit = auto-scale to the pane width
export type ZoomMode = "Day" | "Week" | "Month" | "Fit";

// 表示用の日付フォーマット（保存値は常に ISO YYYY-MM-DD）/ display-only date format (stored value stays ISO)
export type DateFormat = "YYYY/MM/DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
