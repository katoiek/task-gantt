import { Plugin, WorkspaceLeaf, TFolder, TFile, Menu, TAbstractFile } from "obsidian";
import { GanttSettings, DEFAULT_SETTINGS, GanttSettingTab } from "./settings";
import { GanttView } from "./view";
import { VIEW_TYPE_GANTT, GanttViewState } from "./types";

export default class GanttPlugin extends Plugin {
  settings!: GanttSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));

    // 一番左の列（リボン）のアイコン＝フォーカス中フォルダで開く / ribbon opens the focused folder
    this.addRibbonIcon("gantt-chart", "Gantt を開く / Open Gantt", () => {
      void this.activateView(this.currentFolder());
    });

    this.addCommand({
      id: "open-gantt",
      name: "Gantt を開く（現在のフォルダ）/ Open Gantt for current folder",
      callback: () => void this.activateView(this.currentFolder()),
    });

    // フォルダ右クリック → このフォルダを Gantt 表示 / folder context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle("Gantt で開く / Open as Gantt")
              .setIcon("gantt-chart")
              .onClick(() => void this.activateView(file.path))
          );
        }
      })
    );

    this.addSettingTab(new GanttSettingTab(this.app, this));
  }

  // フォーカス中フォルダを推定 / best-effort current folder
  private currentFolder(): string {
    // 1. ファイルエクスプローラで選択中のフォルダ / folder selected in the file explorer
    const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = explorer?.view as unknown as { tree?: { focusedItem?: { file?: TAbstractFile } } } | undefined;
    const focused = view?.tree?.focusedItem?.file;
    if (focused instanceof TFolder) return focused.path;
    if (focused instanceof TFile && focused.parent) return focused.parent.path;
    // 2. アクティブノートの親フォルダ / active note's parent folder
    const af = this.app.workspace.getActiveFile();
    if (af?.parent) return af.parent.path;
    // 3. 設定の既定フォルダ / configured default
    return this.settings.rootFolder ?? "";
  }

  // 指定フォルダにスコープして専用ビューを開く / open the view scoped to a folder
  async activateView(folderPath: string): Promise<void> {
    const state: GanttViewState = { folder: folderPath };
    // 既存ビューがあれば再利用してスコープだけ差し替え / reuse an existing view, just re-scope it
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT)[0];
    const leaf = existing ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_GANTT,
      active: true,
      state: state as unknown as Record<string, unknown>,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.keys = Object.assign({}, DEFAULT_SETTINGS.keys, this.settings.keys);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT).forEach((leaf: WorkspaceLeaf) => {
      const v = leaf.view;
      if (v instanceof GanttView) void v.refresh();
    });
  }
}
