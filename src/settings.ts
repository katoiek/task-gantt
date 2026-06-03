import { App, PluginSettingTab, Setting } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, ZoomMode } from "./types";

// プラグイン設定 / Plugin settings
export interface GanttSettings {
  rootFolder: string; // 集計する親フォルダ / parent folder to aggregate
  recurse: boolean; // サブフォルダを再帰的に辿るか / recurse into subfolders
  statuses: StatusDef[];
  defaultZoom: ZoomMode;
  detailWidth: number; // 詳細パネルの幅(px) / detail panel width (px)
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
  detailWidth: 380,
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("既定フォルダ / Default folder")
      .setDesc("リボンでフォルダ未選択のときに使う既定フォルダ。通常はフォルダを右クリック→「Gantt で開く」、またはフォルダ選択中にリボンを押します。/ Fallback folder; usually right-click a folder → Open as Gantt.")
      .addText((t) =>
        t
          .setPlaceholder("例: Projects/お掃除")
          .setValue(this.plugin.settings.rootFolder)
          .onChange(async (v) => {
            this.plugin.settings.rootFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("サブフォルダを再帰 / Recurse subfolders")
      .setDesc("直下のサブフォルダをグループ、その中のファイルをタスクにします。/ Subfolders become groups.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.recurse).onChange(async (v) => {
          this.plugin.settings.recurse = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("既定のズーム / Default zoom")
      .addDropdown((dd) =>
        dd
          .addOption("Day", "Day")
          .addOption("Week", "Week")
          .addOption("Month", "Month")
          .setValue(this.plugin.settings.defaultZoom)
          .onChange(async (v) => {
            this.plugin.settings.defaultZoom = v as ZoomMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("ステータス / Statuses").setHeading();
    this.plugin.settings.statuses.forEach((status, index) => {
      const setting = new Setting(containerEl)
        .addText((t) =>
          t.setPlaceholder("id").setValue(status.id).onChange(async (v) => {
            status.id = v.trim();
            await this.plugin.saveSettings();
          })
        )
        .addText((t) =>
          t.setPlaceholder("label").setValue(status.label).onChange(async (v) => {
            status.label = v;
            await this.plugin.saveSettings();
          })
        )
        .addColorPicker((c) =>
          c.setValue(status.color).onChange(async (v) => {
            status.color = v;
            await this.plugin.saveSettings();
          })
        )
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("削除 / Delete").onClick(async () => {
            this.plugin.settings.statuses.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
        );
      setting.infoEl.remove();
    });

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("ステータスを追加 / Add status").setCta().onClick(async () => {
        this.plugin.settings.statuses.push({ id: "new", label: "New", color: "#888888" });
        await this.plugin.saveSettings();
        this.display();
      })
    );

    new Setting(containerEl).setName("フロントマターのキー名 / Frontmatter keys").setHeading();
    const keys = this.plugin.settings.keys;
    (Object.keys(keys) as (keyof typeof keys)[]).forEach((k) => {
      new Setting(containerEl).setName(k).addText((t) =>
        t.setValue(keys[k]).onChange(async (v) => {
          keys[k] = v.trim() || k;
          await this.plugin.saveSettings();
        })
      );
    });
  }
}
