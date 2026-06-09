import { App, PluginSettingTab, Setting } from "obsidian";
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
  // タグ/フォルダの色（手動上書き。未登録は名前ハッシュで自動生成）/ manual color overrides (unset → auto from name hash)
  tagColors: { name: string; color: string }[];
  folderColors: { name: string; color: string }[];
  // フロントマターのキー名（プロジェクトに合わせて変更可）/ frontmatter key names
  keys: {
    start: string;
    end: string;
    status: string;
    assignee: string;
    after: string;
    progress: string;
    milestone: string;
    parent: string;
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
  tagColors: [],
  folderColors: [],
  keys: {
    start: "start",
    end: "end",
    status: "status",
    assignee: "assignee",
    after: "after",
    progress: "progress",
    milestone: "milestone",
    parent: "parent",
  },
};

export class GanttSettingTab extends PluginSettingTab {
  plugin: GanttPlugin;

  constructor(app: App, plugin: GanttPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // 設定画面（従来の display 方式＝全 Obsidian で確実に描画される）/ classic display() — renders reliably on all Obsidian versions
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl)
      .setName(tr().setDefaultFolderName)
      .setDesc(tr().setDefaultFolderDesc)
      .addText((t) =>
        t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(s.rootFolder).onChange((v) => {
          s.rootFolder = v.trim();
          save();
        })
      );

    new Setting(containerEl)
      .setName(tr().setRecurseName)
      .setDesc(tr().setRecurseDesc)
      .addToggle((t) => t.setValue(s.recurse).onChange((v) => { s.recurse = v; save(); }));

    new Setting(containerEl)
      .setName(tr().setDefaultZoomName)
      .addDropdown((d) =>
        d.addOptions({ Day: "Day", Week: "Week", Month: "Month", Fit: "Fit" }).setValue(s.defaultZoom).onChange((v) => {
          s.defaultZoom = v as ZoomMode;
          save();
        })
      );

    new Setting(containerEl)
      .setName(tr().setDateFormatName)
      .addDropdown((d) =>
        d
          .addOptions({ "YYYY/MM/DD": "YYYY/MM/DD", "DD/MM/YYYY": "DD/MM/YYYY", "MM/DD/YYYY": "MM/DD/YYYY" })
          .setValue(s.dateFormat)
          .onChange((v) => { s.dateFormat = v as DateFormat; save(); })
      );

    // ステータス一覧（id/ラベル/色＋削除、末尾に追加ボタン）/ status list (id/label/color + delete, add button at the end)
    new Setting(containerEl).setName(tr().setStatusesHeading).setHeading();
    s.statuses.forEach((st, i) => {
      new Setting(containerEl)
        .addText((t) => t.setPlaceholder(tr().setStatusId).setValue(st.id).onChange((v) => { st.id = v.trim(); save(); }))
        .addText((t) => t.setPlaceholder(tr().setStatusLabel).setValue(st.label).onChange((v) => { st.label = v; save(); }))
        .addColorPicker((c) => c.setValue(st.color).onChange((v) => { st.color = v; save(); }))
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
            s.statuses.splice(i, 1);
            save();
            this.display();
          })
        );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddStatus).setCta().onClick(() => {
        s.statuses.push({ id: "new", label: "New", color: "#888888" });
        save();
        this.display();
      })
    );

    // タグの色（名前＋色＋削除。フォルダの色は表で右クリック）/ tag colors (name + color + delete; folder colors via right-click in the table)
    new Setting(containerEl).setName(tr().setTagColorsHeading).setHeading();
    s.tagColors.forEach((tc, i) => {
      new Setting(containerEl)
        .addText((t) => t.setPlaceholder(tr().setColorName).setValue(tc.name).onChange((v) => { tc.name = v.trim(); save(); }))
        .addColorPicker((c) => c.setValue(tc.color).onChange((v) => { tc.color = v; save(); }))
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
            s.tagColors.splice(i, 1);
            save();
            this.display();
          })
        );
    });
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddTagColor).onClick(() => {
        s.tagColors.push({ name: "", color: "#888888" });
        save();
        this.display();
      })
    );

    // フロントマターのキー名 / frontmatter key names
    new Setting(containerEl).setName(tr().setKeysHeading).setHeading();
    (Object.keys(s.keys) as (keyof typeof s.keys)[]).forEach((k) => {
      new Setting(containerEl)
        .setName(k)
        .addText((t) => t.setValue(s.keys[k]).onChange((v) => { s.keys[k] = v.trim() || k; save(); }));
    });
  }
}
