// 表示言語の判定と文言テーブル / display-language detection + string table
// Obsidian の表示言語が日本語のときだけ日本語、それ以外は英語を出す
// Show Japanese only when Obsidian's UI language is Japanese; English otherwise.

import { moment } from "obsidian";

type Lang = "ja" | "en";

// Obsidian は表示言語に合わせて moment のロケールを設定する（日本語は "ja"）
// Obsidian sets moment's locale to match the UI language ("ja" for Japanese)
function detectLang(): Lang {
  try {
    return moment.locale().startsWith("ja") ? "ja" : "en";
  } catch {
    return "en";
  }
}

// モジュール読込時に一度だけ判定（言語変更の反映は再読み込み時）/ resolved once at load
export const lang: Lang = detectLang();

// UI 文言（パラメータ付きは関数）/ UI strings (functions where parameterized)
interface Strings {
  // 列見出し / column headers
  colTask: string;
  colStart: string;
  colDue: string;
  // ツールバー / toolbar
  undoAria: string;
  reloadAria: string;
  newTaskAria: string;
  today: string;
  // 表示オプション / view options
  optGroupLabel: string;
  optGroupFolder: string;
  optColorLabel: string;
  optShowEmpty: string;
  optColumns: string;
  optFlat: string;
  filterAll: string;
  noneLabel: string;
  // 取り消し / undo
  nothingToUndo: string;
  undone: (label: string) => string;
  undoReschedule: (name: string) => string;
  undoMove: (name: string) => string;
  undoAddDep: (type: string) => string;
  undoRemoveDep: (type: string) => string;
  // 依存 / dependencies
  sfUnsupported: string;
  depTooltip: (type: string) => string;
  // 日付入力 / date entry
  invalidDate: string;
  pickDate: string;
  fieldDates: string;
  clearDate: string;
  // 空表示 / empty state
  emptyMessage: (folder: string) => string;
  // 詳細パネル / detail panel
  openAsNote: string;
  fieldStart: string;
  fieldDue: string;
  fieldStatus: string;
  fieldAssignee: string;
  fieldProgress: string;
  fieldBody: string;
  // 新規タスク / new task
  newTaskName: string;
  // コマンド・メニュー / commands & menus
  ribbonOpen: string;
  commandOpen: string;
  menuOpen: string;
  // 設定 / settings
  setDefaultFolderName: string;
  setDefaultFolderDesc: string;
  setDefaultFolderPlaceholder: string;
  setRecurseName: string;
  setRecurseDesc: string;
  setDefaultZoomName: string;
  setDateFormatName: string;
  setStatusesHeading: string;
  setDeleteTooltip: string;
  setAddStatus: string;
  setStatusId: string;
  setStatusLabel: string;
  setStatusColor: string;
  setKeysHeading: string;
}

const STRINGS: Record<Lang, Strings> = {
  ja: {
    colTask: "作業",
    colStart: "開始",
    colDue: "期限",
    undoAria: "取り消し (Ctrl+Z)",
    reloadAria: "再読み込み",
    newTaskAria: "タスクを追加",
    today: "今日",
    optGroupLabel: "グループ",
    optGroupFolder: "フォルダ",
    optColorLabel: "色分け",
    optShowEmpty: "空フォルダを表示",
    optColumns: "列の表示",
    optFlat: "フラット表示",
    filterAll: "すべて",
    noneLabel: "（なし）",
    nothingToUndo: "取り消す操作がありません",
    undone: (label) => `取り消しました: ${label}`,
    undoReschedule: (name) => `「${name}」の日程変更`,
    undoMove: (name) => `「${name}」の移動`,
    undoAddDep: (type) => `依存の作成 (${type})`,
    undoRemoveDep: (type) => `依存の切断 (${type})`,
    sfUnsupported: "SF（開始→終了）は未対応です。",
    invalidDate: "日付の形式が正しくありません。",
    pickDate: "日付を選択",
    fieldDates: "日付",
    clearDate: "クリア",
    depTooltip: (type) => `${type} 依存 — クリックで切断`,
    emptyMessage: (folder) => `「${folder}」配下にタスク（.md）が見つかりません。`,
    openAsNote: "ノートで開く",
    fieldStart: "開始日",
    fieldDue: "期限",
    fieldStatus: "ステータス",
    fieldAssignee: "担当者",
    fieldProgress: "進捗",
    fieldBody: "本文",
    newTaskName: "新規タスク",
    ribbonOpen: "Gantt を開く",
    commandOpen: "Gantt を開く（現在のフォルダ）",
    menuOpen: "Gantt で開く",
    setDefaultFolderName: "既定フォルダ",
    setDefaultFolderDesc:
      "リボンでフォルダ未選択のときに使う既定フォルダ。通常はフォルダを右クリック→「Gantt で開く」、またはフォルダ選択中にリボンを押します。",
    setDefaultFolderPlaceholder: "例: Projects/お掃除",
    setRecurseName: "サブフォルダを再帰",
    setRecurseDesc: "直下のサブフォルダをグループ、その中のファイルをタスクにします。",
    setDefaultZoomName: "既定のズーム",
    setDateFormatName: "日付フォーマット",
    setStatusesHeading: "ステータス",
    setDeleteTooltip: "削除",
    setAddStatus: "ステータスを追加",
    setStatusId: "ID",
    setStatusLabel: "ラベル",
    setStatusColor: "色",
    setKeysHeading: "フロントマターのキー名",
  },
  en: {
    colTask: "Task",
    colStart: "Start",
    colDue: "Due",
    undoAria: "Undo (Ctrl+Z)",
    reloadAria: "Reload",
    newTaskAria: "Add task",
    today: "Today",
    optGroupLabel: "Group",
    optGroupFolder: "Folder",
    optColorLabel: "Color",
    optShowEmpty: "Show empty folders",
    optColumns: "Columns",
    optFlat: "Flat",
    filterAll: "All",
    noneLabel: "(none)",
    nothingToUndo: "Nothing to undo",
    undone: (label) => `Undone: ${label}`,
    undoReschedule: (name) => `Reschedule "${name}"`,
    undoMove: (name) => `Move "${name}"`,
    undoAddDep: (type) => `Add dependency (${type})`,
    undoRemoveDep: (type) => `Remove dependency (${type})`,
    sfUnsupported: "SF (start-to-finish) dependency is not supported.",
    invalidDate: "Invalid date format.",
    pickDate: "Pick a date",
    fieldDates: "Dates",
    clearDate: "Clear",
    depTooltip: (type) => `${type} dependency — click to remove`,
    emptyMessage: (folder) => `No tasks (.md) found under "${folder}".`,
    openAsNote: "Open as note",
    fieldStart: "Start",
    fieldDue: "Due",
    fieldStatus: "Status",
    fieldAssignee: "Assignee",
    fieldProgress: "Progress",
    fieldBody: "Body",
    newTaskName: "New task",
    ribbonOpen: "Open Gantt",
    commandOpen: "Open Gantt for the current folder",
    menuOpen: "Open as Gantt",
    setDefaultFolderName: "Default folder",
    setDefaultFolderDesc:
      "Fallback folder used when no folder is selected. Usually you right-click a folder → Open as Gantt, or select a folder and click the ribbon.",
    setDefaultFolderPlaceholder: "e.g. Projects/Cleanup",
    setRecurseName: "Recurse subfolders",
    setRecurseDesc: "Subfolders become groups and the files inside them become tasks.",
    setDefaultZoomName: "Default zoom",
    setDateFormatName: "Date format",
    setStatusesHeading: "Statuses",
    setDeleteTooltip: "Delete",
    setAddStatus: "Add status",
    setStatusId: "ID",
    setStatusLabel: "Label",
    setStatusColor: "Color",
    setKeysHeading: "Frontmatter keys",
  },
};

// 現在言語の文言を返す / strings for the current language
export function t(): Strings {
  return STRINGS[lang];
}
