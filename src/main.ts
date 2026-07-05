import { Plugin, WorkspaceLeaf, TFolder, TFile, Menu, TAbstractFile } from "obsidian";
import { GanttSettings, DEFAULT_SETTINGS, GanttSettingTab } from "./settings";
import { GanttView } from "./view";
import { VIEW_TYPE_GANTT, GanttViewState } from "./types";
import { t } from "./i18n";
import { checkNotifications } from "./notify";
import { migrateRenamedPath, schedulePush, syncGcal } from "./gcal/sync";

export default class GanttPlugin extends Plugin {
  settings!: GanttSettings;
  private lastNotifyCheck = 0; // 前回チェック時刻 / last notification check (epoch ms)
  private lastGcalPull = 0; // 前回の Google カレンダー Pull / last Google Calendar pull (epoch ms)

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));

    // 一番左の列（リボン）のアイコン＝フォーカス中フォルダで開く / ribbon opens the focused folder
    this.addRibbonIcon("gantt-chart", t().ribbonOpen, () => {
      void this.activateView(this.currentFolder());
    });

    this.addCommand({
      id: "open-gantt",
      name: t().commandOpen,
      callback: () => void this.activateView(this.currentFolder()),
    });

    // フォルダ右クリック → このフォルダを Gantt 表示 / folder context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle(t().menuOpen)
              .setIcon("gantt-chart")
              .onClick(() => void this.activateView(file.path))
          );
        }
      })
    );

    this.addSettingTab(new GanttSettingTab(this.app, this));

    this.addCommand({
      id: "gcal-sync-now",
      name: `${t().setGcalHeading}: ${t().setGcalSyncNow}`,
      callback: () => void syncGcal(this, { pull: true }),
    });

    // ローカル編集を数秒デバウンスで Push（対象判定と差分検出は sync 側）
    // debounce local edits into a push (scope and diffing are handled by the sync engine)
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension === "md") schedulePush(this);
      })
    );
    // リネーム・移動は同期状態のキーを付け替える / renames re-key the sync state
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) migrateRenamedPath(this, oldPath, file.path);
      })
    );
    // 削除はイベントの孤児掃除を予約 / deletions schedule the orphan cleanup
    this.registerEvent(
      this.app.vault.on("delete", () => schedulePush(this))
    );

    // 通知スケジューラ：1分間隔で「前回チェック以降に来たトリガー」を送信。
    // Obsidian 終了中に過ぎた分は対象外（起動時に過去分をまとめて送らない）。
    // notification scheduler: every minute, send triggers that arrived since the last check.
    // triggers missed while Obsidian was closed are skipped (no burst on startup).
    this.app.workspace.onLayoutReady(() => {
      this.lastNotifyCheck = Date.now();
      this.registerInterval(
        window.setInterval(() => {
          const now = Date.now();
          const from = this.lastNotifyCheck;
          this.lastNotifyCheck = now;
          void checkNotifications(this, from, now);
          // Google カレンダー：Pull は設定間隔で、Push は毎分の掃き出し（差分が無ければ何もしない）
          // Google Calendar: pull at the configured interval, push sweeps every minute (no-op without changes)
          const g = this.settings.gcal;
          if (g.refreshToken && g.calendarId) {
            const pull = g.pullEnabled && now - this.lastGcalPull >= g.pullIntervalMin * 60_000;
            if (pull) this.lastGcalPull = now;
            void syncGcal(this, { pull });
          }
        }, 60_000)
      );
    });
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
    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    // loadData() は any を返すので保存形へ明示キャスト / loadData() returns any: cast to the saved shape
    const data = (await this.loadData()) as Partial<GanttSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.keys = Object.assign({}, DEFAULT_SETTINGS.keys, this.settings.keys);
    // 既定の空配列/オブジェクトを共有参照しないよう複製（変更でモジュール既定を汚さない）/ clone so we don't mutate the shared DEFAULT containers
    this.settings.tagColors = (this.settings.tagColors ?? []).map((c) => ({ ...c }));
    this.settings.folderColors = (this.settings.folderColors ?? []).map((c) => ({ ...c }));
    this.settings.columnWidths = { ...(this.settings.columnWidths ?? {}) };
    // 通知設定も既定とマージ＆複製 / merge notify settings with defaults and clone containers
    this.settings.notify = Object.assign({}, DEFAULT_SETTINGS.notify, this.settings.notify);
    this.settings.notify.leads = [...(this.settings.notify.leads ?? [])];
    this.settings.notify.sent = { ...(this.settings.notify.sent ?? {}) };
    // Google カレンダー設定も既定とマージ＆複製 / merge Google Calendar settings with defaults and clone containers
    this.settings.gcal = Object.assign({}, DEFAULT_SETTINGS.gcal, this.settings.gcal);
    const st: typeof this.settings.gcal.state = {};
    for (const [p, v] of Object.entries(this.settings.gcal.state ?? {})) st[p] = { ...v };
    this.settings.gcal.state = st;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT).forEach((leaf: WorkspaceLeaf) => {
      const v = leaf.view;
      if (v instanceof GanttView) void v.refresh();
    });
  }
}
