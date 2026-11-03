import { Plugin, WorkspaceLeaf, TFolder, TFile, Menu, TAbstractFile } from "obsidian";
import { GanttSettings, DEFAULT_SETTINGS, GanttSettingTab } from "./settings";
import { GanttView } from "./view";
import { VIEW_TYPE_GANTT, GanttViewState } from "./types";
import { t } from "./i18n";
import { inferStatusGroup, moveCollapsed } from "./model";
import { checkNotifications } from "./notify";
import { usePopoverKeys } from "./popover";
import { migrateRenamedPath, schedulePush, syncGcal } from "./gcal/sync";
import { isConnected } from "./gcal/auth";
import { migrateLegacySecrets } from "./gcal/secrets";

export default class GanttPlugin extends Plugin {
  settings!: GanttSettings;
  // 設定タブ。表から色を変えたときに開いていれば描き直すため保持する
  // the settings tab, held so a table-side color edit can refresh it while it's open
  settingTab?: GanttSettingTab;
  private lastNotifyCheck = 0; // 前回チェック時刻 / last notification check (epoch ms)
  private lastGcalPull = 0; // 前回の Google カレンダー Pull / last Google Calendar pull (epoch ms)

  async onload(): Promise<void> {
    await this.loadSettings();
    usePopoverKeys(this.app); // ポップオーバーの Esc を設定画面などより先に受ける / popovers take Esc before, say, the settings window

    this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));
    // 本文・担当者のリンクのホバーでページプレビューを出す / Page preview for links in the body and assignee
    this.registerHoverLinkSource(VIEW_TYPE_GANTT, { display: "Task Gantt", defaultMod: true });

    // 一番左の列（リボン）のアイコン＝フォーカス中フォルダで開く / ribbon opens the focused folder
    this.addRibbonIcon("gantt-chart", t().ribbonOpen, () => {
      void this.activateView(this.currentFolder());
    });

    this.addCommand({
      id: "open-gantt",
      name: t().commandOpen,
      callback: () => void this.activateView(this.currentFolder()),
    });

    // 前面のボードへのコマンド（ボードが前面のときだけ）：PNG に書き出す・読み直す（読み直しはツールバーから「⋯」メニューへ移したので、ホットキーも割り当てられるように）
    // commands for the board in front (only while one is): export as PNG, and reload (moved from the toolbar to the "⋯" menu, so it can take a hotkey too)
    const boardCommand = (id: string, name: string, run: (view: GanttView) => void) => this.addCommand({ id, name, checkCallback: (checking) => {
      const view = this.app.workspace.getActiveViewOfType(GanttView);
      if (view && !checking) run(view);
      return !!view;
    } });
    boardCommand("export-png", t().exportPng, (view) => void view.exportPng());
    boardCommand("reload-board", t().reloadAria, (view) => void view.refresh());

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

    // 表から色を変えたときに設定画面へ反映できるよう参照を持つ / kept so table-side color edits can refresh it
    this.settingTab = new GanttSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

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
    // リネーム・移動は同期状態のキーを付け替え、フォルダならボードの表示設定もついて行かせる。畳んだ親タスクは閉じたボードでも追いかける
    // renames re-key the sync state; a folder rename carries its boards' view setup along, and collapsed parent tasks follow on closed boards too
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) migrateRenamedPath(this, oldPath, file.path);
        if (file instanceof TFile || file instanceof TFolder) this.moveBoards(oldPath, file.path);
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
          if (g.calendarId && isConnected(this)) {
            const pull = g.pullEnabled && now - this.lastGcalPull >= g.pullIntervalMin * 60_000;
            if (pull) this.lastGcalPull = now;
            void syncGcal(this, { pull });
          }
        }, 60_000)
      );
    });
  }

  // フォルダ（と配下）のボード設定のキー "folder:<パス>" を付け替え、どのボードでも畳んだ親タスク（パス）を追いかけさせる
  // re-key the "folder:<path>" board setups of a renamed folder and its subfolders, and let collapsed parent tasks (paths) follow on every board
  private moveBoards(from: string, to: string): void {
    const boards = this.settings.boards;
    let moved = false;
    for (const key of Object.keys(boards)) {
      const collapsed = moveCollapsed(boards[key].collapsed ?? [], from, to);
      if (collapsed.some((k, i) => k !== boards[key].collapsed[i])) {
        boards[key] = { ...boards[key], collapsed };
        moved = true;
      }
      const path = key.startsWith("folder:") ? key.slice(7) : null;
      if (path == null || (path !== from && !path.startsWith(from + "/"))) continue;
      boards[`folder:${to}${path.slice(from.length)}`] = boards[key];
      delete boards[key];
      moved = true;
    }
    // フォルダの見出しのアイコン（キーは "folder:<パス>"）もついて行く / folder heading icons ("folder:<path>") follow too
    const icons = this.settings.icons;
    for (const key of Object.keys(icons)) {
      const path = key.startsWith("folder:") ? key.slice(7) : null;
      if (path == null || (path !== from && !path.startsWith(from + "/"))) continue;
      icons[`folder:${to}${path.slice(from.length)}`] = icons[key];
      delete icons[key];
      moved = true;
    }
    if (moved) void this.saveData(this.settings);
  }

  // ステータスの名前を変えたら、名前で覚えている見出しのアイコンと畳んだ見出し（"status:<名前>"）を付け替える。行き先が埋まっていれば触らない。保存は呼び出し側
  // after a status is renamed, re-key what is remembered by its name: the heading icon and collapsed headings ("status:<name>");
  // a target already in use is left alone. The caller saves
  renameStatusKeys(from: string, to: string): void {
    const a = `status:${from}`;
    const b = `status:${to}`;
    if (a === b) return;
    const { icons, boards } = this.settings;
    if (icons[a] && !icons[b]) {
      icons[b] = icons[a];
      delete icons[a];
    }
    for (const board of Object.values(boards)) {
      if (board.collapsed?.includes(a) && !board.collapsed.includes(b)) board.collapsed = board.collapsed.map((k) => (k === a ? b : k));
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT)) if (leaf.view instanceof GanttView) leaf.view.renameCollapsed(a, b);
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
    // ステータスは設定画面で直接書き換えるので必ず複製する（未保存だと既定配列を共有してしまう）。
    // 2.9.0 以前の保存データには group が無いので、id とラベルから推測して補う。
    // statuses are mutated in place by the settings tab, so always clone (an unsaved install would
    // otherwise share the DEFAULT array); pre-2.9.0 data has no group, so infer one from id + label
    this.settings.statuses = (this.settings.statuses ?? []).map((s) => ({
      ...s,
      group: s.group ?? inferStatusGroup(s.id ?? "", s.label ?? ""),
    }));
    // 既定の空配列/オブジェクトを共有参照しないよう複製（変更でモジュール既定を汚さない）/ clone so we don't mutate the shared DEFAULT containers
    this.settings.tagColors = (this.settings.tagColors ?? []).map((c) => ({ ...c }));
    this.settings.folderColors = (this.settings.folderColors ?? []).map((c) => ({ ...c }));
    this.settings.assigneeColors = (this.settings.assigneeColors ?? []).map((c) => ({ ...c }));
    this.settings.icons = { ...(this.settings.icons ?? {}) };
    this.settings.boards = { ...(this.settings.boards ?? {}) };
    this.settings.columnWidths = { ...(this.settings.columnWidths ?? {}) };
    this.settings.columnOrder = [...(this.settings.columnOrder ?? [])];
    this.settings.autoStatus = Object.assign({}, DEFAULT_SETTINGS.autoStatus, this.settings.autoStatus);
    this.settings.autoStatus.notStarted = [...(this.settings.autoStatus.notStarted ?? [])];
    this.settings.customFields = (this.settings.customFields ?? []).map((f) => ({ ...f }));
    this.settings.nonWorkingDays = [...(this.settings.nonWorkingDays ?? DEFAULT_SETTINGS.nonWorkingDays)];
    // 通知設定も既定とマージ＆複製 / merge notify settings with defaults and clone containers
    this.settings.notify = Object.assign({}, DEFAULT_SETTINGS.notify, this.settings.notify);
    this.settings.notify.leads = [...(this.settings.notify.leads ?? [])];
    this.settings.notify.sent = { ...(this.settings.notify.sent ?? {}) };
    // Google カレンダー設定も既定とマージ＆複製 / merge Google Calendar settings with defaults and clone containers
    this.settings.gcal = Object.assign({}, DEFAULT_SETTINGS.gcal, this.settings.gcal);
    const st: typeof this.settings.gcal.state = {};
    for (const [p, v] of Object.entries(this.settings.gcal.state ?? {})) st[p] = { ...v };
    this.settings.gcal.state = st;
    // 旧バージョンが平文で残した秘匿情報を SecretStorage へ移し、data.json から消す（Issue #6）
    // move secrets older versions left in plain text into SecretStorage and scrub data.json (issue #6)
    if (migrateLegacySecrets(this)) await this.saveData(this.settings);
  }

  // 見た目だけの設定（色・ステータス・アイコン・列幅）を保存し、開いているボードと設定画面を描き直す（タスクは読み直さない）
  // save appearance-only settings (colours, statuses, icons, column widths) and redraw every open board and the settings tab, without re-reading tasks
  async saveLook(): Promise<void> {
    await this.saveData(this.settings);
    this.settingTab?.refreshIfOpen();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT)) if (leaf.view instanceof GanttView) leaf.view.rerender();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.app.workspace.getLeavesOfType(VIEW_TYPE_GANTT).forEach((leaf: WorkspaceLeaf) => {
      const v = leaf.view;
      if (v instanceof GanttView) void v.refresh();
    });
  }
}
