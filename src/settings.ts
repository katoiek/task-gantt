import { App, PluginSettingTab, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, ZoomMode, DateFormat } from "./types";
import { t as tr } from "./i18n";

// プラグイン設定 / Plugin settings
export interface GanttSettings {
  rootFolder: string; // 集計する親フォルダ / parent folder to aggregate
  recurse: boolean; // サブフォルダを再帰的に辿るか / recurse into subfolders
  statuses: StatusDef[];
  defaultZoom: ZoomMode;
  dateFormat: DateFormat; // 表示用の日付フォーマット / display-only date format
  detailWidth: number; // 詳細パネルの幅(px) / detail panel width (px)
  visibleColumns: string[]; // 表示する任意列（name は常時表示）/ optional columns shown (name is always shown)
  sortBy: string; // ソート列 id（name/start/end/assignee/status）/ sort column id
  sortDir: "asc" | "desc"; // ソート方向 / sort direction
  // フロントマターのキー名（プロジェクトに合わせて変更可）/ frontmatter key names
  keys: {
    start: string;
    end: string;
    status: string;
    assignee: string;
    after: string;
    progress: string;
    milestone: string;
  };
}

export const DEFAULT_SETTINGS: GanttSettings = {
  rootFolder: "",
  recurse: true,
  statuses: [
    { id: "todo", label: "To do", color: "#9aa0a6" },
    { id: "in-progress", label: "In progress", color: "#3b82f6" },
    { id: "blocked", label: "Blocked", color: "#ef4444" },
    { id: "done", label: "Done", color: "#22c55e" },
  ],
  defaultZoom: "Week",
  dateFormat: "YYYY/MM/DD",
  detailWidth: 380,
  visibleColumns: ["start", "end"],
  sortBy: "start",
  sortDir: "asc",
  keys: {
    start: "start",
    end: "end",
    status: "status",
    assignee: "assignee",
    after: "after",
    progress: "progress",
    milestone: "milestone",
  },
};

export class GanttSettingTab extends PluginSettingTab {
  plugin: GanttPlugin;

  constructor(app: App, plugin: GanttPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 宣言的な設定定義（1.13.0+ の getSettingDefinitions API）/ declarative settings (getSettingDefinitions API, 1.13.0+)
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: tr().setDefaultFolderName,
        desc: tr().setDefaultFolderDesc,
        control: { type: "text", key: "rootFolder", placeholder: tr().setDefaultFolderPlaceholder },
      },
      {
        name: tr().setRecurseName,
        desc: tr().setRecurseDesc,
        control: { type: "toggle", key: "recurse" },
      },
      {
        name: tr().setDefaultZoomName,
        control: { type: "dropdown", key: "defaultZoom", options: { Day: "Day", Week: "Week", Month: "Month", Fit: "Fit" } },
      },
      {
        name: tr().setDateFormatName,
        control: {
          type: "dropdown",
          key: "dateFormat",
          options: { "YYYY/MM/DD": "YYYY/MM/DD", "DD/MM/YYYY": "DD/MM/YYYY", "MM/DD/YYYY": "MM/DD/YYYY" },
        },
      },
      // ステータス一覧（追加/削除可）。各ステータスは id/label/color を持つサブページ
      // status list (add/delete); each status is a sub-page holding id/label/color
      {
        type: "list",
        heading: tr().setStatusesHeading,
        onDelete: (index) => {
          s.statuses.splice(index, 1);
          void this.plugin.saveSettings();
          this.update();
        },
        addItem: {
          name: tr().setAddStatus,
          action: () => {
            s.statuses.push({ id: "new", label: "New", color: "#888888" });
            void this.plugin.saveSettings();
            this.update();
          },
        },
        items: s.statuses.map((status, index): SettingDefinitionPage => ({
          type: "page",
          name: status.label || status.id || `#${index + 1}`,
          items: [
            { name: tr().setStatusId, control: { type: "text", key: `status.${index}.id`, placeholder: "id" } },
            { name: tr().setStatusLabel, control: { type: "text", key: `status.${index}.label`, placeholder: "label" } },
            { name: tr().setStatusColor, control: { type: "color", key: `status.${index}.color` } },
          ],
        })),
      },
      // フロントマターのキー名 / frontmatter key names
      {
        type: "group",
        heading: tr().setKeysHeading,
        items: (Object.keys(s.keys) as (keyof typeof s.keys)[]).map((k) => ({
          name: k,
          control: { type: "text" as const, key: `keys.${k}` },
        })),
      },
    ];
  }

  // コントロールキー → 設定値の読み出し（ネスト対応）/ read a control value (handles nested keys)
  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    if (key === "rootFolder") return s.rootFolder;
    if (key === "recurse") return s.recurse;
    if (key === "defaultZoom") return s.defaultZoom;
    if (key === "dateFormat") return s.dateFormat;
    const km = key.match(/^keys\.(.+)$/);
    if (km) return s.keys[km[1] as keyof typeof s.keys];
    const sm = key.match(/^status\.(\d+)\.(id|label|color)$/);
    if (sm) {
      const st = s.statuses[Number(sm[1])];
      return st ? st[sm[2] as "id" | "label" | "color"] : "";
    }
    return undefined;
  }

  // コントロールキー → 設定値の書き込み（保存して開いているガントを再描画）/ persist a control value
  setControlValue(key: string, value: unknown): void | Promise<void> {
    const s = this.plugin.settings;
    if (key === "rootFolder") s.rootFolder = String(value).trim();
    else if (key === "recurse") s.recurse = Boolean(value);
    else if (key === "defaultZoom") s.defaultZoom = value as ZoomMode;
    else if (key === "dateFormat") s.dateFormat = value as DateFormat;
    else {
      const km = key.match(/^keys\.(.+)$/);
      const sm = key.match(/^status\.(\d+)\.(id|label|color)$/);
      if (km) {
        const kk = km[1] as keyof typeof s.keys;
        s.keys[kk] = String(value).trim() || kk;
      } else if (sm) {
        const st = s.statuses[Number(sm[1])];
        if (st) {
          const prop = sm[2] as "id" | "label" | "color";
          if (prop === "id") st.id = String(value).trim();
          else if (prop === "label") st.label = String(value);
          else st.color = String(value);
        }
      }
    }
    return this.plugin.saveSettings();
  }
}
