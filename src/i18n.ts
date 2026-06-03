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
  // 取り消し / undo
  nothingToUndo: string;
  undone: (label: string) => string;
  undoReschedule: (name: string) => string;
  undoAddDep: (type: string) => string;
  undoRemoveDep: (type: string) => string;
  // 依存 / dependencies
  sfUnsupported: string;
  depTooltip: (type: string) => string;
  // 空表示 / empty state
  emptyMessage: (folder: string) => string;
  // 詳細パネル / detail panel
  openAsNote: string;
  fieldStart: string;
  fieldEnd: string;
  fieldDue: string;
  fieldStatus: string;
  fieldAssignee: string;
  fieldBody: string;
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
  setStatusesHeading: string;
  setDeleteTooltip: string;
  setAddStatus: string;
  setKeysHeading: string;
}

const STRINGS: Record<Lang, Strings> = {
  ja: {
    colTask: "作業",
    colStart: "開始",
    colDue: "期限",
    undoAria: "取り消し (Ctrl+Z)",
    reloadAria: "再読み込み",
    nothingToUndo: "取り消す操作がありません",
    undone: (label) => `取り消しました: ${label}`,
    undoReschedule: (name) => `「${name}」の日程変更`,
    undoAddDep: (type) => `依存の作成 (${type})`,
    undoRemoveDep: (type) => `依存の切断 (${type})`,
    sfUnsupported: "SF（開始→終了）は未対応です。",
    depTooltip: (type) => `${type} 依存 — クリックで切断`,
    emptyMessage: (folder) => `「${folder}」配下にタスク（.md）が見つかりません。`,
    openAsNote: "ノートで開く",
    fieldStart: "開始",
    fieldEnd: "終了",
    fieldDue: "期限",
    fieldStatus: "状態",
    fieldAssignee: "担当",
    fieldBody: "本文",
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
    setStatusesHeading: "ステータス",
    setDeleteTooltip: "削除",
    setAddStatus: "ステータスを追加",
    setKeysHeading: "フロントマターのキー名",
  },
  en: {
    colTask: "Task",
    colStart: "Start",
    colDue: "Due",
    undoAria: "Undo (Ctrl+Z)",
    reloadAria: "Reload",
    nothingToUndo: "Nothing to undo",
    undone: (label) => `Undone: ${label}`,
    undoReschedule: (name) => `Reschedule "${name}"`,
    undoAddDep: (type) => `Add dependency (${type})`,
    undoRemoveDep: (type) => `Remove dependency (${type})`,
    sfUnsupported: "SF (start-to-finish) dependency is not supported.",
    depTooltip: (type) => `${type} dependency — click to remove`,
    emptyMessage: (folder) => `No tasks (.md) found under "${folder}".`,
    openAsNote: "Open as note",
    fieldStart: "Start",
    fieldEnd: "End",
    fieldDue: "Due",
    fieldStatus: "Status",
    fieldAssignee: "Assignee",
    fieldBody: "Body",
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
    setStatusesHeading: "Statuses",
    setDeleteTooltip: "Delete",
    setAddStatus: "Add status",
    setKeysHeading: "Frontmatter keys",
  },
};

// 現在言語の文言を返す / strings for the current language
export function t(): Strings {
  return STRINGS[lang];
}
