import { ItemView, Menu, MarkdownRenderer, WorkspaceLeaf, setIcon, Notice, Platform, TFile, ViewStateResult, moment } from "obsidian";
import type GanttPlugin from "./main";
import { Task, Row, ZoomMode, DepType, GanttViewState, VIEW_TYPE_GANTT, Filter, FilterMatch, FilterPreset, DateFilterItem, CategoryFilter, CategoryField, CategoryOp, TextFilter, TextOp, DateValue, DateOp, DateField, DateUnit, DateDir, StatusGroup, STATUS_GROUPS } from "./types";
import {
  collectTasks,
  collectFolders,
  buildRows,
  createTask,
  reparentTask,
  subtreePaths,
  validCustomFields,
  customValueText,
  parseCustomInput,
  writeDates,
  combineDateTime,
  writeField,
  writeBody,
  renameTask,
  deleteTask,
  addTag,
  removeTag,
  collectAllTags,
  addDependency,
  removeDependency,
  readBody,
  anchorStart,
  anchorEnd,
  isOverdue,
  newTaskDates,
} from "./model";
import { cascadeDates, endForDuration, keepDurationOnStartChange, parseDuration, scheduleOptions, successorClosure, taskDuration, wouldLoop } from "./schedule";
import {
  DateRange,
  computeRange,
  dayIndex,
  dayToStr,
  pxPerDay,
  buildTicks,
  todayIndex,
  formatDate,
  buildProgressLine,
  ProgressLineRow,
} from "./timeline";
import { hashColor, resolveTagColor } from "./colors";
import { ConfirmModal } from "./modals";
import { linkLabel } from "./links";
import { attachLinkSuggest, handleLinkClick, renderLinkValue, wireLinkHover } from "./linkui";
import { t as tr, statusGroupLabel } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var
import { schedulePush } from "./gcal/sync";
import { GanttSettings, defaultViewConfig, legacyViewConfig } from "./settings";
import { KanbanColumn, KanbanLane, ROOT_LANE_KEY, UNASSIGNED_KEY, applyManualOrder, buildKanbanColumns, cardZone, collapseColumns, columnKey, laneKeyOf, moveId, orderStatusIds, placeInOrder, splitLanes, subtasksOf, toggleCollapsed } from "./kanban";
import { BoardView, ViewConfig, ViewType, activeView, addView, boardKey, createBoardViews, deleteView, duplicateView, renameView, LaneBy } from "./views";
import { ExportFormat, ExportScope, boardToPdf, boardToPng } from "./export";
import { isConnected } from "./gcal/auth";
import { applyFilters, regroup } from "./filter";
import { fillSourceIndex, parseTsv, summarizeCells, toTsv } from "./cells";
import { BoardContext, Move, MutateResult } from "./board";
import { BUILTIN_COLUMNS, CellColumn, ColumnDef, columnWidth, customColumn, taskComparator, visibleColumns } from "./columns";

const ROW_H = 30; // 行の高さ（表とタイムラインで共通）/ shared row height
const HEAD_H = 40; // ヘッダー高さ / header height
const BAR_PAD = 5; // バーの上下余白 / vertical padding inside a row
const RESIZE_EDGE = 8; // バー端リサイズの当たり幅 / edge-resize hit width
const MIN_PPD = 2; // Fit 時の最小 1 日幅（これ未満は横スクロール）/ minimum px/day in Fit mode
const FIT_SCROLLBAR_PAD = 16; // 縦スクロールバー分の余白 / room for the vertical scrollbar
const FALLBACK_BAR = "#7c8db5"; // ステータス/担当者が未設定のときのバー色 / bar color when status/assignee is unset

const MAX_INDENT_DEPTH = 8; // インデントの段数上限（論理ツリーは無制限）/ visual indent cap (the tree itself is unlimited)

// 履歴 1 件：操作前パス→内容（null＝存在しなかった）と、操作中の移動（実行順）
// one history entry: pre-op path → contents (null = didn't exist) and the op's moves, in order
// created / deleted は「書き戻しでファイルを作り直してよいパス」の判定に使う（それ以外は作り直さない）
// created / deleted decide which paths a restore may re-create (no other missing file is ever re-created)
interface HistoryEntry {
  label: string;
  files: Map<string, string | null>;
  moves: Move[];
  created: string[]; // 操作で作成 / made by the op
  deleted: string[]; // 操作で削除 / removed by the op
}

// 移動 b が移動 a と同じか、a（フォルダ）の移動に伴う配下の移動か / whether move b is move a itself, or follows from a folder move a
function movesUnder(a: Move, b: Move): boolean {
  if (a.from === b.from && a.to === b.to) return true;
  return b.from.startsWith(a.from + "/") && b.to === a.to + b.from.slice(a.from.length);
}

// テーブルのセル 1 つ（行＝タスクのパス、列＝列 ID）/ one table cell (row = the task's path, column = the column id)
interface CellRef {
  path: string;
  col: string;
}

export class GanttView extends ItemView {
  plugin: GanttPlugin;
  private tasks: Task[] = [];
  private rows: Row[] = [];
  private range: DateRange = { min: 0, max: 0 };
  private ppd = 16;
  private selectedPath: string | null = null;
  private folder = ""; // 表示対象フォルダ / scoped folder path
  private exporting = false; // 書き出し中（同時に 1 つだけ）/ an export is running (one at a time)
  private collapsed = new Set<string>(); // 折りたたみ中フォルダのキー / collapsed folder keys

  // 今開いているビューの設定。保存場所（settings.boardViews）の中のオブジェクトをそのまま読み書きするので、コピーも同期も要らない
  // the open view's config: the object inside settings.boardViews itself is read and written, so there is no copy to keep in sync
  private cfg: ViewConfig;
  private boundKey = ""; // cfg が属するボードの鍵 / the board key cfg belongs to
  private folderKnown = false; // setState でフォルダが決まったか（それまではビューを結びつけない）/ whether setState has given the folder (views aren't bound before that)
  private vsCache: GanttSettings | null = null;
  private viewTabsHost!: HTMLElement; // ビューのタブの行 / the row of view tabs
  private renamingId: string | null = null; // 名前を直しているビュー / the view being renamed
  private persistTimer: number | null = null;
  private zoomBtns = new Map<ZoomMode, HTMLButtonElement>();
  private kanbanExpanded = new Set<string>(); // サブタスクを開いているカード（パス）/ cards whose subtasks are open (paths)
  private dragPath: string | null = null; // ドラッグ中のカード / the card being dragged
  // テーブルのセル選択（表のセルを、スプレッドシートのように選んで、コピー・貼り付け・フィルする）。パスと列 ID で持つので、描き直しても残る
  // the table's cell selection (pick cells like a spreadsheet to copy, paste and fill); held as path + column id, so it survives a redraw
  private cellSel: { anchor: CellRef; focus: CellRef } | null = null;
  private selBarEl: HTMLElement | null = null;
  private selDragging = false; // ドラッグで範囲を選んでいる最中 / dragging out a range
  private batchActive = false; // まとめて書いている最中（途中の再読込・取り消し記録を止める）/ writing in bulk (pauses reloads and undo records in between)
  private kanbanCols: KanbanColumn[] = []; // 今描いている列（レーンに分ける前・手動の順序を反映済み）/ the columns being drawn (before the lanes, manual order applied)
  private dragColumn: string | null = null; // ドラッグ中の列（ステータスの id）/ the column (status id) being dragged

  // 全体の設定の上に、ビューごとに違う 6 項目（フィルタ・一致条件・列・列幅・並べ替え）だけを重ねたもの。それ以外は全体の設定をそのまま読む。保存には使わない（保存は plugin.settings）
  // the global settings with just the six per-view items (filters, match, columns, widths, sort) laid over them; everything else reads through. Never saved itself (save plugin.settings)
  private get vs(): GanttSettings {
    if (!this.vsCache) {
      const prop = <K extends keyof ViewConfig>(key: K): PropertyDescriptor => ({
        enumerable: true,
        configurable: true,
        get: () => this.cfg[key],
        set: (v: ViewConfig[K]) => { this.cfg[key] = v; },
      });
      this.vsCache = Object.create(this.plugin.settings, {
        filters: prop("filters"),
        filterMatch: prop("filterMatch"),
        visibleColumns: prop("visibleColumns"),
        columnWidths: prop("columnWidths"),
        sortBy: prop("sortBy"),
        sortDir: prop("sortDir"),
      }) as GanttSettings;
    }
    return this.vsCache;
  }

  // 表示オプション（ビューごとに保存）/ view options (saved per view)
  private get zoom(): ZoomMode { return this.cfg.zoom; }
  private set zoom(v: ZoomMode) { this.cfg.zoom = v; }
  private get colorBy(): ViewConfig["colorBy"] { return this.cfg.colorBy; }
  private set colorBy(v: ViewConfig["colorBy"]) { this.cfg.colorBy = v; }
  private get groupBy(): ViewConfig["groupBy"] { return this.cfg.groupBy; }
  private set groupBy(v: ViewConfig["groupBy"]) { this.cfg.groupBy = v; }
  private get showEmptyFolders(): boolean { return this.cfg.showEmptyFolders; } // 空フォルダも行として表示（既定ON）/ show empty folders as rows (default on)
  private set showEmptyFolders(v: boolean) { this.cfg.showEmptyFolders = v; }
  private get flat(): boolean { return this.cfg.flat; } // フラット表示（フォルダ/親子を無視し全タスク一覧）/ flat list ignoring folders & nesting
  private set flat(v: boolean) { this.cfg.flat = v; }
  private get rollup(): boolean { return this.cfg.rollup; } // 親タスクのバーを子孫の集約で描く（既定OFF）/ draw parent bars as a rollup of descendants (default off)
  private set rollup(v: boolean) { this.cfg.rollup = v; }
  private get progressLine(): boolean { return this.cfg.progressLine; } // 稲妻線（既定OFF）/ progress line against today (default off)
  private set progressLine(v: boolean) { this.cfg.progressLine = v; }
  private get hideLabels(): boolean { return this.cfg.hideLabels; } // バーの名前・担当を隠す（既定OFF）/ hide the names and assignees on the bars (default off)
  private set hideLabels(v: boolean) { this.cfg.hideLabels = v; }
  private get markOverdue(): boolean { return this.cfg.markOverdue; } // 期限切れの強調（既定OFF）/ highlight overdue tasks (default off)
  private set markOverdue(v: boolean) { this.cfg.markOverdue = v; }
  private allFolders: string[][] = []; // スコープ配下の全フォルダ（相対セグメント）/ all folders under scope
  private optionsHost!: HTMLElement; // グループ/色分け/表示切替/凡例の差し替え先 / layout options + legend container
  private filterHost!: HTMLElement; // 統合フィルタ行の差し替え先 / unified filter bar container

  // 取り消し・やり直し履歴（対象ファイルのスナップショット＋移動）/ undo & redo history (snapshots of affected files + moves)
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  // 自分の書き込み中は >0。外部リネームだけを履歴の付け替え対象にするため
  // >0 while we are writing, so only outside renames remap the history
  private historyBusy = 0;
  // 同じタイミングで届いた外部リネーム（まとめて記録する）/ outside renames arriving together, recorded as a batch
  private pendingRenames: Move[] = [];
  private static readonly UNDO_LIMIT = 50;

  // バーがドラッグされたか（ドラッグ直後のクリック抑止用）/ whether a bar was dragged (to suppress the trailing click)
  private dragged = new WeakMap<SVGGElement, boolean>();

  // Fit モードでペイン幅に追従するための再描画タイマー / debounce timer to re-fit in Fit mode
  private fitTimer: number | null = null;

  // セル内エディタの連番（datalist の id 衝突を避ける）/ in-cell editor counter (keeps datalist ids unique)
  private cellEditSeq = 0;

  // DOM 参照 / DOM refs
  private tbodyEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private detailEl!: HTMLElement;
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GanttPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.cfg = defaultViewConfig(plugin.settings); // ボードが決まるまでの仮の設定 / a placeholder until the board is known
  }

  getViewType(): string {
    return VIEW_TYPE_GANTT;
  }
  getDisplayText(): string {
    const name = this.folder ? this.folder.split("/").pop() : "(vault)";
    return `Gantt: ${name}`;
  }
  getIcon(): string {
    return "gantt-chart";
  }

  // フォルダのスコープを状態として保存/復元 / persist the scoped folder
  getState(): Record<string, unknown> {
    return { folder: this.folder };
  }
  async setState(state: GanttViewState, result: ViewStateResult): Promise<void> {
    if (state && typeof state.folder === "string") {
      this.folder = state.folder;
      this.folderKnown = true;
    }
    await super.setState(state, result);
    if (this.gridHost) await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    await this.refresh();
    // メタデータ更新で自動再描画（ガント部のみ）/ re-render the grid when frontmatter changes
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    // ファイルの作成/削除/リネーム（フォルダ移動含む）でも自動再描画 / also re-render on create / delete / rename (incl. folder moves)
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.historyBusy === 0 && !this.isOwnMove(oldPath, file.path)) this.queueOutsideRename(oldPath, file.path);
      this.scheduleRefresh();
    }));
    // Ctrl/Cmd+Z で取り消し、Ctrl/Cmd+Shift+Z・Ctrl/Cmd+Y でやり直し（入力欄にフォーカス中はネイティブを優先）
    // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo (defer to the native ones while an input is focused)
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || (key === "y" && !e.shiftKey);
      if (!(isUndo || isRedo) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return;
      const ae = activeDocument.activeElement as HTMLElement | null;
      // テキスト編集中だけネイティブ undo を優先（time 等の入力はガント側の取り消しを通す）
      // defer to native undo only while editing text (time-like inputs shouldn't swallow the gantt undo)
      const editingText =
        !!ae &&
        (ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          (ae.instanceOf(HTMLInputElement) &&
            ["text", "search", "url", "tel", "password", "email", "number"].includes(ae.type)));
      if (editingText) return;
      e.preventDefault();
      void (isUndo ? this.undo() : this.redo());
    });
    // テーブルのセル操作：キー移動・コピー・切り取り・貼り付け・ドラッグ選択の終わり / table cells: arrow keys, copy, cut, paste, the end of a drag selection
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => this.onCellKey(e));
    this.registerDomEvent(activeDocument, "copy", (e: ClipboardEvent) => this.onCellCopy(e, false));
    this.registerDomEvent(activeDocument, "cut", (e: ClipboardEvent) => this.onCellCopy(e, true));
    this.registerDomEvent(activeDocument, "paste", (e: ClipboardEvent) => this.onCellPaste(e));
    this.registerDomEvent(window, "mouseup", () => {
      this.selDragging = false;
    });
  }

  // Obsidian がペイン/ウィンドウのリサイズ時に呼ぶフック。Fit のみ再描画（デバウンス）
  // Obsidian calls this on pane/window resize; re-fit in Fit mode only (debounced)
  onResize(): void {
    if (this.zoom !== "Fit") return;
    if (this.fitTimer != null) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.rerender(), 80);
  }

  // ツールバーと詳細パネルは永続化、再描画はガント部だけ / persistent toolbar + detail; only the grid re-renders
  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ogantt-board");
    // ボード本体は pane に入れ、詳細パネルはその右に並べる（ボードに重ねない）/ the board goes in a pane and the detail panel docks beside it (it doesn't cover the board)
    const pane = root.createDiv({ cls: "ogantt-pane" });
    this.viewTabsHost = pane.createDiv({ cls: "ogantt-viewtabs" }); // ビューのタブ / the view tabs
    this.renderToolbar(pane);
    this.optionsHost = pane.createDiv({ cls: "ogantt-options" }); // 中身は rerender で差し替え / repopulated on rerender
    this.filterHost = pane.createDiv({ cls: "ogantt-filterbar" }); // 統合フィルタ行（オプション行の下）/ filter row below options
    this.gridHost = pane.createDiv({ cls: "ogantt-host" });
    this.gridHost.addEventListener("mousedown", (e) => {
      if (!(e.target as HTMLElement).closest(".ogantt-td, .ogantt-fill-handle")) this.clearSelection();
    });
    this.selBarEl = pane.createDiv({ cls: "ogantt-selbar is-hidden" }); // 選んだ範囲の集計（件数・最小・最大・合計）/ the selected range's summary (count, min, max, sum)
    this.detailEl = root.createDiv({ cls: "ogantt-detail" });
    // 詳細パネルの外側（ビュー内のどこか）をクリックしたら閉じる。キャプチャ段階で閉じることで、
    // 行クリック等の「開く」ハンドラ（バブリング段階で実行）が後から開き直せる＝詳細の切り替えになる。
    // カレンダー等のポップオーバーは body 直下にあり root を経由しないため閉じない。
    // clicking anywhere in the view outside the detail panel closes it. Closing in the CAPTURE phase
    // lets open-handlers (row click etc., which run while bubbling) re-open it afterwards = panel switch.
    // popovers (calendar etc.) live under body, never pass through root, so they don't close it.
    root.addEventListener(
      "click",
      (ev) => {
        if (!this.detailEl?.hasClass("is-open")) return;
        const el = ev.target as Element;
        if (el.closest(".ogantt-detail")) return;
        this.detailEl.removeClass("is-open");
      },
      true
    );
  }

  private refreshTimer: number | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 300);
  }

  // ビューを閉じたら保留中のタイマーを止める（破棄後の再描画を防ぐ）/ stop the pending timer on close
  async onClose(): Promise<void> {
    this.flushPersist();
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.fitTimer != null) {
      window.clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    activeDocument.querySelectorAll(".ogantt-cal, .ogantt-colmenu, .ogantt-timepick, .ogantt-datemenu").forEach((e) => e.remove()); // 開いたままのポップオーバーを掃除 / drop any open popover
  }

  // ディスクから集計し直して再描画 / re-collect from disk, then render
  async refresh(): Promise<void> {
    if (this.batchActive) return; // まとめて書いている間は、終わってから 1 回だけ / while writing in bulk, once at the end
    if (!this.gridHost) this.buildSkeleton();
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.allFolders = collectFolders(this.app, this.plugin.settings, this.folder);
    this.rerender();
  }

  // メモリ上の this.tasks から描画（ディスクは読まない）/ render from in-memory tasks (no disk read)
  // ドラッグや整列の直後、metadataCache 更新前に正しい位置を即表示するため / shows correct positions before metadataCache updates
  rerender(): void {
    if (this.batchActive) return;
    if (!this.gridHost) this.buildSkeleton();
    this.bindBoardViews(); // このボードのビューを使う / use this board's views
    this.schedulePersist(); // 変えた設定を保存する / save what changed
    this.contentEl.toggleClass("is-kanban", this.activeType() === "kanban"); // ガント専用の操作を隠す / hides the Gantt-only controls
    this.contentEl.toggleClass("is-table", this.activeType() === "table"); // テーブルでも、タイムライン用の操作を隠す / the table view hides the timeline controls too
    this.renderOptions(); // グループ/色分け/凡例を最新データで更新 / refresh layout options + legend
    this.renderFilterBar(); // 統合フィルタ行を最新データで更新 / refresh the unified filter row
    if (this.activeType() === "kanban") {
      this.renderKanban(); // カンバンはここで描く。ガントの行・タイムラインは作らない / Kanban draws here; no Gantt rows or timeline
      return;
    }
    const view = this.processTasks(); // フィルタ＋グループ適用後 / after filter + group remap
    const compare = taskComparator(this.columns(), this.vs);
    if (this.flat) {
      // フラット：フォルダも親子も無視して全タスクを1本のソート済みリストに / flat: one sorted list, no grouping/nesting
      this.rows = view.slice().sort(compare).map((task) => ({ kind: "task", group: "", depth: 0, task }));
    } else {
      // フォルダグループ化＋オプションON のときだけ空フォルダもノード化 / seed empty folders only when grouping by folder and the option is on
      const folders = this.showEmptyFolders && this.groupBy === "folder" ? this.allFolders : [];
      // 親子ネストはフォルダグループ化のときだけ / nest by parent only when grouping by folder
      this.rows = buildRows(view, this.collapsed, folders, compare, this.groupBy === "folder");
    }
    this.range = computeRange(view);
    this.ppd = this.computePpd();
    const titleEl = this.contentEl.querySelector(".ogantt-title");
    if (titleEl) titleEl.setText(this.folder || "(vault root)");

    this.gridHost.empty();
    // タスクが無くても表示すべきフォルダ行があれば描画する / render if there are rows (even empty folders)
    if (this.rows.length === 0) {
      this.gridHost.createDiv({ cls: "ogantt-empty" }).setText(
        tr().emptyMessage(this.folder || "vault")
      );
      return;
    }
    const main = this.gridHost.createDiv({ cls: "ogantt-main" });
    this.renderGrid(main);
  }

  // 1 日あたりピクセルを決定。Fit はペイン幅から算出（収まらなければ最小幅で横スクロール）
  // pixels-per-day; Fit derives it from the pane width (falls back to scrolling below MIN_PPD)
  private computePpd(): number {
    if (this.zoom !== "Fit") return pxPerDay(this.zoom);
    const totalDays = Math.max(1, this.range.max - this.range.min + 1);
    const avail = (this.gridHost?.clientWidth ?? 0) - this.tableWidth() - FIT_SCROLLBAR_PAD;
    if (avail <= 0) return pxPerDay("Week"); // まだレイアウト前 / not laid out yet
    return Math.max(MIN_PPD, Math.floor(avail / totalDays));
  }

  // ----- ビュー（ボードごとの複数の設定）/ views (several saved looks per board) -----

  // このボードのビュー一覧を使う。ボードが決まった（または変わった）ときだけ切り替える。初めて開くボードは、これまでの全体設定を最初のビューとして引き継ぐ
  // use this board's views; switch only when the board is known or changes. A board opened for the first time takes the old global settings as its first view
  private bindBoardViews(): void {
    if (!this.folderKnown) return; // フォルダが決まる前に、ルート用のビューを作らない / don't create a vault-root entry before the folder is known
    const key = boardKey(this.folder);
    if (key === this.boundKey) return;
    this.flushPersist();
    this.boundKey = key;
    const map = this.plugin.settings.boardViews;
    let bv = map[key];
    if (!bv) {
      bv = createBoardViews(tr().viewGantt, legacyViewConfig(this.plugin.settings));
      map[key] = bv;
      void this.plugin.saveData(this.plugin.settings);
    }
    this.useView(activeView(bv));
    this.renderViewTabs();
  }

  private currentViews(): ReturnType<typeof createBoardViews> | undefined {
    return this.plugin.settings.boardViews[this.boundKey];
  }

  private useView(v: BoardView): void {
    this.cfg = v.config;
    this.collapsed = new Set(this.cfg.collapsed);
    this.syncZoomButtons();
  }

  private syncZoomButtons(): void {
    for (const [z, btn] of this.zoomBtns) btn.toggleClass("is-active", z === this.zoom);
  }

  // 設定の変更を、少し待ってまとめて書き出す（rerender のたびに呼ぶ）/ write changes out after a short wait (called on every rerender)
  private schedulePersist(): void {
    if (this.persistTimer != null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => this.flushPersist(), 600);
  }

  private flushPersist(): void {
    if (this.persistTimer != null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.boundKey) return;
    this.cfg.collapsed = [...this.collapsed];
    void this.plugin.saveData(this.plugin.settings);
  }

  // ビューを切り替える：今のビューを保存して、選んだビューの設定ですべてを描き直す / switch views: save the current one, then redraw everything with the chosen view's settings
  private switchView(id: string): void {
    const bv = this.currentViews();
    const v = bv?.views.find((x) => x.id === id);
    if (!bv || !v || bv.active === id) return;
    this.flushPersist();
    bv.active = id;
    this.useView(v);
    this.renamingId = null;
    this.renderViewTabs();
    void this.plugin.saveData(this.plugin.settings);
    void this.refresh();
  }

  private openAddViewMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((it) => it.setTitle(tr().viewCopyThis).setIcon("copy").onClick(() => this.duplicateActiveView()));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle(tr().viewGantt).setIcon("gantt-chart").onClick(() => this.addNewView("gantt")));
    menu.addItem((it) => it.setTitle(tr().viewTable).setIcon("table").onClick(() => this.addNewView("table")));
    menu.addItem((it) => it.setTitle(tr().viewKanban).setIcon("kanban").onClick(() => this.addNewView("kanban")));
    menu.showAtMouseEvent(e);
  }

  // 新しいビュー（フィルタなし・既定の列とグループ・カードの項目）/ a new view (no filters, default columns and grouping, default card fields)
  private addNewView(type: ViewType): void {
    const bv = this.currentViews();
    if (!bv) return;
    this.flushPersist();
    const v = addView(bv, type === "kanban" ? tr().viewKanban : type === "table" ? tr().viewTable : tr().viewGantt, defaultViewConfig(this.plugin.settings), type);
    this.switchView(v.id);
  }

  // 今のビューの設定をそっくり複製して、その右隣に足し、開く / copy the open view's whole config next to it and open the copy
  private duplicateActiveView(id?: string): void {
    const bv = this.currentViews();
    if (!bv) return;
    this.flushPersist();
    const v = duplicateView(bv, id ?? bv.active, tr().viewCopyName);
    if (v) this.switchView(v.id);
  }

  private openViewMenu(e: MouseEvent, v: BoardView): void {
    const bv = this.currentViews();
    if (!bv) return;
    const menu = new Menu();
    menu.addItem((it) => it.setTitle(tr().viewRename).setIcon("pencil").onClick(() => { this.renamingId = v.id; this.renderViewTabs(); }));
    menu.addItem((it) => it.setTitle(tr().viewDuplicate).setIcon("copy").onClick(() => this.duplicateActiveView(v.id)));
    menu.addSeparator();
    menu.addItem((it) =>
      it
        .setTitle(tr().viewDelete)
        .setIcon("trash-2")
        .setDisabled(bv.views.length <= 1) // 最後の 1 つは消せない / the last view stays
        .onClick(() => this.confirmDeleteView(v))
    );
    menu.showAtMouseEvent(e);
  }

  private confirmDeleteView(v: BoardView): void {
    new ConfirmModal(this.app, {
      title: tr().viewDelete,
      body: tr().viewDeleteBody(v.name),
      confirmText: tr().viewDelete,
      cancelText: tr().cancel,
      onConfirm: () => {
        const bv = this.currentViews();
        if (!bv) return;
        const wasActive = bv.active === v.id;
        if (!deleteView(bv, v.id)) return;
        if (wasActive) this.useView(activeView(bv));
        this.renderViewTabs();
        void this.plugin.saveData(this.plugin.settings);
        if (wasActive) void this.refresh();
      },
    }).open();
  }

  // タブの行：[ビュー] [ビュー] [＋]。開いているタブには ▾（メニュー）。ダブルクリックまたはメニューで名前を直す。右クリックでもメニュー
  // the tab row: [view] [view] [+]. The open tab has a ▾ menu; double-click or the menu renames; right-click opens the menu too
  private renderViewTabs(): void {
    const host = this.viewTabsHost;
    const bv = this.currentViews();
    if (!host || !bv) return;
    host.empty();
    for (const v of bv.views) {
      const tab = host.createDiv({ cls: "ogantt-viewtab" + (v.id === bv.active ? " is-active" : "") });
      setIcon(tab.createSpan({ cls: "ogantt-opt-ico" }), v.type === "kanban" ? "kanban" : v.type === "table" ? "table" : "gantt-chart");
      if (this.renamingId === v.id) {
        const input = tab.createEl("input", { type: "text", cls: "ogantt-viewtab-rename", value: v.name });
        let done = false;
        const finish = (commit: boolean): void => {
          if (done) return;
          done = true;
          this.renamingId = null;
          if (commit && renameView(bv, v.id, input.value)) void this.plugin.saveData(this.plugin.settings);
          this.renderViewTabs();
        };
        input.addEventListener("keydown", (ev: KeyboardEvent) => {
          if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
          else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
        });
        input.addEventListener("blur", () => finish(true));
        window.setTimeout(() => { input.focus(); input.select(); }, 0);
        continue;
      }
      tab.createSpan({ cls: "ogantt-viewtab-name", text: v.name });
      tab.onclick = () => this.switchView(v.id);
      tab.ondblclick = () => { this.renamingId = v.id; this.renderViewTabs(); };
      tab.addEventListener("contextmenu", (ev: MouseEvent) => { ev.preventDefault(); this.openViewMenu(ev, v); });
      if (v.id === bv.active) {
        const more = tab.createSpan({ cls: "ogantt-viewtab-more" });
        setIcon(more, "chevron-down");
        more.setAttr("aria-label", tr().viewDelete + " / " + tr().viewRename);
        more.onclick = (ev) => { ev.stopPropagation(); this.openViewMenu(ev, v); };
      }
    }
    const add = host.createEl("button", { cls: "ogantt-viewtab-add clickable-icon" });
    setIcon(add, "plus");
    add.setAttr("aria-label", tr().viewAddAria);
    add.onclick = (ev) => this.openAddViewMenu(ev);
  }

  // ----- カンバン（ステータスごとの列に、タスクのカードを並べるビュー）/ Kanban (a column per status, the tasks as cards) -----

  private activeType(): ViewType {
    const bv = this.currentViews();
    return bv ? activeView(bv).type : "gantt";
  }

  // 列（ステータス）に、フィルタ済みのタスクをカードとして並べる。並びは、このビューの並べ替え
  // columns (statuses) holding the filtered tasks as cards, in this view's sort order
  private renderKanban(): void {
    this.rows = []; // 書き出しなど、ガントの行を使う処理が古い行を見ないように / so Gantt-row code (export and the like) never sees stale rows
    const host = this.gridHost;
    host.empty();
    if (this.tasks.length === 0) {
      host.createDiv({ cls: "ogantt-empty" }).setText(tr().emptyMessage(this.folder || "vault"));
      return;
    }
    const { filters, filterMatch, statuses } = this.vs;
    const list = [...applyFilters(this.tasks, filters, filterMatch, statuses, todayIndex())].sort(taskComparator(this.columns(), this.vs));
    // 列の順序は、最初に描くときに設定のステータスの順序を取り込み、このビューに保存する。以後は設定の順序を変えても、このビューは変わらない。
    // 設定で足したステータスは末尾に増え、消したステータスの列は消える
    // the column order takes the settings' status order once, on the first draw, and keeps it in this view; changing the settings afterwards leaves the view alone.
    // A status added in the settings joins at the end, a deleted one drops out
    const order = orderStatusIds(statuses, this.cfg.columnOrder);
    if (order.join("\n") !== this.cfg.columnOrder.join("\n")) this.cfg.columnOrder = order;
    const board = host.createDiv({ cls: "ogantt-kanban" });
    // ステータスの列は、カードが 0 件でも残す（空の列にもカードを落とせるように）。未割当だけは、カードがあるときだけ出す
    // a status column stays even with no cards (so a card can still be dropped there); only Unassigned shows just when it has cards
    const cols = buildKanbanColumns(list, statuses, order).filter((c) => c.status !== null || c.cards.length > 0);
    // 手動の並び順：保存した順序のカードを先に、ないカードはビューの並べ替えの順で後ろに / manual order: cards in the saved order first, the rest after in the view's sort
    if (this.cfg.manualOrder) for (const c of cols) c.cards = applyManualOrder(c.cards, this.cfg.cardOrder[columnKey(c.status)] ?? []);
    this.kanbanCols = cols;
    const by = this.cfg.laneBy;
    if (by === "none") {
      for (const col of cols) this.renderKanbanColumn(board, col, cols);
      return;
    }
    // スイムレーン：列の見出しを上に 1 本、その下にレーンを縦に並べる。幅は固定なので、見出しと各レーンの列はそろう
    // swimlanes: one row of column headers on top, the lanes stacked below; the widths are fixed, so headers and every lane's columns line up
    board.addClass("is-lanes");
    const heads = board.createDiv({ cls: "ogantt-kcol-heads" });
    for (const col of cols) {
      const box = heads.createDiv({ cls: "ogantt-kcol-hbox" + (this.isColumnCollapsed(col) ? " is-collapsed" : "") });
      this.setColumnColor(box, col);
      this.renderKanbanHead(box, col, cols, box, board);
      this.attachColumnReorder(box, col);
    }
    for (const lane of splitLanes(cols, (t) => laneKeyOf(t, by))) this.renderKanbanLane(board, lane, by);
  }

  // レーンの名前：担当者なし・フォルダ直下は決まった表示 / a lane's name: fixed wording for "no assignee" and "top level"
  private laneLabel(key: string): string {
    if (key === UNASSIGNED_KEY) return tr().kanbanUnassigned;
    if (key === ROOT_LANE_KEY) return tr().kanbanLaneRoot;
    return key;
  }

  private renderKanbanLane(board: HTMLElement, lane: KanbanLane, by: LaneBy): void {
    const laneId = `${by}:${lane.key}`;
    const collapsed = this.cfg.collapsedLanes.includes(laneId);
    const laneEl = board.createDiv({ cls: "ogantt-klane" });
    const title = laneEl.createDiv({ cls: "ogantt-klane-title" });
    setIcon(title.createSpan({ cls: "ogantt-opt-ico" }), collapsed ? "chevron-right" : "chevron-down");
    title.createSpan({ cls: "ogantt-klane-name", text: this.laneLabel(lane.key) });
    title.createSpan({ cls: "ogantt-kcol-count", text: String(lane.count) });
    title.onclick = () => {
      this.cfg.collapsedLanes = toggleCollapsed(this.cfg.collapsedLanes, laneId);
      this.rerender();
    };
    if (collapsed) return;
    const row = laneEl.createDiv({ cls: "ogantt-klane-row" });
    for (const col of lane.columns) {
      const colCollapsed = this.isColumnCollapsed(col);
      const cell = row.createDiv({ cls: "ogantt-kcol" + (colCollapsed ? " is-collapsed" : "") });
      this.setColumnColor(cell, col);
      if (!colCollapsed) this.renderKanbanBody(cell, col, false);
      this.attachCardDrop(cell, col, lane.key);
    }
  }

  // スイムレーンの分け方のメニュー（ツールバーの「グループ」）/ the swimlane menu (the toolbar's "Group")
  private openLaneMenu(e: MouseEvent): void {
    const menu = new Menu();
    const add = (by: LaneBy, title: string): void => {
      menu.addItem((it) =>
        it.setTitle(title).setChecked(this.cfg.laneBy === by).onClick(() => {
          this.cfg.laneBy = by;
          this.rerender();
        })
      );
    };
    add("none", tr().noneLabel);
    add("assignee", tr().fieldAssignee);
    add("folder", tr().optGroupFolder);
    menu.showAtMouseEvent(e);
  }

  // 列の折りたたみを変えて保存する（描き直しのときに、ビューへ保存される）/ change the columns' collapse; saved with the view on the redraw
  private setCollapsedColumns(keys: string[]): void {
    this.cfg.collapsedColumns = keys;
    this.rerender();
  }

  // 列の見出しのメニュー：この列を折りたたむ／開く、空の列・すべてを折りたたむ、すべて開く
  // the column header menu: collapse / expand this column, collapse the empty ones or all, expand all
  private openColumnHeadMenu(e: MouseEvent, col: KanbanColumn, cols: KanbanColumn[]): void {
    const key = columnKey(col.status);
    const current = this.cfg.collapsedColumns;
    const menu = new Menu();
    menu.addItem((it) => it.setTitle(tr().kanbanCollapseCol).setIcon("fold-horizontal").onClick(() => this.setCollapsedColumns(toggleCollapsed(current, key))));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle(tr().kanbanCollapseEmpty).setIcon("fold-horizontal").onClick(() => this.setCollapsedColumns(collapseColumns(cols, current, "empty"))));
    menu.addItem((it) => it.setTitle(tr().kanbanCollapseAll).setIcon("fold-horizontal").onClick(() => this.setCollapsedColumns(collapseColumns(cols, current, "all"))));
    menu.addItem((it) => it.setTitle(tr().kanbanExpandAll).setIcon("unfold-horizontal").onClick(() => this.setCollapsedColumns(collapseColumns(cols, current, "none"))));
    menu.showAtMouseEvent(e);
  }

  private isColumnCollapsed(col: KanbanColumn): boolean {
    return this.cfg.collapsedColumns.includes(columnKey(col.status));
  }

  // 列の色＝ステータスの色 / the column's colour is the status's
  private setColumnColor(el: HTMLElement, col: KanbanColumn): void {
    const status = col.status ? this.plugin.settings.statuses.find((x) => x.id === col.status) : undefined;
    el.setCssProps({ "--ogantt-col": status?.color ?? "var(--text-faint)" });
  }

  // その列のステータスでタスクを作る（未割当の列ならステータスなし）/ create a task with this column's status (none for Unassigned)
  private addTaskIn(col: KanbanColumn): void {
    void this.createTaskWith({ status: col.status ?? undefined });
  }

  private renderKanbanColumn(board: HTMLElement, col: KanbanColumn, cols: KanbanColumn[]): void {
    const colEl = board.createDiv({ cls: "ogantt-kcol" + (this.isColumnCollapsed(col) ? " is-collapsed" : "") });
    this.setColumnColor(colEl, col);
    this.renderKanbanHead(colEl, col, cols, colEl, board);
    if (!this.isColumnCollapsed(col)) this.renderKanbanBody(colEl, col, true);
    this.attachColumnReorder(colEl, col);
    this.attachCardDrop(colEl, col, null);
  }

  // 列の見出し：色の点・名前・件数、「＋」と「⋯」（折りたたんだ列は、クリックで開く）。ドラッグで列の順序を入れ替える（ドラッグ中の見た目は reorderEl に付ける）
  // the column header: dot, name, count, "+" and "⋯" (a collapsed column opens on a click); dragging it reorders the columns (the drag styling goes on reorderEl)
  private renderKanbanHead(box: HTMLElement, col: KanbanColumn, cols: KanbanColumn[], reorderEl: HTMLElement, board: HTMLElement): void {
    const status = col.status ? this.plugin.settings.statuses.find((s) => s.id === col.status) : undefined;
    const key = columnKey(col.status);
    const collapsed = this.isColumnCollapsed(col);
    const head = box.createDiv({ cls: "ogantt-kcol-head" });
    head.createSpan({ cls: "ogantt-kcol-dot" });
    head.createSpan({ cls: "ogantt-kcol-name", text: status?.label ?? tr().kanbanUnassigned });
    head.createSpan({ cls: "ogantt-kcol-count", text: String(col.cards.length) });
    if (collapsed) {
      // 折りたたんだ列：帯の中は、色の点・件数・名前（縦）だけ。見出しのクリックで開く。カードを落とすこともできる
      // a collapsed column: just the colour dot, count and the name (vertical); clicking the header opens it, and cards can still be dropped on it
      head.setAttr("aria-label", tr().kanbanExpandCol);
      head.addClass("is-collapsed-head");
      head.onclick = () => this.setCollapsedColumns(toggleCollapsed(this.cfg.collapsedColumns, key));
      return;
    }
    const plus = head.createSpan({ cls: "ogantt-kcol-add" });
    setIcon(plus, "plus");
    plus.setAttr("aria-label", tr().kanbanAddTask);
    plus.onclick = () => this.addTaskIn(col);
    const more = head.createSpan({ cls: "ogantt-kcol-menu" });
    setIcon(more, "ellipsis");
    more.setAttr("aria-label", tr().kanbanColMenu);
    more.onclick = (e) => this.openColumnHeadMenu(e, col, cols);
    // 見出しをドラッグして、列の順序を入れ替える。順序はこのビューに保存する（初期値は設定のステータスの順）。未割当は先頭に固定
    // drag the header to reorder the columns; the order is saved in this view (it starts from the settings' status order); Unassigned stays first
    if (col.status !== null) {
      const id = col.status;
      head.addClass("is-draggable");
      head.setAttr("draggable", "true");
      head.addEventListener("dragstart", (e) => {
        this.dragColumn = id;
        e.dataTransfer?.setData("text/plain", id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        reorderEl.addClass("is-col-dragging");
      });
      head.addEventListener("dragend", () => {
        this.dragColumn = null;
        board.querySelectorAll(".is-col-dragging, .is-col-before, .is-col-after").forEach((el) => el.removeClasses(["is-col-dragging", "is-col-before", "is-col-after"]));
      });
    }
  }

  // 列のカード（とレーンの外では「＋ タスクを追加」）/ a column's cards (and, outside the lanes, the "+ Add task" button)
  private renderKanbanBody(colEl: HTMLElement, col: KanbanColumn, withAdd: boolean): void {
    const body = colEl.createDiv({ cls: "ogantt-kcol-body" });
    for (const t of col.cards) this.renderKanbanCard(body, t);
    if (!withAdd) return;
    const addBtn = body.createEl("button", { cls: "ogantt-kcol-addbtn" });
    setIcon(addBtn.createSpan({ cls: "ogantt-opt-ico" }), "plus");
    addBtn.createSpan({ text: tr().kanbanAddTask });
    addBtn.onclick = () => this.addTaskIn(col);
  }

  // 列の入れ替えのドロップ先：左半分なら前、右半分なら後ろに入る / the drop target of a column reorder: the left half inserts before, the right half after
  private attachColumnReorder(el: HTMLElement, col: KanbanColumn): void {
    const dropAfter = (e: DragEvent): boolean => {
      const r = el.getBoundingClientRect();
      return e.clientX > r.left + r.width / 2;
    };
    el.addEventListener("dragover", (e) => {
      if (!this.dragColumn) return;
      if (col.status === null || col.status === this.dragColumn) return;
      e.preventDefault();
      const after = dropAfter(e);
      el.toggleClass("is-col-after", after);
      el.toggleClass("is-col-before", !after);
    });
    el.addEventListener("dragleave", (e) => {
      if (el.contains(e.relatedTarget as Node | null)) return;
      el.removeClasses(["is-col-before", "is-col-after"]);
    });
    el.addEventListener("drop", (e) => {
      if (!this.dragColumn) return;
      e.preventDefault();
      el.removeClasses(["is-col-before", "is-col-after"]);
      const from = this.dragColumn;
      this.dragColumn = null;
      if (col.status !== null) this.reorderColumn(from, col.status, dropAfter(e));
    });
  }

  // カードのドロップ先：この列のステータスになり、落とした位置に入る。レーンの中なら、担当者のレーンは担当者も書き換わる。フォルダのレーンへは、ファイルの移動になるので落とせない
  // the drop target of a card: it takes this column's status and goes in where it was dropped; inside an assignee lane it takes that assignee too; a card can't be dropped into another folder's lane (that would move the file)
  private attachCardDrop(el: HTMLElement, col: KanbanColumn, laneKey: string | null): void {
    const allowed = (): boolean => {
      if (!this.dragPath) return false;
      if (laneKey === null || this.cfg.laneBy !== "folder") return true;
      const t = this.tasks.find((x) => x.path === this.dragPath);
      return !!t && laneKeyOf(t, "folder") === laneKey;
    };
    // 落とす位置：ポインタがカードの上なら、そのカードの前・後ろ・真ん中（サブタスクにする）。カードの間や空きなら、ポインタより下で最初のカードの前、無ければ最後のカードの後ろ（カードが無ければ末尾）。ドラッグ中のカード自身は数えない
    // the drop slot: over a card it is before, after or the middle of it (make a subtask); between cards or in the empty part, before the first card below the pointer, else after the last card (the end when there are none); the dragged card itself doesn't count
    const slotAt = (e: DragEvent): { ref: HTMLElement | null; after: boolean; child: boolean } => {
      const cards = Array.from(el.querySelectorAll<HTMLElement>(".ogantt-kcol-body > .ogantt-kcard")).filter((c) => c.dataset.path !== this.dragPath);
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY > r.bottom) continue;
        const zone = cardZone(e.clientY, r.top, r.height);
        return { ref: c, after: zone === "after", child: zone === "child" };
      }
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) return { ref: c, after: false, child: false };
      }
      return { ref: cards[cards.length - 1] ?? null, after: true, child: false };
    };
    const clearMarks = (): void => el.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-child").forEach((c) => c.removeClasses(["is-drop-before", "is-drop-after", "is-drop-child"]));
    el.addEventListener("dragover", (e) => {
      if (this.dragColumn || !allowed()) return;
      e.preventDefault();
      el.addClass("is-drop");
      clearMarks();
      const slot = slotAt(e);
      slot.ref?.addClass(slot.child ? "is-drop-child" : slot.after ? "is-drop-after" : "is-drop-before");
    });
    el.addEventListener("dragleave", (e) => {
      if (el.contains(e.relatedTarget as Node | null)) return;
      el.removeClass("is-drop");
      clearMarks();
    });
    el.addEventListener("drop", (e) => {
      el.removeClass("is-drop");
      if (this.dragColumn) return;
      e.preventDefault();
      const ok = allowed();
      const slot = slotAt(e);
      clearMarks();
      const path = this.dragPath;
      this.dragPath = null;
      if (!path || !ok) return;
      const refPath = slot.ref?.dataset.path ?? null;
      // カードの真ん中に落とした＝そのカードのサブタスクにする（親と同じフォルダへ移る。取り消せる）/ dropped on the middle of a card = make it that card's subtask (it moves into the parent's folder; undoable)
      if (slot.child && refPath) {
        this.kanbanExpanded.add(refPath); // 入ったサブタスクが見えるように、親のカードを開く / open the parent's card so the new subtask shows
        void this.reparentTo(path, this.taskFolder(refPath), refPath);
        return;
      }
      void this.moveTaskToCell(path, col.status, laneKey, { ref: refPath, after: slot.after });
    });
  }

  // 列を入れ替える＝このビューの列の順序を保存する。設定のステータスの順序は変えない
  // reordering a column saves this view's column order; the settings' status order is left alone
  private reorderColumn(fromId: string, targetId: string, after: boolean): void {
    const next = moveId(orderStatusIds(this.plugin.settings.statuses, this.cfg.columnOrder), fromId, targetId, after);
    if (!next) return;
    this.cfg.columnOrder = next;
    this.rerender(); // 描き直しのときに、ビューへ保存される / saved with the view on the redraw
  }

  // カードの項目：選んだ列の中身を、表と同じ描き方でそのまま出す（既定は担当・開始・期限）。値の無い項目は出さない。サブタスクの行でも同じものを使う
  // card fields: the chosen columns painted just as the table does (assignee, start and due by default); an empty value is left out. The subtask rows use it too
  private paintCardFields(host: HTMLElement, t: Task): void {
    const fields = host.createDiv({ cls: "ogantt-kcard-fields" });
    const defs = this.columns();
    for (const id of this.cfg.cardFields) {
      const def = defs.find((c) => c.id === id);
      if (!def || def.kind !== "cell") continue;
      const field = fields.createDiv({ cls: "ogantt-kfield" });
      const value = field.createSpan({ cls: "ogantt-kfield-value" });
      def.paint(this.board, value, { kind: "task", group: "", depth: 0, task: t });
      if (!value.hasChildNodes()) {
        field.remove();
        continue;
      }
      field.insertBefore(createSpan({ cls: "ogantt-kfield-label", text: def.label() }), value);
    }
    if (!fields.hasChildNodes()) fields.remove();
  }

  private renderKanbanCard(body: HTMLElement, t: Task): void {
    const card = body.createDiv({ cls: "ogantt-kcard", attr: { "data-path": t.path, draggable: "true" } });
    if (this.selectedPath === t.path && this.detailEl?.hasClass("is-open")) card.addClass("is-selected");
    card.createDiv({ cls: "ogantt-kcard-title", text: t.name });
    const more = card.createSpan({ cls: "ogantt-kcard-more" });
    setIcon(more, "ellipsis");
    more.setAttr("aria-label", tr().kanbanCardMenu);
    more.onclick = (e) => {
      e.stopPropagation();
      this.openCardMenu(e, t);
    };
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCardMenu(e, t);
    });
    this.paintCardFields(card, t);
    // サブタスク：件数のアイコンを押すと、カードの中に開く / subtasks: the count icon opens them inside the card
    const subs = subtasksOf(this.tasks, t.path);
    if (subs.length) {
      const open = this.kanbanExpanded.has(t.path);
      const bar = card.createDiv({ cls: "ogantt-kcard-subs" + (open ? " is-open" : "") });
      setIcon(bar.createSpan({ cls: "ogantt-opt-ico" }), "list-tree");
      bar.createSpan({ text: String(subs.length) });
      bar.setAttr("aria-label", tr().kanbanSubtasks(subs.length));
      bar.onclick = (e) => {
        e.stopPropagation();
        if (open) this.kanbanExpanded.delete(t.path);
        else this.kanbanExpanded.add(t.path);
        this.rerender();
      };
      if (open) {
        for (const sub of subs) {
          const row = card.createDiv({ cls: "ogantt-ksub" });
          const head = row.createDiv({ cls: "ogantt-ksub-head" });
          head.createSpan({ cls: "ogantt-ksub-name", text: sub.name });
          const st = this.plugin.settings.statuses.find((x) => x.id === sub.status);
          if (st) {
            const chip = head.createSpan({ cls: "ogantt-ksub-status", text: st.label });
            chip.setCssProps({ "--ogantt-col": st.color });
          }
          this.paintCardFields(row, sub); // 親のカードと同じ項目 / the same fields as the parent card
          row.onclick = (e) => {
            e.stopPropagation();
            void this.openDetail(sub.path);
          };
          // 右クリックで、親から切り離す（独立したカードに戻る）/ right-click detaches it from its parent (it becomes a card of its own again)
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            menu.addItem((it) => it.setTitle(tr().kanbanDetachSub).setIcon("unlink").onClick(() => void this.reparentTo(sub.path, this.taskFolder(sub.path), null)));
            menu.showAtMouseEvent(e);
          });
        }
      }
    }
    card.onclick = () => void this.openDetail(t.path);
    card.addEventListener("dragstart", (e) => {
      this.dragPath = t.path;
      e.dataTransfer?.setData("text/plain", t.path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      this.dragPath = null;
      card.removeClass("is-dragging");
      body.ownerDocument.querySelectorAll(".ogantt-kcol.is-drop").forEach((el) => el.removeClass("is-drop"));
      body.ownerDocument.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-child").forEach((el) => el.removeClasses(["is-drop-before", "is-drop-after", "is-drop-child"]));
    });
  }

  // カードのメニュー（⋯ か右クリック）：サブタスクを追加・削除 / the card menu (the dots or a right-click): add a subtask, delete
  private openCardMenu(e: MouseEvent, t: Task): void {
    const menu = new Menu();
    menu.addItem((it) => it.setTitle(tr().kanbanAddSubtask).setIcon("plus").onClick(() => void this.createTaskWith({ parentPath: t.path })));
    if (t.parent) menu.addItem((it) => it.setTitle(tr().kanbanDetachSub).setIcon("unlink").onClick(() => void this.reparentTo(t.path, this.taskFolder(t.path), null)));
    menu.addSeparator();
    menu.addItem((it) => it.setTitle(tr().menuDelete).setIcon("trash-2").onClick(() => this.confirmDelete(t.path)));
    menu.showAtMouseEvent(e);
  }

  // カードを別の列へ動かす＝ステータスを書き換える（取り消せる）。未割当の列へ動かすとステータスを外す
  // moving a card to another column rewrites its status (undoable); the unassigned column clears it
  private async moveTaskToStatus(path: string, status: string | null): Promise<void> {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const known = this.plugin.settings.statuses.some((s) => s.id === t.status);
    const current = known ? (t.status ?? null) : null;
    if (current === status) return;
    await this.mutate(tr().undoEdit(t.name), [path], () => writeField(this.app, path, this.plugin.settings.keys.status, status ?? undefined));
    await this.refresh();
  }

  // カードを列（とレーン）の、落とした位置へ動かす：ステータスを書き換え、担当者のレーンなら担当者も書き換える（1 回の取り消しで両方戻る）。
  // 位置は、このビューの手動の順序として保存し、ビューを「手動」にする（順序の変更は、取り消しの対象ではない）
  // move a card to the dropped place in a column (and lane): rewrites the status, and the assignee for an assignee lane (one undo restores both).
  // The place is saved as the view's manual order and the view switches to "Manual" (an order change isn't undoable)
  private async moveTaskToCell(path: string, status: string | null, laneKey: string | null, slot: { ref: string | null; after: boolean }): Promise<void> {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const known = this.plugin.settings.statuses.some((s) => s.id === t.status);
    const from = known ? (t.status ?? null) : null;
    const statusChanged = from !== status;
    const byAssignee = laneKey !== null && this.cfg.laneBy === "assignee";
    const assigneeChanged = byAssignee && laneKeyOf(t, "assignee") !== laneKey;
    const moved = statusChanged || assigneeChanged;
    // 手動の順序：落とした列の今の並びを土台に、位置を決める / the manual order: the dropped column's current order is the base for the new place
    const key = columnKey(status);
    const shown = (this.kanbanCols.find((c) => columnKey(c.status) === key)?.cards ?? []).map((c) => c.path);
    const prev = this.cfg.cardOrder[key] ?? [];
    const next = placeInOrder(prev, shown, path, slot.ref, slot.after).filter((p) => this.app.vault.getAbstractFileByPath(p) !== null); // 消えたノートは捨てる / drop notes that are gone
    const sameSpot = next.filter((p) => shown.includes(p)).join("\n") === shown.join("\n");
    if (!moved && sameSpot) return;
    this.cfg.cardOrder[key] = next;
    if (statusChanged) {
      const old = columnKey(from);
      const left = (this.cfg.cardOrder[old] ?? []).filter((p) => p !== path);
      if (left.length) this.cfg.cardOrder[old] = left;
      else delete this.cfg.cardOrder[old];
    }
    this.cfg.manualOrder = true;
    if (!moved) {
      this.rerender(); // 描き直しのときに、ビューへ保存される / saved with the view on the redraw
      return;
    }
    const keys = this.plugin.settings.keys;
    await this.mutate(tr().undoEdit(t.name), [path], async () => {
      if (statusChanged) await writeField(this.app, path, keys.status, status ?? undefined);
      if (assigneeChanged) await writeField(this.app, path, keys.assignee, laneKey === UNASSIGNED_KEY ? undefined : laneKey);
    });
    await this.refresh();
  }

  // 並べ替えのメニュー（ツールバーの「並べ替え」）：手動、または列を選んで昇順・降順 / the sort menu (the toolbar's "Sort"): manual, or a column in ascending or descending order
  private openSortMenu(e: MouseEvent): void {
    const menu = new Menu();
    const set = (fn: () => void): void => {
      fn();
      this.rerender();
    };
    menu.addItem((it) => it.setTitle(tr().kanbanSortManual).setChecked(this.cfg.manualOrder).onClick(() => set(() => (this.cfg.manualOrder = true))));
    menu.addSeparator();
    for (const def of this.columns()) {
      menu.addItem((it) =>
        it.setTitle(def.id === "name" ? tr().kanbanSortTitle : def.label()).setChecked(!this.cfg.manualOrder && this.cfg.sortBy === def.id).onClick(() =>
          set(() => {
            this.cfg.manualOrder = false;
            this.cfg.sortBy = def.id;
          })
        )
      );
    }
    menu.addSeparator();
    for (const dir of ["asc", "desc"] as const) {
      menu.addItem((it) =>
        it.setTitle(dir === "asc" ? tr().kanbanSortAsc : tr().kanbanSortDesc).setChecked(!this.cfg.manualOrder && this.cfg.sortDir === dir).onClick(() =>
          set(() => {
            this.cfg.manualOrder = false;
            this.cfg.sortDir = dir;
          })
        )
      );
    }
    menu.showAtMouseEvent(e);
  }

  // カードに出す項目：表の「列の表示」と同じ形（チェックボックス）。ステータスは列そのものなので除く
  // the card fields: checkboxes like the table's column menu; status is the column itself, so it's left out
  private openCardFieldsMenu(anchor: HTMLElement): void {
    this.openPopover(anchor, "ogantt-colmenu", (menu) => {
      for (const col of this.columns()) {
        if (col.kind !== "cell" || col.id === "status") continue;
        const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
        const cb = item.createEl("input", { type: "checkbox" });
        cb.checked = this.cfg.cardFields.includes(col.id);
        item.createSpan({ text: col.label() });
        cb.addEventListener("change", () => {
          const set = new Set(this.cfg.cardFields);
          if (cb.checked) set.add(col.id);
          else set.delete(col.id);
          this.cfg.cardFields = this.columns().filter((c) => c.kind === "cell" && c.id !== "status" && set.has(c.id)).map((c) => c.id); // 定義順を保つ / keep the definition order
          this.rerender();
        });
      }
    });
  }

  // ----- テーブル列 / table columns -----
  // 表示中の列（name は常時、その他は設定の visibleColumns に従う）/ visible columns (name always; rest per settings)
  private visibleColumns(): ColumnDef[] {
    return visibleColumns(this.columns(), this.vs.visibleColumns ?? []);
  }
  // 全列の定義（組み込み→Custom field の順）。Custom field の構成が変わったときだけ作り直す
  // every column definition (built-ins, then custom fields); rebuilt only when the custom fields change
  private columnCache: { sig: string; cols: ColumnDef[] } | null = null;
  private columns(): ColumnDef[] {
    const fields = validCustomFields(this.plugin.settings);
    const sig = JSON.stringify(fields);
    if (this.columnCache?.sig !== sig) {
      this.columnCache = { sig, cols: [...BUILTIN_COLUMNS, ...fields.map(customColumn)] };
    }
    return this.columnCache.cols;
  }
  // 表全体の幅（表示中の列幅の合計）/ total table width (sum of visible column widths)
  private tableWidth(): number {
    return this.visibleColumns().reduce((w, c) => w + this.colW(c.id), 0);
  }

  // 列の実効幅（ユーザー上書き > 既定）/ effective column width (user override > default)
  private colW(id: string): number {
    const def = this.columns().find((c) => c.id === id);
    return def ? columnWidth(def, this.vs.columnWidths) : 0;
  }

  // 列幅を内容に合わせて自動フィット（グリップのWクリック）。一時的に max-content にして実測する
  // auto-fit a column to its content (grip double-press): measure by temporarily sizing cells to max-content
  private autoFitColumn(id: string, nth: number, th: HTMLElement): void {
    const cells: HTMLElement[] = [th];
    this.tbodyEl
      ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
      .forEach((el) => cells.push(el));
    // 計測中はインライン幅を外して計測用クラスを付与（!important を使わないため）
    // remove inline widths while measuring so the measuring class applies without !important
    const saved = cells.map((el) => el.style.width);
    cells.forEach((el) => {
      el.style.removeProperty("width");
      el.addClass("ogantt-measure");
    });
    const w = Math.max(40, ...cells.map((el) => el.offsetWidth)) + 2;
    cells.forEach((el, i) => {
      el.removeClass("ogantt-measure");
      el.style.width = saved[i];
    });
    this.vs.columnWidths[id] = w;
    void this.plugin.saveSettings(); // 保存（ビューも再描画される）/ persist (views refresh)
  }
  // 列ヘッダクリックでソート列/方向を切替えて永続化 / clicking a header toggles sort column/direction (persisted)
  private toggleSort(id: string): void {
    const s = this.vs;
    if (s.sortBy === id) s.sortDir = s.sortDir === "asc" ? "desc" : "asc";
    else {
      s.sortBy = id;
      s.sortDir = "asc";
    }
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 列の表示/非表示を切替えて永続化 / toggle a column's visibility and persist
  private setColumnVisible(id: string, on: boolean): void {
    const set = new Set(this.vs.visibleColumns ?? []);
    if (on) set.add(id);
    else set.delete(id);
    this.vs.visibleColumns = this.columns().filter((c) => c.optional && set.has(c.id)).map((c) => c.id); // 定義順を維持 / keep definition order
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 汎用ポップオーバー：anchor の直下に開き、外側クリック/Esc で閉じる。中身は build が構築する。
  // 同じ cls の既存ポップオーバーは開く前に閉じる（同時に1つ）。リスナは close で必ず解除。
  // generic popover under `anchor`, closed on outside-click/Esc; `build` fills it and receives `close`.
  // any existing popover with the same cls is removed first (one at a time); listeners are always released in close.
  private openPopover(anchor: HTMLElement, cls: string, build: (menu: HTMLElement, close: () => void) => void): void {
    activeDocument.querySelectorAll(`.${cls}`).forEach((e) => e.remove());
    const menu = activeDocument.body.createDiv({ cls });
    const close = () => {
      menu.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!menu.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    build(menu, close);
    // 中身を作ってから寸法を測って位置決め。anchor の下に置き、画面外に出るなら上へ反転する
    // （表の行から開くとき、下の行では下に収まらない）/ measure after building, then place below the
    // anchor, flipping above when it would overflow (lower table rows have no room below)
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight) top = Math.max(4, r.top - menu.offsetHeight - 4);
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);
  }

  // 列の出し分けポップオーバー（チェックボックス）/ column-visibility popover (checkboxes)
  // 「表示」メニュー：チェックの入り切り（列メニューと同じ見た目）。フラットを切り替えるとフォルダ用の項目が出入りするので、そのたびに中身を作り直す
  // the Display menu: checkboxes, looking like the column menu; flat view adds or removes the folder-only items, so the contents are rebuilt on each change
  private openDisplayMenu(anchor: HTMLElement): void {
    this.openPopover(anchor, "ogantt-colmenu", (menu) => {
      const fill = (): void => {
        menu.empty();
        const folderOnly = this.groupBy === "folder" && !this.flat; // 空フォルダとロールアップはフォルダでグループ化しているときだけ / empty folders and roll up need folder grouping
        const toggles: { icon: string; label: string; show: boolean; get: () => boolean; set: (v: boolean) => void }[] = [
          { icon: "folder", label: tr().optShowEmpty, show: folderOnly, get: () => this.showEmptyFolders, set: (v) => (this.showEmptyFolders = v) },
          { icon: "git-merge", label: tr().optRollup, show: folderOnly, get: () => this.rollup, set: (v) => (this.rollup = v) },
          { icon: "list", label: tr().optFlat, show: true, get: () => this.flat, set: (v) => (this.flat = v) },
          { icon: "zap", label: tr().optProgressLine, show: this.activeType() !== "table", get: () => this.progressLine, set: (v) => (this.progressLine = v) },
          { icon: "eye-off", label: tr().optHideLabels, show: this.activeType() !== "table", get: () => this.hideLabels, set: (v) => (this.hideLabels = v) },
          { icon: "alarm-clock", label: tr().optOverdue, show: true, get: () => this.markOverdue, set: (v) => (this.markOverdue = v) },
        ];
        for (const it of toggles.filter((x) => x.show)) {
          const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
          const cb = item.createEl("input", { type: "checkbox" });
          cb.checked = it.get();
          setIcon(item.createSpan({ cls: "ogantt-opt-ico" }), it.icon);
          item.createSpan({ text: it.label });
          cb.addEventListener("change", () => {
            it.set(cb.checked);
            this.rerender();
            fill();
          });
        }
      };
      fill();
    });
  }

  private openColumnMenu(anchor: HTMLElement): void {
    this.openPopover(anchor, "ogantt-colmenu", (menu) => {
      for (const col of this.columns().filter((c) => c.optional)) {
        const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
        const cb = item.createEl("input", { type: "checkbox" });
        cb.checked = (this.vs.visibleColumns ?? []).includes(col.id);
        item.createSpan({ text: col.label() });
        cb.addEventListener("change", () => this.setColumnVisible(col.id, cb.checked));
      }
    });
  }

  // ----- 統合フィルタ（ステータス/担当者/タグ/開始日/期限日）/ unified filter -----

  // 保存＋盤面再描画（ポップオーバーは body 上なので残る）/ save + redraw board (popovers survive on body)
  private commitFilters(): void {
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 日付演算子ラベル / date operator label
  private dateOpLabel(op: DateOp): string {
    const s = tr();
    switch (op) {
      case "is": return s.dfOpIs;
      case "before": return s.dfOpBefore;
      case "after": return s.dfOpAfter;
      case "onOrBefore": return s.dfOpOnOrBefore;
      case "onOrAfter": return s.dfOpOnOrAfter;
      case "empty": return s.dfOpEmpty;
      case "notEmpty": return s.dfOpNotEmpty;
    }
  }
  // カテゴリ演算子ラベル / category operator label
  private catOpLabel(op: CategoryOp): string {
    const s = tr();
    switch (op) {
      case "is": return s.dfOpIs;
      case "isNot": return s.dfOpIsNot;
      case "empty": return s.dfOpEmpty;
      case "notEmpty": return s.dfOpNotEmpty;
    }
  }
  // 単位ラベル / relative unit label
  private dateUnitLabel(u: DateUnit): string {
    return u === "day" ? tr().dfDay : u === "week" ? tr().dfWeek : tr().dfMonth;
  }
  // テキスト（名前）演算子ラベル / text (name) operator label
  private textOpLabel(op: TextOp): string {
    const s = tr();
    switch (op) {
      case "is": return s.dfOpIs;
      case "isNot": return s.dfOpIsNot;
      case "contains": return s.textOpContains;
      case "notContains": return s.textOpNotContains;
      case "startsWith": return s.textOpStartsWith;
      case "endsWith": return s.textOpEndsWith;
    }
  }
  // フィルタのフィールド名 / a filter's field label
  private filterFieldLabel(f: Filter): string {
    if (f.kind === "date") return f.field === "start" ? tr().fieldStart : tr().fieldDue;
    if (f.kind === "text") return tr().fieldName;
    switch (f.field) {
      case "status": return tr().fieldStatus;
      case "statusGroup": return tr().fieldStatusGroup;
      case "assignee": return tr().fieldAssignee;
      case "tag": return tr().fieldTags;
    }
  }
  // チップ/メニューのアイコン / chip & menu icon
  private filterIcon(f: Filter): string {
    if (f.kind === "date") return "calendar";
    if (f.kind === "text") return "type";
    switch (f.field) {
      case "status": return "filter";
      case "statusGroup": return "flag";
      case "assignee": return "user";
      case "tag": return "tag";
    }
  }
  // カテゴリ値のラベル（""＝未設定、ステータスは id→ラベル）/ a category value's label ("" = unset; status maps id→label)
  private catValueLabel(field: CategoryField, value: string): string {
    if (value === "") return tr().noneLabel; // 未設定 / unset
    if (field === "status") return this.plugin.settings.statuses.find((s) => s.id === value)?.label ?? value;
    if (field === "statusGroup") return statusGroupLabel(value as StatusGroup);
    return value;
  }
  // カテゴリの選択肢＋末尾に「未設定(")」/ available category values, plus an "unset" ("") entry at the end
  private filterFieldValues(field: CategoryField): [string, string][] {
    let base: [string, string][];
    if (field === "status") base = this.plugin.settings.statuses.map((s) => [s.id, s.label] as [string, string]);
    // グループは 4 固定なので、そのグループを使っているステータスが 1 つも無くても全部出す
    // the four groups are fixed, so list them all even when no status currently uses one
    else if (field === "statusGroup") base = STATUS_GROUPS.map((g) => [g, statusGroupLabel(g)] as [string, string]);
    else if (field === "assignee") base = [...new Set(this.tasks.map((t) => t.assignee).filter((a): a is string => !!a))].sort().map((a) => [a, linkLabel(a)] as [string, string]);
    else base = [...new Set(this.tasks.flatMap((t) => t.tags))].sort().map((tg) => [tg, tg] as [string, string]);
    return [...base, ["", tr().noneLabel]]; // 「未設定」を選べるように / allow filtering by "unset"
  }

  // チップに出す 1 行サマリー / one-line chip summary
  private filterSummary(f: Filter): string {
    const field = this.filterFieldLabel(f);
    if (f.kind === "date") {
      const op = this.dateOpLabel(f.op);
      const v = f.value;
      let val = "";
      if (v) {
        const fmt = this.plugin.settings.dateFormat;
        if (v.kind === "preset") val = v.preset === "today" ? tr().today : v.preset === "yesterday" ? tr().dfYesterday : tr().dfTomorrow;
        else if (v.kind === "specific") val = formatDate(v.date, fmt);
        else if (v.kind === "relative") val = `${v.amount} ${this.dateUnitLabel(v.unit)} ${v.dir === "ago" ? tr().dfAgo : tr().dfFromNow}`;
        else val = `${formatDate(v.from, fmt)} ${tr().dfRangeTo} ${formatDate(v.to, fmt)}`;
      }
      return val ? `${field}: ${op} ${val}` : `${field}: ${op}`;
    }
    if (f.kind === "text") {
      const q = f.value.trim();
      return q ? `${field}: ${this.textOpLabel(f.op)} "${q}"` : `${field}: ${this.textOpLabel(f.op)}`;
    }
    if (f.op === "empty" || f.op === "notEmpty") return `${field}: ${this.catOpLabel(f.op)}`;
    const shown = f.values.length ? f.values.map((v) => this.catValueLabel(f.field, v)).join(", ") : "…";
    return f.op === "isNot" ? `${field}: ${this.catOpLabel("isNot")} ${shown}` : `${field}: ${shown}`;
  }

  // 統合フィルタ行：追加ボタン＋チップ＋一致条件トグル / the filter row: add button + chips + match toggle
  private renderFilterBar(): void {
    const host = this.filterHost;
    host.empty();
    const s = this.vs;
    const filters = s.filters;
    // 行頭のラベル（フィルタ行だと分かる見出し）/ a leading label so the row reads as "Filters"
    setIcon(host.createSpan({ cls: "ogantt-filterbar-ico" }), "filter");
    host.createSpan({ cls: "ogantt-filterbar-label", text: tr().dfLabel });
    // プリセット（左・枠の外）/ presets (left, outside the frame)
    const presetBtn = host.createEl("button", { cls: "ogantt-preset-btn clickable-icon" });
    setIcon(presetBtn.createSpan({ cls: "ogantt-opt-ico" }), "bookmark");
    presetBtn.createSpan({ text: tr().presetLabel });
    setIcon(presetBtn.createSpan({ cls: "ogantt-preset-caret" }), "chevron-down");
    presetBtn.onclick = () => this.openPresetMenu(presetBtn);
    // 絞り込み本体を枠で囲む（Wrike 風）：追加ボタン＋チップ / a bordered group holding add-button + chips
    const group = host.createDiv({ cls: "ogantt-filter-group" });
    // フィルタ追加 / add a filter
    const add = group.createEl("button", { cls: "ogantt-filter-add clickable-icon" });
    setIcon(add.createSpan({ cls: "ogantt-opt-ico" }), "list-filter");
    add.createSpan({ text: tr().dfAdd });
    add.onclick = () => this.openAddFilterMenu(add);
    // 適用中フィルタのチップ（クリックで編集／×で削除）/ active-filter chips (click to edit, × to remove)
    filters.forEach((f, i) => {
      const chip = group.createDiv({ cls: "ogantt-filter-chip" });
      setIcon(chip.createSpan({ cls: "ogantt-filter-chip-ico" }), this.filterIcon(f));
      chip.createSpan({ text: this.filterSummary(f) });
      const x = chip.createSpan({ cls: "ogantt-filter-chip-x" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().dfRemove);
      chip.onclick = (e) => { if (x.contains(e.target as Node)) return; this.openFilterEditor(chip, i); };
      x.onclick = (e) => { e.stopPropagation(); filters.splice(i, 1); this.commitFilters(); };
    });
    // 2 件以上のとき、右端に AND/OR トグル / with 2+ filters, a match-all/any toggle on the right
    if (filters.length >= 2) {
      const match = host.createDiv({ cls: "ogantt-filter-match" });
      match.createSpan({ cls: "ogantt-filter-match-label", text: tr().dfMatchLabel });
      const sel = match.createEl("select");
      for (const [val, text] of [["all", tr().dfMatchAll], ["any", tr().dfMatchAny]] as [FilterMatch, string][]) {
        const o = sel.createEl("option", { text, value: val });
        if (val === s.filterMatch) o.selected = true;
      }
      sel.onchange = () => { s.filterMatch = sel.value as FilterMatch; this.commitFilters(); };
    }
  }

  // 「フィルタを追加」→ 項目選択メニュー / "Add filter" → field picker
  private openAddFilterMenu(anchor: HTMLElement): void {
    const m = new Menu();
    // 名前（テキスト）/ name (text)
    m.addItem((i) => i.setTitle(tr().fieldName).setIcon("type").onClick(() => {
      this.vs.filters.push({ kind: "text", field: "name", op: "contains", value: "" });
      this.commitFilters();
      this.openLastFilterEditor();
    }));
    const addCat = (field: CategoryField, label: string, icon: string) => {
      m.addItem((i) => i.setTitle(label).setIcon(icon).onClick(() => {
        this.vs.filters.push({ kind: "category", field, op: "is", values: [] });
        this.commitFilters();
        this.openLastFilterEditor();
      }));
    };
    addCat("status", tr().fieldStatus, "filter");
    addCat("statusGroup", tr().fieldStatusGroup, "flag");
    addCat("assignee", tr().fieldAssignee, "user");
    if (this.tasks.some((t) => t.tags.length > 0)) addCat("tag", tr().fieldTags, "tag");
    const addDate = (field: DateField, label: string) => {
      m.addItem((i) => i.setTitle(label).setIcon("calendar").onClick(() => {
        this.vs.filters.push({ kind: "date", field, op: "onOrAfter", value: { kind: "preset", preset: "today" } });
        this.commitFilters();
        this.openLastFilterEditor();
      }));
    };
    addDate("start", tr().fieldStart);
    addDate("end", tr().fieldDue);
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom + 4 });
  }

  // 追加直後、最後のフィルタのエディタを開く / open the just-added filter's editor
  private openLastFilterEditor(): void {
    const chips = this.filterHost.querySelectorAll(".ogantt-filter-chip");
    const last = chips[chips.length - 1] as HTMLElement | undefined;
    if (last) this.openFilterEditor(last, this.vs.filters.length - 1);
  }

  // 組み込みプリセット（コード内蔵・削除不可・名前は表示言語で都度生成）/ built-in presets (not deletable)
  private builtinPresets(): FilterPreset[] {
    const today: DateValue = { kind: "preset", preset: "today" };
    return [
      // 日付なし＝開始も期限も未設定（＝ガントバーが出ない）/ no start and no end → no bar
      { name: tr().presetNoDates, filterMatch: "all", filters: [
        { kind: "date", field: "start", op: "empty" },
        { kind: "date", field: "end", op: "empty" },
      ] },
      // 日付あり＝開始 or 期限がある / has a start or an end
      { name: tr().presetHasDates, filterMatch: "any", filters: [
        { kind: "date", field: "start", op: "notEmpty" },
        { kind: "date", field: "end", op: "notEmpty" },
      ] },
      // 期限切れ＝期限が今日より前 / due before today
      { name: tr().presetOverdue, filterMatch: "all", filters: [
        { kind: "date", field: "end", op: "before", value: today },
      ] },
      // 未割り当て＝担当者なし / no assignee
      { name: tr().presetUnassigned, filterMatch: "all", filters: [
        { kind: "category", field: "assignee", op: "empty", values: [] },
      ] },
      // 完了済み＝ステータスが「完了」グループ / status sits in the Completed group
      { name: tr().presetCompleted, filterMatch: "all", filters: [
        { kind: "category", field: "statusGroup", op: "is", values: ["completed"] },
      ] },
      // 未完了＝完了でもキャンセルでもない（アクティブ・延期・ステータス未設定）。中止したタスクは
      // 「残っている仕事」ではないので除く。フィールド内は OR なので isNot 1件で「どちらでもない」
      // incomplete = neither completed nor cancelled (active, deferred, or no status at all):
      // cancelled work isn't outstanding work. Values OR within a field, so one isNot covers both
      { name: tr().presetIncomplete, filterMatch: "all", filters: [
        { kind: "category", field: "statusGroup", op: "isNot", values: ["completed", "cancelled"] },
      ] },
    ];
  }

  // プリセットを適用（現在の filters/一致条件を丸ごと差し替え）/ apply a preset (replaces filters + match)
  private applyPreset(p: FilterPreset): void {
    const clone = JSON.parse(JSON.stringify(p)) as FilterPreset; // 参照共有を避ける / avoid sharing references
    this.vs.filters = clone.filters;
    this.vs.filterMatch = clone.filterMatch;
    this.commitFilters();
  }

  // 現在のフィルタ構成をプリセットとして保存 / save the current filter config as a preset
  private savePreset(name: string): void {
    const s = this.vs;
    s.filterPresets.push({ name, filterMatch: s.filterMatch, filters: JSON.parse(JSON.stringify(s.filters)) as Filter[] });
    this.commitFilters();
  }

  // プリセットのポップオーバー（組み込み＋マイプリセット＋保存/クリア）/ presets popover
  private openPresetMenu(anchor: HTMLElement): void {
    const s = this.vs;
    this.openPopover(anchor, "ogantt-datemenu", (menu, close) => {
      menu.addClass("ogantt-presetmenu");
      const renderBody = () => {
        menu.empty();
        // 組み込み / built-in
        menu.createDiv({ cls: "ogantt-preset-heading", text: tr().presetBuiltinHeading });
        for (const p of this.builtinPresets()) {
          const item = menu.createDiv({ cls: "ogantt-preset-item" });
          item.createSpan({ text: p.name });
          item.onclick = () => { this.applyPreset(p); close(); };
        }
        // マイプリセット（クリックで適用／ゴミ箱で削除）/ user presets (apply on click, trash to delete)
        if (s.filterPresets.length > 0) {
          menu.createDiv({ cls: "ogantt-preset-heading", text: tr().presetUserHeading });
          s.filterPresets.forEach((p, i) => {
            const item = menu.createDiv({ cls: "ogantt-preset-item" });
            item.createSpan({ text: p.name });
            const del = item.createSpan({ cls: "ogantt-preset-del" });
            setIcon(del, "trash-2");
            del.setAttr("aria-label", tr().presetDelete);
            item.onclick = (e) => { if (del.contains(e.target as Node)) return; this.applyPreset(p); close(); };
            del.onclick = (e) => { e.stopPropagation(); s.filterPresets.splice(i, 1); this.commitFilters(); renderBody(); };
          });
        }
        // 現在フィルタがあるとき：保存フォーム＋クリア / when filters exist: save form + clear
        if (s.filters.length > 0) {
          menu.createDiv({ cls: "ogantt-preset-sep" });
          const save = menu.createDiv({ cls: "ogantt-preset-save" });
          const input = save.createEl("input", { type: "text", cls: "ogantt-preset-name" });
          input.placeholder = tr().presetNamePlaceholder;
          const btn = save.createEl("button", { cls: "ogantt-preset-savebtn", text: tr().presetSave });
          const doSave = () => { const name = input.value.trim(); if (!name) { input.focus(); return; } this.savePreset(name); renderBody(); };
          btn.onclick = doSave;
          input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doSave(); } };
          const clear = menu.createDiv({ cls: "ogantt-preset-item ogantt-preset-clear" });
          setIcon(clear.createSpan({ cls: "ogantt-preset-item-ico" }), "x");
          clear.createSpan({ text: tr().presetClear });
          clear.onclick = () => { s.filters = []; s.filterMatch = "all"; this.commitFilters(); close(); };
        }
      };
      renderBody();
    });
  }

  // フィルタ 1 件の編集ポップオーバー / editor popover for one filter
  private openFilterEditor(anchor: HTMLElement, index: number): void {
    const f = this.vs.filters[index];
    if (!f) return;
    this.openPopover(anchor, "ogantt-datemenu", (menu, close) => {
      const commit = () => this.commitFilters();
      const renderBody = () => {
        menu.empty();
        // 見出し：フィールド名＋削除 / header: field name + remove
        const head = menu.createDiv({ cls: "ogantt-datemenu-head" });
        setIcon(head.createSpan({ cls: "ogantt-datemenu-field-ico" }), this.filterIcon(f));
        head.createSpan({ cls: "ogantt-datemenu-field", text: this.filterFieldLabel(f) });
        const del = head.createEl("button", { cls: "ogantt-datemenu-del clickable-icon" });
        setIcon(del, "trash-2");
        del.setAttr("aria-label", tr().dfRemove);
        del.onclick = () => { this.vs.filters.splice(index, 1); commit(); close(); };

        if (f.kind === "category") this.renderCategoryEditor(menu, f, commit, renderBody);
        else if (f.kind === "text") this.renderTextEditor(menu, f, commit);
        else this.renderDateEditor(menu, f, commit, renderBody);
      };
      renderBody();
    });
  }

  // カテゴリ（ステータス/担当者/タグ）のエディタ本体 / category editor body
  private renderCategoryEditor(menu: HTMLElement, f: CategoryFilter, commit: () => void, rebuild: () => void): void {
    const opRow = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const opSel = opRow.createEl("select");
    for (const op of ["is", "isNot", "empty", "notEmpty"] as CategoryOp[]) {
      const o = opSel.createEl("option", { text: this.catOpLabel(op), value: op });
      if (op === f.op) o.selected = true;
    }
    opSel.onchange = () => { f.op = opSel.value as CategoryOp; commit(); rebuild(); };
    // is/isNot のとき値のチェックリスト（フィールド内は OR）/ value checklist for is/isNot (OR within field)
    if (f.op === "is" || f.op === "isNot") {
      const listEl = menu.createDiv({ cls: "ogantt-datemenu-checklist" });
      const values = this.filterFieldValues(f.field);
      if (values.length === 0) { listEl.createDiv({ cls: "ogantt-datemenu-empty", text: tr().noneLabel }); return; }
      for (const [val, label] of values) {
        const item = listEl.createEl("label", { cls: "ogantt-datemenu-check" });
        const cb = item.createEl("input", { type: "checkbox" });
        cb.checked = f.values.includes(val);
        item.createSpan({ text: label });
        cb.onchange = () => {
          if (cb.checked) { if (!f.values.includes(val)) f.values.push(val); }
          else f.values = f.values.filter((x) => x !== val);
          commit(); // チェック状態はローカルに残るので rebuild 不要 / no rebuild: checkbox keeps its own state
        };
      }
    }
  }

  // テキスト（タスク名）のエディタ本体 / text (task name) editor body
  private renderTextEditor(menu: HTMLElement, f: TextFilter, commit: () => void): void {
    const opRow = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const opSel = opRow.createEl("select");
    for (const op of ["is", "isNot", "contains", "notContains", "startsWith", "endsWith"] as TextOp[]) {
      const o = opSel.createEl("option", { text: this.textOpLabel(op), value: op });
      if (op === f.op) o.selected = true;
    }
    opSel.onchange = () => { f.op = opSel.value as TextOp; commit(); };
    const body = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const input = body.createEl("input", { type: "text", cls: "ogantt-datemenu-text" });
    input.value = f.value;
    input.oninput = () => { f.value = input.value; commit(); }; // 入力ごとに絞り込み / filter live as you type
  }

  // 日付（開始日/期限日）のエディタ本体 / date editor body
  private renderDateEditor(menu: HTMLElement, f: DateFilterItem, commit: () => void, rebuild: () => void): void {
    const todayISO = dayToStr(todayIndex());
    // モード（プリセット名 or 種類）→ 既定の DateValue / a mode (preset name or kind) → a default DateValue
    const valueForMode = (mode: string): DateValue => {
      switch (mode) {
        case "yesterday": case "today": case "tomorrow": return { kind: "preset", preset: mode };
        case "specific": return { kind: "specific", date: todayISO };
        case "relative": return { kind: "relative", amount: 1, unit: "day", dir: "fromNow" };
        case "range": return { kind: "range", from: todayISO, to: todayISO };
        default: return { kind: "preset", preset: "today" };
      }
    };
    const opRow = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const opSel = opRow.createEl("select");
    for (const op of ["is", "before", "after", "onOrBefore", "onOrAfter", "empty", "notEmpty"] as DateOp[]) {
      const o = opSel.createEl("option", { text: this.dateOpLabel(op), value: op });
      if (op === f.op) o.selected = true;
    }
    opSel.onchange = () => {
      const op = opSel.value as DateOp;
      f.op = op;
      if (op === "empty" || op === "notEmpty") f.value = undefined;
      else if (!f.value) f.value = valueForMode("today");
      else if (f.value.kind === "range" && op !== "is") f.value = valueForMode("today"); // range は「is」専用 / range is "is"-only
      commit();
      rebuild();
    };
    if (f.op === "empty" || f.op === "notEmpty") return;

    const body = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const modeSel = body.createEl("select");
    const modes: [string, string][] = [
      ["today", tr().today], ["yesterday", tr().dfYesterday], ["tomorrow", tr().dfTomorrow],
      ["specific", tr().dfKindSpecific], ["relative", tr().dfKindRelative],
    ];
    if (f.op === "is") modes.push(["range", tr().dfKindRange]); // 期間は「is」のみ / range only for "is"
    const curMode = !f.value ? "today" : f.value.kind === "preset" ? f.value.preset : f.value.kind;
    for (const [val, text] of modes) {
      const o = modeSel.createEl("option", { text, value: val });
      if (val === curMode) o.selected = true;
    }
    modeSel.onchange = () => { f.value = valueForMode(modeSel.value); commit(); rebuild(); };

    const v = f.value;
    if (v?.kind === "specific") {
      const inp = body.createEl("input", { type: "date" });
      inp.value = v.date;
      inp.onchange = () => { if (inp.value) { v.date = inp.value; commit(); } };
    } else if (v?.kind === "relative") {
      const num = body.createEl("input", { type: "number", cls: "ogantt-datemenu-num" });
      num.min = "1";
      num.value = String(v.amount);
      num.onchange = () => { const n = Math.max(1, Math.floor(+num.value || 1)); v.amount = n; num.value = String(n); commit(); };
      const unitSel = body.createEl("select");
      for (const [u, text] of [["day", tr().dfDay], ["week", tr().dfWeek], ["month", tr().dfMonth]] as [DateUnit, string][]) {
        const o = unitSel.createEl("option", { text, value: u });
        if (u === v.unit) o.selected = true;
      }
      unitSel.onchange = () => { v.unit = unitSel.value as DateUnit; commit(); };
      const dirSel = body.createEl("select");
      for (const [d, text] of [["fromNow", tr().dfFromNow], ["ago", tr().dfAgo]] as [DateDir, string][]) {
        const o = dirSel.createEl("option", { text, value: d });
        if (d === v.dir) o.selected = true;
      }
      dirSel.onchange = () => { v.dir = dirSel.value as DateDir; commit(); };
    } else if (v?.kind === "range") {
      const from = body.createEl("input", { type: "date" });
      from.value = v.from;
      from.onchange = () => { if (from.value) { v.from = from.value; commit(); } };
      body.createSpan({ cls: "ogantt-datemenu-sep", text: tr().dfRangeTo });
      const to = body.createEl("input", { type: "date" });
      to.value = v.to;
      to.onchange = () => { if (to.value) { v.to = to.value; commit(); } };
    }
  }

  // ----- ツールバー / toolbar -----
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ogantt-toolbar" });
    // カンバン専用：カードに出す項目のメニュー。ガントの歯車と区別できるよう、カードを思わせるアイコンにして、タイトルの左に置く
    // Kanban only: the card fields menu — a card-like icon (not a gear, so it reads as "card fields"), left of the title
    const cardBtn = bar.createEl("button", { cls: "ogantt-kanban-only clickable-icon" });
    setIcon(cardBtn, "layout-list");
    cardBtn.createSpan({ cls: "ogantt-opt-gear-label", text: tr().optCardsLabel }); // アイコンの右に短いラベル / a short label to the right of the icon
    cardBtn.setAttr("aria-label", tr().optCards);
    cardBtn.onclick = () => this.openCardFieldsMenu(cardBtn);
    const groupBtn = bar.createEl("button", { cls: "ogantt-kanban-only clickable-icon" });
    setIcon(groupBtn, "layers");
    groupBtn.createSpan({ cls: "ogantt-opt-gear-label", text: tr().optGroupLabel });
    groupBtn.setAttr("aria-label", tr().optGroupLabel);
    groupBtn.onclick = (e) => this.openLaneMenu(e);
    const sortBtn = bar.createEl("button", { cls: "ogantt-kanban-only clickable-icon" });
    setIcon(sortBtn, "arrow-up-down");
    sortBtn.createSpan({ cls: "ogantt-opt-gear-label", text: tr().kanbanSort });
    sortBtn.setAttr("aria-label", tr().kanbanSort);
    sortBtn.onclick = (e) => this.openSortMenu(e);
    bar.createSpan({ cls: "ogantt-kanban-only ogantt-toolbar-sep" }); // カンバン専用ボタンとタイトルの区切り線 / a divider between the Kanban-only buttons and the title
    bar.createSpan({ cls: "ogantt-title", text: this.plugin.settings.rootFolder || "(vault root)" });
    // 新規タスク追加（アイコン＋ラベル）/ add a new task (icon + label)
    const add = bar.createEl("button", { cls: "ogantt-add" });
    setIcon(add, "plus");
    add.createSpan({ cls: "ogantt-add-label", text: tr().newTaskName });
    add.setAttr("aria-label", tr().newTaskAria);
    add.onclick = () => void this.createNewTask();
    // 以降のコントロールは「＋」の右に左詰めで並べる（詳細パネルで隠れないように）
    // keep the following controls left-packed next to "+" (so the detail panel can't hide them)
    // 今日へスクロール / scroll to today
    const todayBtn = bar.createEl("button", { cls: "ogantt-today-btn ogantt-gantt-only", text: tr().today });
    todayBtn.onclick = () => this.scrollToToday();
    (["Day", "Week", "Month", "Fit"] as ZoomMode[]).forEach((z) => {
      const btn = bar.createEl("button", { cls: "ogantt-gantt-only", text: z });
      this.zoomBtns.set(z, btn);
      if (z === this.zoom) btn.addClass("is-active");
      btn.onclick = () => {
        this.zoom = z; // ppd は rerender 内の computePpd() が決める / ppd is set by computePpd() in rerender
        this.syncZoomButtons();
        void this.refresh();
      };
    });
    // 取り消しボタン / undo button
    const undo = bar.createEl("button");
    setIcon(undo, "undo-2");
    undo.setAttr("aria-label", tr().undoAria);
    undo.onclick = () => void this.undo();
    this.undoBtn = undo;
    // やり直しボタン / redo button
    const redo = bar.createEl("button");
    setIcon(redo, "redo-2");
    redo.setAttr("aria-label", tr().redoAria);
    redo.onclick = () => void this.redo();
    this.redoBtn = redo;
    this.updateUndoButton();

    // 書き出し（PNG / PDF × チャートのみ / 表とチャート）/ export (PNG or PDF × chart only or table and chart)
    const exp = bar.createEl("button", { cls: "ogantt-gantt-only" }); // カンバンでは書き出せない / no export from Kanban yet
    setIcon(exp, "download");
    exp.setAttr("aria-label", tr().exportAria);
    exp.onclick = (e) => this.openExportMenu(e);

    const reload = bar.createEl("button");
    setIcon(reload, "refresh-cw");
    reload.setAttr("aria-label", tr().reloadAria);
    reload.onclick = () => void this.refresh();

    // 末尾の伸縮スペーサー（コントロールを左詰めに保つ）/ trailing spacer keeps controls left-packed
    bar.createDiv({ cls: "ogantt-spacer" });
  }

  // ----- 表示オプション（グループ/色分け/フィルタ）＋凡例 / view options + legend -----
  // データに依存する（担当者一覧など）ので rerender 毎に作り直す / rebuilt each rerender (depends on data)
  private renderOptions(): void {
    const host = this.optionsHost;
    host.empty();
    if (this.activeType() === "kanban") return; // カンバンのオプションはツールバーの先頭に出す / Kanban's option lives at the start of the toolbar

    const statuses = this.plugin.settings.statuses;
    const none = tr().noneLabel;
    // 現在のフォルダ内に実在する担当者一覧（凡例で使用）/ assignees present in the folder (used by the legend)
    const assignees = [...new Set(this.tasks.map((t) => t.assignee).filter((a): a is string => !!a))].sort();

    // グループ・色分け：カンバンのツールバーのボタンと同じ「アイコン＋ラベル」のボタン。押すとドロップダウン（現在の値にチェック）
    // group / color by: the same "icon + label" button as the Kanban toolbar's; it opens a dropdown with the current value checked
    const makeSelect = (icon: string, label: string, value: string, opts: [string, string][], on: (v: string) => void): void => {
      const btn = host.createEl("button", { cls: "ogantt-opt-gear clickable-icon" });
      setIcon(btn, icon);
      btn.createSpan({ cls: "ogantt-opt-gear-label", text: label });
      btn.setAttr("aria-label", label);
      btn.onclick = (e) => {
        const menu = new Menu();
        for (const [val, text] of opts) menu.addItem((it) => it.setTitle(text).setChecked(val === value).onClick(() => on(val)));
        menu.showAtMouseEvent(e);
      };
    };

    // 列の表示/非表示（歯車）＝オプション行の一番左 / column visibility (gear) — leftmost of the options row
    const colBtn = host.createEl("button", { cls: "ogantt-opt-gear clickable-icon" });
    setIcon(colBtn, "settings");
    colBtn.createSpan({ cls: "ogantt-opt-gear-label", text: tr().optColumnsLabel }); // 歯車の右に短いラベル / a short label to the right of the gear
    colBtn.setAttr("aria-label", tr().optColumns);
    colBtn.onclick = () => this.openColumnMenu(colBtn);

    // ── 表示の組み立て（グループ化・色分け）/ layout (group + color) ──
    // グループ化 / group by
    makeSelect(
      "layers",
      tr().optGroupLabel,
      this.groupBy,
      [["folder", tr().optGroupFolder], ["status", tr().fieldStatus], ["assignee", tr().fieldAssignee], ["tag", tr().fieldTags]],
      (v) => { this.groupBy = v as typeof this.groupBy; this.collapsed.clear(); this.rerender(); }
    );
    // 色分け（バーの色）はタイムラインのもの。テーブルでは出さない / colour-by is for the bars; the table view doesn't show it
    if (this.activeType() !== "table") makeSelect(
      "palette",
      tr().optColorLabel,
      this.colorBy,
      [["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
      (v) => { this.colorBy = v as typeof this.colorBy; this.rerender(); }
    );

    // ── 表示切替：空フォルダ・ロールアップ・フラット・稲妻線・ラベル・期限切れを 1 つの「表示」メニューにまとめる（絞り込みは下の統合フィルタ行）──
    // ── display toggles gathered into one Display menu (filtering lives in the filter row below) ──
    host.createDiv({ cls: "ogantt-opt-divider" });
    const displayBtn = host.createEl("button", { cls: "ogantt-opt-display" });
    setIcon(displayBtn.createSpan({ cls: "ogantt-opt-ico" }), "sliders-horizontal");
    displayBtn.createSpan({ text: tr().optDisplay });
    displayBtn.setAttr("aria-label", tr().optDisplay);
    // 既定から変えた表示があるときは色で知らせる（メニューの中は見えないため）/ tint the button when a display option differs from its default (the menu hides it)
    if (this.flat || this.rollup || this.progressLine || this.hideLabels || this.markOverdue || !this.showEmptyFolders) displayBtn.addClass("is-on");
    displayBtn.onclick = () => this.openDisplayMenu(displayBtn);

    // 凡例（色分けの基準を説明）/ legend explaining the current color basis
    const legend = host.createDiv({ cls: "ogantt-legend" });
    if (this.activeType() === "table") {
      // テーブルに色分けは無い / no colour basis in the table view
    } else if (this.colorBy === "status") {
      for (const s of statuses) this.legendChip(legend, s.color, s.label);
    } else {
      for (const a of assignees) this.legendChip(legend, hashColor(a), linkLabel(a));
      if (this.tasks.some((t) => !t.assignee)) this.legendChip(legend, FALLBACK_BAR, none);
    }
  }

  private legendChip(parent: HTMLElement, color: string, label: string): void {
    const chip = parent.createDiv({ cls: "ogantt-legend-chip" });
    const sw = chip.createSpan({ cls: "ogantt-legend-swatch" });
    sw.style.background = color;
    chip.createSpan({ text: label });
  }

  // タグ/フォルダの色（手動上書きがあればそれ、無ければ名前ハッシュで自動生成）/ tag/folder color (manual override, else auto from name)
  private tagColor(tag: string): string {
    return resolveTagColor(this.plugin.settings.tagColors, this.plugin.settings.defaultTagColor, tag);
  }
  private folderColor(name: string): string {
    return this.plugin.settings.folderColors.find((c) => c.name === name)?.color || hashColor(name);
  }
  // タグチップに色を塗る（枠＋淡い背景＋文字色。テーブル列/詳細パネル共通）/ paint a tag chip (border + faint bg + text)
  private paintTagChip(chip: HTMLElement, tag: string): void {
    const c = this.tagColor(tag);
    chip.style.borderColor = c;
    chip.style.color = c;
    chip.style.background = `color-mix(in srgb, ${c} 14%, transparent)`;
  }

  // タグ/フォルダ色の上書きを設定（color=null でリセット＝自動へ）/ set or clear a tag/folder color override (null = reset to auto)
  private setColorOverride(kind: "tag" | "folder", name: string, color: string | null): void {
    const arr = kind === "tag" ? this.plugin.settings.tagColors : this.plugin.settings.folderColors;
    const i = arr.findIndex((c) => c.name === name);
    // 「一覧に載っている ⇔ 色を指定している」を不変条件にする。リセットは色指定の解除なので
    // 行ごと消す（色が空の行は、行が無い状態と見分けがつかず情報を持たないため）。
    // invariant: listed ⇔ has an explicit colour. A reset drops the entry outright, because a row with
    // no colour is indistinguishable from having no row at all and carries no information.
    if (color == null) {
      if (i >= 0) arr.splice(i, 1);
    } else if (i >= 0) {
      arr[i].color = color;
    } else {
      arr.push({ name, color });
    }
    void this.plugin.saveData(this.plugin.settings);
    this.plugin.settingTab?.refreshIfOpen(); // 開いている設定画面にも反映 / reflect it in an open settings tab
    this.rerender();
  }

  // 右クリックの色メニュー（変更＝ネイティブピッカー／リセット＝自動）/ right-click color menu (change → native picker; reset → auto)
  private openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void {
    const current = kind === "tag" ? this.tagColor(name) : this.folderColor(name);
    const m = new Menu();
    m.addItem((i) => i.setTitle(tr().menuChangeColor).setIcon("palette").onClick(() => {
      // 隠し input[type=color] を生成してネイティブピッカーを開く / spawn a hidden color input to open the native picker
      const picker = activeDocument.body.createEl("input", { type: "color", cls: "ogantt-hidden-color-input" });
      picker.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#888888";
      picker.addEventListener("change", () => {
        this.setColorOverride(kind, name, picker.value);
        picker.remove();
      });
      picker.click();
    }));
    // タグは既定色へ、フォルダは名前から自動生成へ戻る。行き先が違うのでラベルも分ける
    // tags fall back to the default colour, folders to their name-derived one, so the labels differ
    const resetLabel = kind === "tag" ? tr().menuResetTagColor : tr().menuResetColor;
    m.addItem((i) => i.setTitle(resetLabel).setIcon("rotate-ccw").onClick(() => this.setColorOverride(kind, name, null)));
    m.showAtMouseEvent(e);
  }

  // フィルタ→グループ再マッピングを適用したタスク列を返す（判定本体は filter.ts）/ tasks after filter + group remap (logic lives in filter.ts)
  private processTasks(): Task[] {
    const { filters, filterMatch, statuses } = this.vs;
    // today は 1 回だけ評価して共有 / evaluate `today` once and share it
    const list = applyFilters(this.tasks, filters, filterMatch, statuses, todayIndex());
    return regroup(list, this.groupBy, this.flat, statuses, tr().noneLabel);
  }

  // 今日の線が中央に来るよう横スクロール / scroll horizontally so the today marker is centered
  private scrollToToday(): void {
    const main = this.gridHost.querySelector<HTMLElement>(".ogantt-main");
    const todayLine = main?.querySelector<SVGElement>(".ogantt-today");
    if (!main || !todayLine) return; // 今日が範囲外＝線が無い / no marker when today is out of range
    const mb = main.getBoundingClientRect();
    const tb = todayLine.getBoundingClientRect();
    main.scrollLeft += tb.left - mb.left - main.clientWidth / 2;
  }

  // ----- 取り消し・やり直し（Undo / Redo）-----
  // 書き込みはすべてここを通す：対象ファイルだけ操作前の内容を控え、fn を実行して履歴に積む。
  // fn が false を返したら「変化なし」として履歴に残さない。作成したファイルは created で知らせる（Undo でゴミ箱へ）
  // every write goes through here: snapshot only the affected files, run fn, record the entry.
  // fn returns false for "nothing changed" (not recorded); report new files via `created` (trashed on undo)
  private async mutate(label: string, paths: string[], fn: () => Promise<MutateResult>): Promise<boolean> {
    // まとめて書いている最中の個々の書き込みは、外側の 1 回の取り消しにまとめる（ここでは記録しない）/ writes inside a bulk write fold into the outer single undo step (not recorded here)
    if (this.batchActive) return (await fn()) !== false;
    const files = await this.snapshot(paths);
    let res: MutateResult;
    this.historyBusy++;
    try {
      res = await fn();
    } finally {
      this.historyBusy--;
    }
    if (res === false) return false;
    const r = typeof res === "object" ? res : {};
    // 移動も作成も無く内容も変わっていなければ記録しない（本文の #tag だけのタグ削除など）
    // skip recording when nothing moved, nothing was created and no contents changed (e.g. removing an inline-only #tag)
    if (!r.moves?.length && !r.created?.length) {
      const now = await this.snapshot(files.keys());
      if ([...files].every(([p, c]) => now.get(p) === c)) return false;
    }
    for (const p of r.created ?? []) files.set(p, null);
    this.record({ label, files, moves: r.moves ?? [], created: r.created ?? [], deleted: r.deleted ?? [] });
    return true;
  }

  // 新しい操作を履歴へ（やり直し履歴は無効になる）/ record a new op (invalidates redo)
  private record(entry: HistoryEntry): void {
    this.pushHistory(this.undoStack, entry);
    this.redoStack = [];
    this.updateUndoButton();
  }

  // 指定パスの現在内容（無ければ null）/ current contents of the given paths (null when missing)
  private async snapshot(paths: Iterable<string>): Promise<Map<string, string | null>> {
    const files = new Map<string, string | null>();
    for (const p of paths) {
      if (files.has(p)) continue;
      const f = this.app.vault.getAbstractFileByPath(p);
      files.set(p, f instanceof TFile ? await this.app.vault.read(f) : null);
    }
    return files;
  }

  // スナップショットを書き戻す。null はゴミ箱へ。無いファイルは recreatable に含まれるときだけ作り直し、
  // それ以外（外部で消された等）は触らない
  // write a snapshot back: null trashes the file; a missing file is re-created only when it is in
  // `recreatable`, otherwise (e.g. deleted outside the board) it is left alone
  private async restore(files: Map<string, string | null>, recreatable: string[]): Promise<void> {
    for (const [path, content] of files) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (content === null) {
        if (f instanceof TFile) {
          await this.app.fileManager.trashFile(f);
          if (this.selectedPath === path) this.closeDetail();
        }
      } else if (f instanceof TFile) {
        if ((await this.app.vault.read(f)) !== content) await this.app.vault.modify(f, content);
      } else if (!f && recreatable.includes(path)) {
        const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
        await this.app.vault.create(path, content);
      }
    }
  }

  // 移動を順に再生（ファイルもフォルダも。行き先が埋まっていれば飛ばす）
  // replay moves in order (files and folders alike; skip when the target is taken)
  private async replayMoves(moves: Move[]): Promise<void> {
    for (const m of moves) {
      const f = this.app.vault.getAbstractFileByPath(m.from);
      if (!f || this.app.vault.getAbstractFileByPath(m.to)) continue;
      await this.app.fileManager.renameFile(f, m.to);
      const sel = this.selectedPath;
      if (sel === m.from) this.selectedPath = m.to;
      else if (sel?.startsWith(m.from + "/")) this.selectedPath = m.to + sel.slice(m.from.length);
    }
  }

  private pushHistory(stack: HistoryEntry[], entry: HistoryEntry): void {
    stack.push(entry);
    if (stack.length > GanttView.UNDO_LIMIT) stack.shift();
  }

  // 直近の操作を取り消す（移動の巻き戻し→現在内容を Redo 用に控える→操作前の内容へ）
  // revert the latest op (undo moves → keep current contents for redo → restore the pre-op contents)
  private async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToUndo);
      return;
    }
    this.historyBusy++;
    try {
      await this.replayMoves(entry.moves.map((m) => ({ from: m.to, to: m.from })).reverse());
      const after = await this.snapshot(entry.files.keys());
      await this.restore(entry.files, entry.deleted); // 削除の取り消しだけ作り直す / only undoing a delete re-creates
      this.pushHistory(this.redoStack, { ...entry, files: after });
    } finally {
      this.historyBusy--;
    }
    new Notice(tr().undone(entry.label));
    await this.refresh();
    this.updateUndoButton();
  }

  // 取り消した操作をやり直す（操作後の内容を書き戻し→移動を再生）/ redo an undone op (restore post-op contents → replay moves)
  private async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToRedo);
      return;
    }
    this.historyBusy++;
    try {
      const before = await this.snapshot(entry.files.keys());
      await this.restore(entry.files, entry.created); // 作成のやり直しだけ作り直す / only redoing a create re-creates
      await this.replayMoves(entry.moves);
      this.pushHistory(this.undoStack, { ...entry, files: before });
    } finally {
      this.historyBusy--;
    }
    new Notice(tr().redone(entry.label));
    await this.refresh();
    this.updateUndoButton();
  }

  // 外部（ファイルエクスプローラー等）でのリネームも 1 操作として履歴に積む。時系列どおりに戻せるように、
  // かつ古い履歴のパスが現在と食い違わないように。同期などによる無関係なリネームを拾わないよう、
  // このボードのタスク（またはタスクを含むフォルダ）に限る
  // record an outside rename (file explorer etc.) as an op of its own, so undo walks back in order and
  // older entries never see a path that no longer exists. Limited to this board's tasks (or folders
  // holding them) so unrelated renames, e.g. from sync, stay out of the history
  // フォルダのリネームは配下のファイルごとにもイベントが届くため、同じタイミングの分をまとめて
  // フォルダ側の 1 件に畳む / a folder rename also fires for each file inside it, so batch the events
  // that arrive together and fold them into the folder's single move
  private queueOutsideRename(oldPath: string, newPath: string): void {
    this.pendingRenames.push({ from: oldPath, to: newPath });
    if (this.pendingRenames.length === 1) window.setTimeout(() => this.flushOutsideRenames(), 0);
  }

  private flushOutsideRenames(): void {
    const batch = this.pendingRenames;
    this.pendingRenames = [];
    for (const m of batch) {
      if (batch.some((o) => o !== m && movesUnder(o, m))) continue; // フォルダの移動に含まれる / implied by a folder move
      const onBoard = this.tasks.some((t) => t.path === m.from || t.path.startsWith(m.from + "/"));
      if (!onBoard) continue;
      const name = (m.from.split("/").pop() ?? m.from).replace(/\.md$/, "");
      this.record({ label: tr().undoRename(name), files: new Map(), moves: [m], created: [], deleted: [] });
    }
  }

  // 直近の履歴に記録済みの移動か（イベントが遅れて届いても自分の移動を二重に記録しないため）
  // whether a rename is one of our own recorded moves (so a late event isn't recorded twice)
  private isOwnMove(oldPath: string, newPath: string): boolean {
    const tops = [this.undoStack[this.undoStack.length - 1], this.redoStack[this.redoStack.length - 1]];
    return tops.some((e) => e?.moves.some((m) =>
      movesUnder(m, { from: oldPath, to: newPath }) || movesUnder({ from: m.to, to: m.from }, { from: oldPath, to: newPath })));
  }

  // 詳細パネルが指定タスクで開いているか / whether the detail panel is open on the given task
  private isDetailOpenFor(path: string): boolean {
    return !!this.detailEl?.hasClass("is-open") && this.selectedPath === path;
  }

  // タスクをリネーム（取り消し可）。詳細パネルのタイトル欄とテーブルの名前セルが共用
  // rename a task (undoable); shared by the detail panel's title and the table's name cell
  private async renameTaskTo(from: string, oldName: string, newName: string): Promise<void> {
    let np: string | null = null;
    await this.mutate(tr().undoRename(oldName), [], async () => {
      np = await renameTask(this.app, from, newName);
      return np && np !== from ? { moves: [{ from, to: np }] } : false;
    });
    if (np && this.selectedPath === from) this.selectedPath = np;
    await this.refresh();
  }

  // テーブルの名前セルをその場で入力欄にしてリネーム。編集中は行のドラッグを止める（文字選択が行の D&D にならないように）
  // rename in place in the table's name cell; row dragging is paused while editing so selecting text doesn't drag the row
  private renameInCell(nameText: HTMLElement, t: Task, row: HTMLElement): void {
    const draggable = row.getAttr("draggable");
    row.setAttr("draggable", "false");
    nameText.addClass("ogantt-name-editing");
    this.inlineInput(
      nameText,
      t.name,
      () => {
        nameText.removeClass("ogantt-name-editing");
        nameText.setText(t.name);
        if (draggable != null) row.setAttr("draggable", draggable);
      },
      (v) => this.renameTaskTo(t.path, t.name, v)
    );
  }

  // 書き出しのメニュー（形式 2 × 範囲 2）/ the export menu (2 formats × 2 scopes)
  private openExportMenu(e: MouseEvent): void {
    const menu = new Menu();
    const items: [string, ExportFormat, ExportScope, string][] = [
      [tr().exportPngChart, "png", "chart", "image-down"],
      [tr().exportPngTable, "png", "table", "image-down"],
      [tr().exportPdfChart, "pdf", "chart", "file-down"],
      [tr().exportPdfTable, "pdf", "table", "file-down"],
    ];
    items.forEach(([title, format, scope, icon], i) => {
      if (i === 2) menu.addSeparator();
      menu.addItem((it) => it.setTitle(title).setIcon(icon).onClick(() => void this.exportBoard(format, scope)));
    });
    menu.showAtMouseEvent(e);
  }

  // 今見えているボード（絞り込み・グループ・折りたたみ・列・テーマのまま）を、添付ファイルの置き場所へ書き出す
  // export the board as it is shown (filters, grouping, collapsing, columns, theme) into the vault's attachment folder
  async exportBoard(format: ExportFormat, scope: ExportScope): Promise<void> {
    const grid = this.gridHost?.querySelector<HTMLElement>(".ogantt-grid");
    if (!grid || !this.rows.length) return void new Notice(tr().exportNothing);
    if (this.exporting) return;
    this.exporting = true;
    const base = this.folder.split("/").pop() || "vault";
    const stamp = dayToStr(todayIndex());
    // 名前は最初に決める / named up front
    const name = `Gantt ${base} ${stamp} ${scope === "chart" ? "chart" : "table-chart"}.${format}`;
    try {
      const input = {
        grid,
        scope,
        chartW: (this.range.max - this.range.min + 1) * this.ppd,
        tableW: this.tableWidth(),
        rows: this.rows.length,
        rowH: ROW_H,
        headH: HEAD_H,
        title: `${this.folder || "(vault root)"} — ${formatDate(stamp, this.plugin.settings.dateFormat)}`,
        maxPixels: Platform.isMobile ? 16e6 : 3e7,
      };
      const bytes = format === "png" ? await boardToPng(input) : await boardToPdf(input);
      // "/" を渡すと、相対の添付先の設定も、適当なノートではなく Vault のルートから決まる
      // "/" makes a relative attachment setting resolve from the vault root rather than from some note
      const path = await this.app.fileManager.getAvailablePathForAttachment(name, "/");
      const file = await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      new Notice(
        createFragment((f) => {
          f.createSpan({ text: tr().exportDone(file.path) + " " });
          f.createEl("button", { text: tr().exportOpen }).onclick = () => void this.app.workspace.getLeaf("tab").openFile(file);
        }),
        8000
      );
    } catch (e) {
      console.error("Task Gantt Board: export failed", e);
      new Notice(tr().exportFailed);
    } finally {
      this.exporting = false;
    }
  }

  // 詳細パネルを閉じて選択を外す / close the detail panel and clear the selection
  private closeDetail(): void {
    this.selectedPath = null;
    this.detailEl?.removeClass("is-open");
  }

  // 取り消し・やり直しボタンの有効/無効を更新 / enable or disable the undo and redo buttons
  private updateUndoButton(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
    if (this.redoBtn) this.redoBtn.disabled = this.redoStack.length === 0;
  }

  // ----- 表＋タイムラインを 1 つの CSS グリッドで（sticky で行を揃える）-----
  // ----- table + timeline in one CSS grid; sticky heads/left column keep rows aligned -----
  private renderGrid(main: HTMLElement): void {
    const totalDays = this.range.max - this.range.min + 1;
    const width = totalDays * this.ppd;
    const bodyH = this.rows.length * ROW_H;

    const cols = this.visibleColumns();
    const isTable = this.activeType() === "table"; // テーブルビューは、タイムライン（日付軸と SVG）を作らない / the table view builds no timeline (date axis, SVG)
    const gridCols = (): string => (isTable ? `${this.tableWidth()}px` : `${this.tableWidth()}px ${width}px`);
    const grid = main.createDiv({ cls: "ogantt-grid" + (isTable ? " is-table-only" : "") });
    grid.style.gridTemplateColumns = gridCols();
    grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;

    // 行ループ内ではローカル変数 tr（行要素）が i18n の tr() を隠すため、先に文言を退避
    // the row var `tr` shadows the i18n tr() inside the loop, so grab strings up front
    const strings = tr();
    const overdue = this.markOverdue ? this.overdueCounts() : null;

    // (1) 左上の角＝表ヘッダー（表示中の列を並べる・クリックでソート）/ top-left corner = header (click to sort)
    const corner = grid.createDiv({ cls: "ogantt-corner" });
    for (const col of cols) {
      const id = col.id;
      const th = corner.createDiv({ cls: "ogantt-th ogantt-th-sortable" + (id === "name" ? " ogantt-th-name" : "") });
      if (id !== "name") th.style.width = `${this.colW(id)}px`;
      th.createSpan({ text: col.label() });
      // アクティブなソート列に ↑/↓ を表示 / show ↑/↓ on the active sort column
      if (this.vs.sortBy === id) {
        th.createSpan({ cls: "ogantt-sort-arrow", text: this.vs.sortDir === "asc" ? "↑" : "↓" });
      }
      th.onclick = () => this.toggleSort(id);
      // 右端グリップ：ドラッグ＝列幅変更（永続化）、素早い2回押し＝内容に合わせて自動フィット
      // right-edge grip: drag to resize the column (persisted), quick double-press auto-fits to content
      const grip = th.createDiv({ cls: "ogantt-col-grip" });
      grip.addEventListener("click", (e) => e.stopPropagation()); // ソートを抑止 / don't toggle sort
      let lastDown = 0;
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const nth = cols.indexOf(col) + 1;
        if (e.timeStamp - lastDown < 400) {
          // Wクリック判定（pointerdown の preventDefault で dblclick が来ない環境があるため自前判定）
          // manual double-press detection (dblclick may be suppressed by preventDefault on pointerdown)
          lastDown = 0;
          this.autoFitColumn(id, nth, th);
          return;
        }
        lastDown = e.timeStamp;
        grip.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = this.colW(id);
        let moved = false;
        const onMove = (ev: PointerEvent) => {
          moved = true;
          const w = Math.max(40, Math.round(startW + ev.clientX - startX));
          this.vs.columnWidths[id] = w;
          // ドラッグ中は再描画せず幅だけ反映 / live-apply widths without a full re-render
          grid.style.gridTemplateColumns = gridCols();
          if (id !== "name") {
            th.style.width = `${w}px`;
            this.tbodyEl
              ?.querySelectorAll<HTMLElement>(`.ogantt-tr:not(.is-group) > .ogantt-td:nth-child(${nth})`)
              .forEach((el) => (el.style.width = `${w}px`));
          }
        };
        const onUp = () => {
          grip.removeEventListener("pointermove", onMove);
          // 実際に動かしたときだけ保存（単押しでDOMを作り直さない＝2回押し判定を生かす）
          // save only after an actual drag (a plain press doesn't re-render, keeping double-press alive)
          if (moved) void this.plugin.saveSettings();
        };
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp, { once: true });
      });
    }

    // (2) 日付軸 / date axis
    // Fit は算出した ppd から目盛り粒度を選ぶ / in Fit, pick tick granularity from the computed ppd
    const tickZoom: ZoomMode =
      this.zoom !== "Fit" ? this.zoom : this.ppd >= 24 ? "Day" : this.ppd >= 10 ? "Week" : "Month";
    if (!isTable) {
      const axis = grid.createDiv({ cls: "ogantt-axis" });
      for (const tick of buildTicks(this.range, tickZoom, this.ppd, tr().weekdays)) {
        const t = axis.createDiv({ cls: "ogantt-tick" + (tick.major ? " is-major" : "") });
        t.style.left = `${tick.x}px`;
        t.setText(tick.label);
      }
    }

    // (3) 表の本体 / table body
    const body = grid.createDiv({ cls: "ogantt-tbody" });
    this.tbodyEl = body;
    for (const row of this.rows) {
      const tr = body.createDiv({ cls: "ogantt-tr" });
      tr.style.height = `${ROW_H}px`;
      const indent = 8 + Math.min(row.depth, MAX_INDENT_DEPTH) * 16; // 入れ子インデント（上限あり）/ nesting indent (capped)
      if (row.kind === "group") {
        tr.addClass("is-group");
        const isCollapsed = row.key != null && this.collapsed.has(row.key);
        const g = tr.createDiv({ cls: "ogantt-td-group" });
        g.style.paddingLeft = `${indent}px`;
        const chev = g.createSpan({ cls: "ogantt-chevron" });
        setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
        const ic = g.createSpan({ cls: "ogantt-folder-icon" });
        // タググループはタグアイコン、それ以外はフォルダ / a tag icon for tag groups, folder otherwise
        setIcon(ic, this.groupBy === "tag" ? "tag" : isCollapsed ? "folder" : "folder-open");
        // 見出しアイコンに色（フォルダ＝フォルダ色、タグ＝タグ色。(なし) は既定色のまま）
        // tint the heading icon (folder color / tag color; leave the (none) group default)
        if (this.groupBy === "folder" && row.key != null) ic.style.color = this.folderColor(row.group);
        else if (this.groupBy === "tag" && row.group !== strings.noneLabel) ic.style.color = this.tagColor(row.group);
        g.createSpan({ text: row.group });
        // 期限切れの件数（強調がオンのとき）/ the overdue count (with the highlight on)
        const late = overdue?.get(row);
        if (late) g.createSpan({ cls: "ogantt-group-count", text: `⚠ ${late}`, attr: { title: strings.overdueTitle(late) } });
        // 見出しを右クリック＝色を変更（フォルダ／タグ。(なし) は除く）/ right-click a heading to change its color
        if (this.groupBy === "folder" && row.key != null) {
          g.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openColorMenu(e, "folder", row.group); });
        } else if (this.groupBy === "tag" && row.group !== strings.noneLabel) {
          g.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openColorMenu(e, "tag", row.group); });
        }
        tr.onclick = () => {
          if (row.key == null) return;
          if (this.collapsed.has(row.key)) this.collapsed.delete(row.key);
          else this.collapsed.add(row.key);
          void this.refresh();
        };
        // フォルダグループへドロップ＝親を解除してそのフォルダのトップレベルへ / drop onto a folder = detach + move to its top level
        if (this.groupBy === "folder" && row.key != null) {
          const dest = this.folder ? `${this.folder}/${row.key}` : row.key;
          this.makeDropTarget(tr, (src) => void this.reparentTo(src, dest, null));
        }
        // タググループへドロップ＝そのタグを付与（(なし) グループは対象外）/ drop onto a tag group = add that tag (skip the (none) group)
        if (this.groupBy === "tag" && row.key != null && row.group !== strings.noneLabel) {
          const tag = row.key;
          this.makeDropTarget(tr, (src) => void this.addTagTo(src, tag));
        }
      } else {
        const t = row.task!;
        tr.setAttr("data-path", t.path);
        if (t.path === this.selectedPath) tr.addClass("is-selected");
        // 表示中の列を順に描画 / render each visible column
        for (const col of cols) {
          if (col.kind === "name") {
            const nameTd = tr.createDiv({ cls: "ogantt-td ogantt-td-name" });
            nameTd.dataset.col = "name";
            nameTd.dataset.ro = "1"; // 名前は貼り付け・フィルの対象外（コピーはできる）/ the name can be copied but not pasted or filled into
            this.wireCellSelect(nameTd, t.path, "name");
            nameTd.style.paddingLeft = `${indent}px`;
            // シェブロン枠は常に確保＝親でも単独タスクでも名前位置を揃える
            // always reserve the chevron slot so parents and standalone tasks align
            const chev = nameTd.createSpan({ cls: "ogantt-task-chevron" });
            if (row.hasChildren && row.key != null) {
              const key = row.key;
              setIcon(chev, this.collapsed.has(key) ? "chevron-right" : "chevron-down");
              chev.addClass("is-clickable");
              chev.addEventListener("click", (e) => {
                e.stopPropagation(); // 行クリック（詳細を開く）を抑止 / don't open the detail panel
                if (this.collapsed.has(key)) this.collapsed.delete(key);
                else this.collapsed.add(key);
                void this.refresh();
              });
            }
            const nameText = nameTd.createSpan({ text: t.name });
            // 詳細パネルがこのタスクで開いている状態でのダブルクリック＝その場でリネーム。
            // 閉じている状態では 1 回目のクリックでパネルが開くだけにする（誤ってリネームに入らない）。
            // ダブルクリックの 1 回目でもパネルは開き直されるので、判定は 1 回目を押した瞬間の状態で行う
            // a double-click while the detail panel shows this task renames it in place; while the panel is closed
            // the first click just opens it (no accidental rename). The first click of a double-click re-opens the
            // panel too, so the check uses the state at the moment that first click went down
            let panelWasOpen = false;
            nameTd.addEventListener("mousedown", (e) => {
              if (e.detail === 1) panelWasOpen = this.isDetailOpenFor(t.path);
            });
            nameTd.addEventListener("dblclick", (e) => {
              if (!panelWasOpen) return;
              e.stopPropagation();
              this.renameInCell(nameText, t, tr);
            });
            // 入力欄のクリックで詳細を開き直さない / clicks inside the input don't re-open the panel
            nameText.addEventListener("click", (e) => {
              if (nameText.querySelector("input")) e.stopPropagation();
            });
            // タイトル右クリック＝削除メニュー / right-click the title = delete menu
            nameTd.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              const m = new Menu();
              m.addItem((i) => i.setTitle(strings.menuDelete).setIcon("trash-2").onClick(() => this.confirmDelete(t.path)));
              m.showAtMouseEvent(e);
            });
          } else {
            const td = tr.createDiv({ cls: "ogantt-td" });
            td.style.width = `${this.colW(col.id)}px`;
            this.renderCell(td, row, col);
          }
        }
        tr.onclick = () => void this.openDetail(t.path);
        if (this.groupBy === "folder") {
          this.makeDraggableTask(tr, t.path);
          // タスク行へドロップ＝そのタスクのサブタスクにする（親フォルダへ同居）/ drop onto a task = make it that task's subtask
          this.makeDropTarget(tr, (src) => void this.reparentTo(src, this.taskFolder(t.path), t.path));
        } else if (this.groupBy === "tag") {
          // タグ表示ではタググループへドラッグしてタグ付け（タスクへのドロップ＝サブタスク化はしない）
          // when grouping by tag, drag onto a tag group to tag (no subtask drop)
          this.makeDraggableTask(tr, t.path);
        }
      }
    }

    this.paintSelection();
    // (4) タイムライン SVG / timeline SVG
    if (isTable) return; // テーブルビューはここまで / the table view stops here
    const svgWrap = grid.createDiv({ cls: "ogantt-svgwrap" });
    const svg = svgWrap.createSvg("svg", { cls: "ogantt-svg" });
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(bodyH));
    this.drawGrid(svg, width, bodyH);
    // 依存作成ハンドルは専用レイヤーに集め、依存矢印より後に追加＝最前面で掴みやすい
    // collect connector handles in their own layer, appended after the arrows so they stay topmost and grabbable
    const handlesLayer = this.svgEl("g", { class: "ogantt-handles-layer" });
    this.drawBars(svg, handlesLayer);
    // 稲妻線はバーの上（隠れると意味がない）・依存矢印の下 / above the bars (it must not be hidden), below the arrows
    if (this.progressLine) this.drawProgressLine(svg, width, bodyH);
    this.drawDependencies(svg); // バーの上に描いて矢印を隠さない / on top of bars so arrows stay visible
    svg.appendChild(handlesLayer); // 矢印の上にハンドルを重ねる / handles above arrows
  }

  private xOf(dateStr: string): number {
    return (dayIndex(dateStr) - this.range.min) * this.ppd;
  }

  private drawGrid(svg: SVGElement, width: number, height: number): void {
    // 行の区切り / row separators
    this.rows.forEach((row, i) => {
      if (row.kind === "group") {
        const bg = this.svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-grid-group" });
        svg.appendChild(bg);
      }
      const line = this.svgEl("line", { x1: 0, y1: (i + 1) * ROW_H, x2: width, y2: (i + 1) * ROW_H, class: "ogantt-grid-row" });
      svg.appendChild(line);
    });
    // 今日の線 / today marker
    const todayX = (todayIndex() - this.range.min) * this.ppd;
    if (todayX >= 0 && todayX <= width) {
      svg.appendChild(this.svgEl("line", { x1: todayX, y1: 0, x2: todayX, y2: height, class: "ogantt-today" }));
    }
  }

  // グループ見出しごとの期限切れの件数（入れ子の配下も含む）/ overdue tasks per group heading (nested ones included)
  private overdueCounts(): Map<Row, number> {
    const out = new Map<Row, number>();
    const statuses = this.plugin.settings.statuses;
    const today = todayIndex();
    this.rows.forEach((row, i) => {
      if (row.kind !== "group") return;
      let n = 0;
      for (let j = i + 1; j < this.rows.length; j++) {
        const r = this.rows[j];
        if (r.kind === "group" && r.depth <= row.depth) break;
        if (r.kind === "task" && r.task && isOverdue(r.task, statuses, today)) n++;
      }
      if (n) out.set(row, n);
    });
    return out;
  }

  // 稲妻線：今日を基準に、各行の「実績到達点」を結ぶ折れ線。左へ折れる＝遅れ / 右＝進み
  // progress line: joins each row's achieved-progress point against today; left = behind, right = ahead
  private drawProgressLine(svg: SVGElement, width: number, height: number): void {
    const basisX = (todayIndex() - this.range.min) * this.ppd;
    if (basisX < 0 || basisX > width) return; // 基準日が範囲外＝結ぶ軸がない / no basis to anchor to
    const lineRows: ProgressLineRow[] = this.rows.map((row) => {
      // グループ行とロールアップ行はサマリー（自分の進捗を持たない）ので素通し
      // group and rollup rows are summaries with no progress of their own, so they pass through
      if (row.kind === "group") return {};
      const t = row.task!;
      if (this.rollup && row.span) return {};
      const aStart = anchorStart(t);
      if (!aStart) return {};
      const x = this.xOf(aStart);
      if (!Number.isFinite(x)) return {}; // 不正な日付で折れ線が壊れないように / a bad date must not break the polyline
      if (t.milestone) return { startX: x, width: 0, progress: t.progress };
      const endStr = anchorEnd(t) ?? aStart;
      const w = Math.max((dayIndex(endStr) - dayIndex(aStart) + 1) * this.ppd, 6);
      return { startX: x, width: Number.isFinite(w) ? w : 0, progress: t.progress };
    });
    const pts = buildProgressLine(lineRows, basisX, ROW_H, height);
    const line = this.svgEl("polyline", {
      points: pts.map((p) => `${p.x},${p.y}`).join(" "),
      class: "ogantt-progress-line",
    });
    // 色は設定から。stroke 属性は CSS 宣言に負けるので、インラインスタイルで上書きする
    // （未設定なら何も指定せず CSS の既定色にまかせる）
    // color from settings; a stroke *attribute* loses to the CSS rule, so set it as an inline style
    // (leave it unset to fall back to the CSS default)
    const color = this.plugin.settings.progressLineColor;
    if (color) line.style.stroke = color;
    svg.appendChild(line);
  }

  private drawBars(svg: SVGElement, handlesLayer: SVGElement): void {
    const statusColor = new Map(this.plugin.settings.statuses.map((s) => [s.id, s.color]));
    this.rows.forEach((row, i) => {
      // グループ行のまとめバー / group summary bar
      if (row.kind === "group") {
        if (!row.span) return;
        const gx = this.xOf(row.span.start);
        const gw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
        const gy = i * ROW_H + ROW_H / 2 - 3;
        svg.appendChild(this.svgEl("rect", { x: gx, y: gy, width: gw, height: 6, rx: 2, class: "ogantt-group-bar" }));
        // 端のキャップ / end caps
        svg.appendChild(this.svgEl("path", { d: `M ${gx} ${gy} l 0 8 l 5 -8 z`, class: "ogantt-group-cap" }));
        svg.appendChild(this.svgEl("path", { d: `M ${gx + gw} ${gy} l 0 8 l -5 -8 z`, class: "ogantt-group-cap" }));
        return;
      }
      const t = row.task!;
      // ロールアップ ON：子を持つ親は「子孫を含む範囲」のフルバーで描く（自分のバーは描かない）
      // rollup on: draw a parent as a full bar spanning its whole subtree (not its own bar)
      if (this.rollup && row.span) {
        const sx = this.xOf(row.span.start);
        const sw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
        const yy = i * ROW_H + BAR_PAD;
        const hh = ROW_H - BAR_PAD * 2;
        const c =
          this.colorBy === "assignee"
            ? t.assignee ? hashColor(t.assignee) : FALLBACK_BAR
            : (t.status && statusColor.get(t.status)) || FALLBACK_BAR;
        const rg = this.svgEl("g", { class: "ogantt-bar-g ogantt-rollup-g", "data-path": t.path });
        rg.appendChild(this.svgEl("rect", { x: sx, y: yy, width: sw, height: hh, rx: 4, class: "ogantt-bar ogantt-rollup-bar", fill: c }));
        if (!this.hideLabels) {
          const lbl = this.svgEl("text", { x: sx + sw + 6, y: i * ROW_H + ROW_H / 2 + 4, class: "ogantt-bar-label" });
          lbl.textContent = t.name;
          rg.appendChild(lbl);
        }
        rg.addEventListener("dblclick", (ev) => { ev.stopPropagation(); void this.openDetail(t.path); });
        svg.appendChild(rg);
        return;
      }
      const aStart = anchorStart(t);
      if (!aStart) return;
      const y = i * ROW_H + BAR_PAD;
      const h = ROW_H - BAR_PAD * 2;
      const x = this.xOf(aStart);
      const color =
        this.colorBy === "assignee"
          ? t.assignee ? hashColor(t.assignee) : FALLBACK_BAR
          : (t.status && statusColor.get(t.status)) || FALLBACK_BAR;

      const g = this.svgEl("g", { class: "ogantt-bar-g", "data-path": t.path });
      const overdue = this.markOverdue && isOverdue(t, this.plugin.settings.statuses, todayIndex()); // 期限切れの強調 / the overdue highlight
      const cyMid = i * ROW_H + ROW_H / 2;
      let lx = x; // 左端ハンドル位置 / left handle x
      let rx = x; // 右端ハンドル位置 / right handle x

      if (t.milestone) {
        const cx = x;
        const cy = cyMid;
        const r = h / 2;
        const dia = this.svgEl("path", {
          d: `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`,
          class: "ogantt-milestone" + (overdue ? " is-overdue" : ""),
          fill: color,
        });
        g.appendChild(dia);
        this.attachDrag(g, dia, t);
        lx = cx - r;
        rx = cx + r;
      } else {
        const endStr = anchorEnd(t) ?? aStart;
        const w = Math.max((dayIndex(endStr) - dayIndex(aStart) + 1) * this.ppd, 6);
        const rect = this.svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar" + (overdue ? " is-overdue" : ""), fill: color });
        g.appendChild(rect);
        if (t.progress != null && t.progress > 0) {
          const pw = (w * Math.min(100, t.progress)) / 100;
          g.appendChild(this.svgEl("rect", { x, y, width: pw, height: h, rx: 4, class: "ogantt-bar-progress" }));
        }
        // ラベル（タスク名＋担当）/ label
        // 名前を隠していても、期限切れの ⚠ だけは出す / with the names hidden, the overdue ⚠ still shows
        // 期限切れは、⚠ を大きく、ラベル全体を赤く / overdue: a larger ⚠ and the whole label in red
        const name = this.hideLabels ? "" : t.assignee ? `${t.name} · @${linkLabel(t.assignee)}` : t.name;
        if (overdue || name) {
          const label = this.svgEl("text", { x: x + w + 6, y: cyText(i), class: "ogantt-bar-label" + (overdue ? " is-overdue" : "") });
          if (overdue) label.appendChild(this.svgEl("tspan", { class: "ogantt-overdue-mark" })).textContent = "⚠";
          if (name) label.appendChild(this.svgEl("tspan", overdue ? { dx: 5 } : {})).textContent = name;
          g.appendChild(label);
        }
        this.attachDrag(g, rect, t);
        // 端ホバーで ↔ カーソル、中央は掴むカーソル / ew-resize near edges, grab in the middle
        rect.addEventListener("mousemove", (e: MouseEvent) => {
          const box = rect.getBoundingClientRect();
          const off = e.clientX - box.left;
          rect.style.cursor = off < RESIZE_EDGE || off > box.width - RESIZE_EDGE ? "ew-resize" : "grab";
        });
        rx = x + w;
      }

      // 依存作成用の丸ハンドル（バーから少し離して配置。左=start, 右=finish）/ connector handles, detached from the bar
      // 別レイヤー（最前面）に置くので、表示はバー/ハンドルのホバーで JS 切替（CSS の子孫セレクタが効かないため）
      // they live in the topmost layer, so reveal them via JS hover on the bar or the handle (CSS descendant selector won't reach)
      const HGAP = 11; // バー端からの距離 / gap from the bar edge
      const handleDefs: [number, "start" | "finish"][] = [[lx - HGAP, "start"], [rx + HGAP, "finish"]];
      const handles: SVGElement[] = [];
      for (const [hx, end] of handleDefs) {
        const handle = this.svgEl("circle", { cx: hx, cy: cyMid, r: 5, class: "ogantt-handle" });
        handle.addEventListener("pointerdown", (e: PointerEvent) => this.startLink(g, svg, t, end, e));
        handle.addEventListener("mouseenter", () => handle.classList.add("is-visible"));
        handle.addEventListener("mouseleave", () => handle.classList.remove("is-visible"));
        handlesLayer.appendChild(handle);
        handles.push(handle);
      }
      g.addEventListener("mouseenter", () => handles.forEach((h) => h.classList.add("is-visible")));
      g.addEventListener("mouseleave", () => handles.forEach((h) => h.classList.remove("is-visible")));

      // バーはダブルクリックで詳細パネルを開く（シングルクリックでは開かない＝ドラッグ操作と区別）
      // open the detail panel on double-click only (single click is left for dragging)
      g.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        void this.openDetail(t.path);
      });
      svg.appendChild(g);
    });

    function cyText(i: number): number {
      return i * ROW_H + ROW_H / 2 + 4;
    }
  }

  // ハンドルから線を引いて他タスクへドロップ＝依存作成 / drag from a handle to another task = create dependency
  private startLink(g: SVGGElement, svg: SVGElement, source: Task, sourceEnd: "start" | "finish", ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.dragged.set(g, true); // バーのクリックを抑止 / suppress the bar click
    const handle = ev.target as Element;
    handle.setPointerCapture(ev.pointerId);
    const box = svg.getBoundingClientRect();
    const x1 = ev.clientX - box.left;
    const y1 = ev.clientY - box.top;
    const tmp = this.svgEl("path", { d: `M ${x1} ${y1} L ${x1} ${y1}`, class: "ogantt-link-temp" });
    svg.appendChild(tmp);

    const clearHi = () =>
      svg.querySelectorAll(".is-link-target").forEach((el) => el.removeClass("is-link-target"));
    const onMove = (e: PointerEvent) => {
      const x2 = e.clientX - box.left;
      const y2 = e.clientY - box.top;
      tmp.setAttribute("d", `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`);
      clearHi();
      const row = this.rows[Math.floor(y2 / ROW_H)];
      if (row?.kind === "task" && row.task && row.task.path !== source.path) {
        svg
          .querySelector(`.ogantt-bar-g[data-path="${CSS.escape(row.task.path)}"] .ogantt-bar, .ogantt-bar-g[data-path="${CSS.escape(row.task.path)}"] .ogantt-milestone`)
          ?.addClass("is-link-target");
      }
    };
    const onUp = (e: PointerEvent) => void (async () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      tmp.remove();
      clearHi();
      // クリック抑止フラグはこの後の click 後に解除 / clear the click-suppress flag after the click fires
      window.setTimeout(() => this.dragged.set(g, false), 0);
      const row = this.rows[Math.floor((e.clientY - box.top) / ROW_H)];
      if (row?.kind === "task" && row.task && row.task.path !== source.path) {
        const target = row.task;
        // ドロップ先のどの端か判定（左半分=start, 右半分=finish）/ which end was dropped on
        const tLeft = this.xOf(anchorStart(target) ?? anchorEnd(target)!);
        const tRight = this.xOf(anchorEnd(target) ?? anchorStart(target)!) + this.ppd;
        const targetEnd: "start" | "finish" = e.clientX - box.left < (tLeft + tRight) / 2 ? "start" : "finish";
        // 端の組み合わせで種類を決定 / pick the type from the connected ends
        // 先行=ドラッグ元(source/sourceEnd), 後続=ドロップ先(target/targetEnd)
        let type: DepType | null = null;
        if (sourceEnd === "finish" && targetEnd === "start") type = "FS";
        else if (sourceEnd === "finish" && targetEnd === "finish") type = "FF";
        else if (sourceEnd === "start" && targetEnd === "start") type = "SS";
        else type = null; // start→finish = SF は未対応 / SF unsupported
        if (type == null) {
          new Notice(tr().sfUnsupported);
        } else if (wouldLoop(this.tasks, source.path, target.path)) {
          // 輪になる依存は作らない（日付が決まらなくなる）/ never create a loop (no dates could satisfy it)
          new Notice(tr().depLoop);
        } else {
          // 連動しうるのは target（新しい辺）と、source・target それぞれの SS/FF 後続
          // the cascade can reach target (via the new edge) plus the SS/FF successors of source and target
          const fs = this.plugin.settings.autoScheduleFS;
          const paths = [target.path, ...successorClosure(this.tasks, source.path, fs), ...successorClosure(this.tasks, target.path, fs)];
          await this.mutate(tr().undoAddDep(type), paths, async () => {
            await addDependency(this.app, this.plugin.settings, target.path, source.path, type);
            // メモリにも依存を反映（metadataCache 更新前でも整列できるように）/ reflect dep in-memory
            target.deps = target.deps.filter((dd) => dd.path !== source.path);
            target.deps.push({ path: source.path, type });
            // 新しい依存に沿って後続を動かす（連鎖も）/ move successors along the new dependency (and onward)
            await this.cascade([source.path]);
          });
          this.rerender();
        }
      }
    })();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  // roots の日付変更を依存に沿って後続へ伝える（SS/FF は揃える、FS は設定で押し出す・稼働日で期間を保つ）。
  // ディスクへ書き、メモリ上のタスクも更新する。mutate の中から呼ぶこと
  // propagate the roots' date changes to their successors (SS/FF snap, FS pushes when enabled; durations kept in
  // workdays). Writes to disk and updates the in-memory tasks; call it from inside mutate
  private async cascade(roots: string[]): Promise<void> {
    const changes = cascadeDates(this.tasks, roots, scheduleOptions(this.plugin.settings));
    // 上限を超えた（依存が輪になっている等）ときは、後続を中途半端に動かさず知らせる / past the cap (e.g. a dependency loop) successors stay put and we say so
    if (!changes) return void new Notice(tr().depCascadeLimit);
    for (const [path, d] of changes) {
      const t = this.tasks.find((x) => x.path === path);
      if (!t) continue;
      await writeDates(this.app, this.plugin.settings, path, d.start, d.end, false);
      t.start = d.start;
      t.end = d.end;
    }
  }

  // 開始・期限を書いて後続へ連動する（BoardContext.reschedule の本体）/ write dates and cascade (backs BoardContext.reschedule)
  private async reschedule(path: string, next: { start: string; end: string }, times: { start?: string; end?: string } = {}): Promise<string> {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return next.end;
    const k = this.plugin.settings.keys;
    const tz = this.plugin.settings.tz;
    const end = keepDurationOnStartChange(t, next, scheduleOptions(this.plugin.settings).cal);
    await this.mutate(tr().undoReschedule(t.name), [path, ...this.cascadePaths(path)], async () => {
      await writeField(this.app, path, k.start, combineDateTime(next.start || undefined, times.start, tz));
      await writeField(this.app, path, k.end, combineDateTime(end || undefined, times.end, tz));
      // メモリにも反映して連動に備える（期限のみ＝マイルストーン）/ mirror in memory for the cascade (due only = milestone)
      t.start = next.start || undefined;
      t.end = end || undefined;
      if (!t.start && t.end) t.milestone = true;
      await this.cascade([path]);
    });
    await this.refresh();
    return end;
  }

  // 日付変更で連動しうる後続（Undo のスナップショット対象）/ successors a date change may move (undo snapshot targets)
  private cascadePaths(root: string): string[] {
    return successorClosure(this.tasks, root, this.plugin.settings.autoScheduleFS);
  }

  private drawDependencies(svg: SVGElement): void {
    const rowOf = new Map<string, number>();
    this.rows.forEach((r, i) => {
      if (r.kind === "task") rowOf.set(r.task!.path, i);
    });
    const GAP = 12;
    for (const t of this.tasks) {
      const si = rowOf.get(t.path);
      if (si == null) continue;
      const sStart = anchorStart(t);
      const sEnd = anchorEnd(t);
      if (!sStart || !sEnd) continue;
      const sLeft = this.xOf(sStart);
      const sRight = this.xOf(sEnd) + this.ppd;
      const sy = si * ROW_H + ROW_H / 2;

      for (const dep of t.deps) {
        const pi = rowOf.get(dep.path);
        const pred = this.tasks.find((x) => x.path === dep.path);
        if (pi == null || !pred) continue;
        const pStartD = anchorStart(pred);
        const pEndD = anchorEnd(pred);
        if (!pStartD || !pEndD) continue;
        const pLeft = this.xOf(pStartD);
        const pRight = this.xOf(pEndD) + this.ppd;
        const py = pi * ROW_H + ROW_H / 2;
        const mid = (py + sy) / 2;

        let d: string;
        let mxX: number;
        const mxY = mid;
        let arrowD: string;
        let violation = false;

        if (dep.type === "FS") {
          // 先行の終了 → 後続の開始（左から差し込む）/ pred finish → succ start
          const sx0 = pRight;
          const tx = sLeft;
          // FS は翌日以降が正常。先行end と同日以前は違反 / successor must start the day after; same day or earlier is a violation
          violation = dayIndex(sStart) <= dayIndex(pEndD);
          if (tx - sx0 > GAP * 2) {
            const mx = sx0 + Math.max(GAP, (tx - sx0) / 2);
            d = `M ${sx0} ${py} L ${mx} ${py} L ${mx} ${sy} L ${tx} ${sy}`;
            mxX = mx;
          } else {
            const ax = sx0 + GAP;
            const bx = tx - GAP;
            d = `M ${sx0} ${py} L ${ax} ${py} L ${ax} ${mid} L ${bx} ${mid} L ${bx} ${sy} L ${tx} ${sy}`;
            mxX = (ax + bx) / 2;
          }
          arrowD = `M ${tx} ${sy} l -7 -4 l 0 8 z`; // 右向き / points right
        } else if (dep.type === "SS") {
          // 先行の開始 → 後続の開始（左側を回る）/ pred start → succ start
          const sx0 = pLeft;
          const tx = sLeft;
          violation = dayIndex(sStart) < dayIndex(pStartD);
          const leftMost = Math.min(sx0, tx) - GAP;
          d = `M ${sx0} ${py} L ${leftMost} ${py} L ${leftMost} ${sy} L ${tx} ${sy}`;
          mxX = leftMost;
          arrowD = `M ${tx} ${sy} l -7 -4 l 0 8 z`; // 右向き / points right
        } else {
          // FF: 先行の終了 → 後続の終了（右側を回る）/ pred finish → succ finish
          const sx0 = pRight;
          const tx = sRight;
          violation = dayIndex(sEnd) < dayIndex(pEndD);
          const rightMost = Math.max(sx0, tx) + GAP;
          d = `M ${sx0} ${py} L ${rightMost} ${py} L ${rightMost} ${sy} L ${tx} ${sy}`;
          mxX = rightMost;
          arrowD = `M ${tx} ${sy} l 7 -4 l 0 8 z`; // 左向き / points left
        }

        const succPath = t.path;
        const predPath = dep.path;
        const depType = dep.type;
        const depG = this.svgEl("g", { class: "ogantt-dep-g" });

        const hit = this.svgEl("path", { d, class: "ogantt-dep-hit" });
        const tip = this.svgEl("title", {});
        tip.textContent = tr().depTooltip(depType);
        hit.appendChild(tip);
        depG.appendChild(hit);
        depG.appendChild(this.svgEl("path", { d, class: "ogantt-dep" + (violation ? " is-violation" : "") }));
        depG.appendChild(this.svgEl("path", {
          d: arrowD,
          class: "ogantt-dep-arrow" + (violation ? " is-violation" : ""),
        }));

        // FS 以外は種類ラベルを表示 / show a type label for non-FS
        if (depType !== "FS") {
          const lbl = this.svgEl("text", { x: mxX, y: mxY - 9, class: "ogantt-dep-type" });
          lbl.textContent = depType;
          depG.appendChild(lbl);
        }

        // ホバーで出る × 目印 / X marker shown on hover
        const xg = this.svgEl("g", { class: "ogantt-dep-x" });
        xg.appendChild(this.svgEl("circle", { cx: mxX, cy: mxY, r: 8, class: "ogantt-dep-x-bg" }));
        xg.appendChild(this.svgEl("path", {
          d: `M ${mxX - 3} ${mxY - 3} L ${mxX + 3} ${mxY + 3} M ${mxX + 3} ${mxY - 3} L ${mxX - 3} ${mxY + 3}`,
          class: "ogantt-dep-x-mark",
        }));
        depG.appendChild(xg);

        // クリック → 確認なしで即切断（Ctrl+Z で取り消し可）/ click → remove immediately (undo with Ctrl+Z)
        depG.addEventListener("click", (ev: MouseEvent) => void (async () => {
          ev.stopPropagation();
          await this.mutate(tr().undoRemoveDep(depType), [succPath], () =>
            removeDependency(this.app, this.plugin.settings, succPath, predPath)
          );
          await this.refresh();
        })());
        svg.appendChild(depG);
      }
    }
  }

  // バー/菱形のドラッグで日付を書き戻す / drag a bar or diamond to reschedule
  private attachDrag(g: SVGGElement, handle: SVGElement, task: Task): void {
    const EDGE = RESIZE_EDGE;
    const milestone = task.milestone;
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      // preventDefault はフォーカスを移さないため、入力中の欄を明示的に外す（Ctrl+Z をガント側へ）
      // preventDefault keeps focus on a previously focused input; blur it so Ctrl+Z reaches the gantt undo
      (activeDocument.activeElement as HTMLElement | null)?.blur?.();
      this.dragged.set(g, false);
      const startX = ev.clientX;
      handle.setPointerCapture(ev.pointerId);

      let mode: "move" | "l" | "r" = "move";
      let x0 = 0;
      let w0 = 0;
      if (!milestone) {
        x0 = parseFloat(handle.getAttribute("x")!);
        w0 = parseFloat(handle.getAttribute("width")!);
        // rect 実画面座標から相対オフセットを求める（SVG の offsetX は不正確）
        // use screen box for offset; SVG offsetX is unreliable in Chromium
        const box = handle.getBoundingClientRect();
        const offset = ev.clientX - box.left;
        mode = offset < EDGE ? "l" : offset > box.width - EDGE ? "r" : "move";
      }

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 3) this.dragged.set(g, true);
        if (milestone) {
          g.setAttribute("transform", `translate(${dx},0)`);
          return;
        }
        if (mode === "move") handle.setAttribute("x", String(x0 + dx));
        else if (mode === "r") handle.setAttribute("width", String(Math.max(this.ppd, w0 + dx)));
        else {
          handle.setAttribute("x", String(x0 + dx));
          handle.setAttribute("width", String(Math.max(this.ppd, w0 - dx)));
        }
      };
      const onUp = (e: PointerEvent) => void (async () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        const dxDays = Math.round((e.clientX - startX) / this.ppd);
        if (dxDays !== 0) {
          await this.mutate(tr().undoReschedule(task.name), [task.path, ...this.cascadePaths(task.path)], async () => {
            if (milestone) {
              const nd = dayToStr(dayIndex(task.end ?? task.start!) + dxDays);
              await writeDates(this.app, this.plugin.settings, task.path, nd, nd, true);
              task.end = nd; // メモリ更新 / update in-memory
            } else {
              const s0 = dayIndex(task.start!);
              const e0 = dayIndex(task.end ?? task.start!);
              let ns = s0;
              let ne = e0;
              if (mode === "move") {
                ns = s0 + dxDays;
                ne = e0 + dxDays;
              } else if (mode === "r") {
                ne = Math.max(s0, e0 + dxDays);
              } else {
                ns = Math.min(e0, s0 + dxDays);
              }
              const nsS = dayToStr(ns);
              const neS = dayToStr(ne);
              await writeDates(this.app, this.plugin.settings, task.path, nsS, neS, false);
              task.start = nsS; // メモリ更新 / update in-memory
              task.end = neS;
            }
            // 後続を連動（メモリ更新＋ディスク書き込み）/ cascade to successors
            await this.cascade([task.path]);
          });
          // メモリから即再描画（ディスク再読込前に正しい位置を表示）/ render from memory for instant correct positions
          this.rerender();
        } else {
          // 日数変化なし＝クリック扱い。動かした分を視覚的に元へ戻すだけ（再描画しない）。
          // これで要素が残り click/dblclick が発火し、詳細パネルを開ける。
          // No day change = a click: reset any sub-threshold movement without re-rendering,
          // so the element survives and click/dblclick fire to open the detail panel.
          if (milestone) {
            g.removeAttribute("transform");
          } else {
            handle.setAttribute("x", String(x0));
            handle.setAttribute("width", String(w0));
          }
        }
      })();
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ----- 新規タスク作成 / create a new task -----
  // 今のフォルダにタスクを作り（既定は 1 日タスク＝開始・終了とも今日。設定でバックログ＝日付なしにできる）、詳細パネルを開いて命名を促す
  // create a task in the current folder (by default a 1-day task, start = end = today; a setting makes it a backlog task with no dates), then open the panel to name it
  private createNewTask(): Promise<void> {
    return this.createTaskWith();
  }

  // タスクを作る。status を渡すとそのステータスで（カンバンの列の「＋」）、parentPath を渡すとそのタスクのサブタスクとして。サブタスクは親と同じフォルダに作る（サブツリーは同じフォルダに同居する決まり）
  // create a task; with `status` it gets that status (a Kanban column's "+"), with `parentPath` it is that task's subtask, made in its parent's folder (a subtree lives in one folder)
  private async createTaskWith(opts: { status?: string; parentPath?: string } = {}): Promise<void> {
    const parentFile = opts.parentPath ? this.app.vault.getAbstractFileByPath(opts.parentPath) : null;
    const parent = parentFile instanceof TFile ? parentFile : null;
    if (opts.parentPath && !parent) return;
    const folder = parent ? (parent.parent?.path ?? this.folder) : this.folder;
    let created: string | null = null;
    await this.mutate(tr().undoCreate(tr().newTaskName), [], async () => {
      const file = await createTask(this.app, folder, tr().newTaskName);
      if (!file) return false;
      const k = this.plugin.settings.keys;
      // 設定が today なら開始・期限とも今日、backlog なら日付を入れない / "today" fills start and due with today; "backlog" leaves the dates empty
      const dates = newTaskDates(this.plugin.settings.newTaskDates, dayToStr(todayIndex()));
      if (dates) {
        await writeField(this.app, file.path, k.start, dates.start);
        await writeField(this.app, file.path, k.end, dates.end);
      }
      if (opts.status) await writeField(this.app, file.path, k.status, opts.status);
      if (parent) {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          fm[k.parent] = this.app.fileManager.generateMarkdownLink(parent, file.path);
        });
      }
      created = file.path;
      return { created: [file.path] };
    });
    if (!created) return;
    if (parent) this.kanbanExpanded.add(parent.path); // 作ったサブタスクが見えるように、親のカードを開く / open the parent's card so the new subtask shows
    await this.refresh();
    await this.openDetail(created, true);
  }

  // ----- ドラッグ＆ドロップ（フォルダへ＝親解除して移動／タスクへ＝サブタスク化）-----
  // ----- drag & drop (onto a folder = detach + move; onto a task = make subtask) -----
  // タスク行をドラッグ可能にする / make a task row draggable
  private makeDraggableTask(row: HTMLElement, path: string): void {
    // 行のドラッグは、名前のセルを押したときだけ。ほかのセルのドラッグは、範囲の選択に使う
    // a row drags only when pressed on its name cell; a drag from any other cell selects a range
    row.setAttr("draggable", "false");
    row.addEventListener("mousedown", (e: MouseEvent) => row.setAttr("draggable", (e.target as HTMLElement).closest(".ogantt-td-name") ? "true" : "false"));
    row.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => row.removeClass("is-dragging"));
  }

  // 行をドロップ先にする（ドロップ時に handler(srcPath) を呼ぶ）/ make a row a drop target
  private makeDropTarget(row: HTMLElement, handler: (srcPath: string) => void): void {
    row.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault(); // preventDefault でドロップを許可 / allow dropping
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      row.addClass("is-drop-target");
    });
    row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
    row.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      row.removeClass("is-drop-target");
      const src = e.dataTransfer?.getData("text/plain");
      if (src) handler(src);
    });
  }

  // タスクパスの所属フォルダ（無ければ Vault ルート＝""）/ a task's folder dir ("" = vault root)
  private taskFolder(path: string): string {
    return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  }

  // 親の設定/解除＋サブツリー移動を実行して再描画（取り消し可）/ set/clear parent, move subtree, re-render (undoable)
  // parentTaskPath != null → サブタスク化（その親フォルダへ）／null → 解除（destFolder のトップレベルへ）
  private async reparentTo(srcPath: string, destFolder: string, parentTaskPath: string | null): Promise<void> {
    if (srcPath === parentTaskPath) return; // 自分自身へは不可 / not onto itself
    // 循環防止：親が src の子孫であってはならない / cycle guard: parent must not be a descendant of src
    if (parentTaskPath && subtreePaths(this.tasks, srcPath).includes(parentTaskPath)) {
      new Notice(tr().cycleBlocked);
      return;
    }
    const pf = parentTaskPath ? this.app.vault.getAbstractFileByPath(parentTaskPath) : null;
    const parentFile = pf instanceof TFile ? pf : null;
    const name = this.tasks.find((t) => t.path === srcPath)?.name ?? srcPath;
    const label = parentTaskPath ? tr().undoSubtask(name) : tr().undoDetach(name);
    let moves: Move[] = [];
    const ok = await this.mutate(label, [srcPath], async () => {
      const res = await reparentTask(this.app, this.plugin.settings, this.tasks, srcPath, destFolder, parentFile);
      if (!res) return false;
      moves = res.moves;
      return { moves };
    });
    if (!ok) return;
    const srcMove = moves.find((m) => m.from === srcPath);
    if (srcMove && this.selectedPath === srcPath) this.selectedPath = srcMove.to;
    await this.refresh();
  }

  // タググループへのドロップでタグを付与（取り消し可・既に付いていれば何もしない）/ add a tag via drop (undoable; no-op if already tagged)
  private async addTagTo(srcPath: string, tag: string): Promise<void> {
    const pre = this.tasks.find((x) => x.path === srcPath);
    if (!pre || pre.tags.includes(tag)) return;
    await this.mutate(tr().undoAddTag(pre.name, tag), [srcPath], async () => (await addTag(this.app, srcPath, tag)) || false);
    // 背景 refresh で this.tasks が作り替わる場合に備え、最新を引き直して更新 / look up the live task (survives a background refresh)
    const live = this.tasks.find((x) => x.path === srcPath);
    if (live && !live.tags.includes(tag)) live.tags.push(tag);
    this.rerender();
  }

  // ----- 詳細パネル（編集モード）/ editable detail slide-over -----
  private async openDetail(path: string, focusTitle = false): Promise<void> {
    this.selectedPath = path;
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    // 選択行ハイライト更新 / refresh selection highlight
    this.tbodyEl?.querySelectorAll(".ogantt-tr.is-selected").forEach((el) => el.removeClass("is-selected"));
    this.tbodyEl?.querySelector(`.ogantt-tr[data-path="${CSS.escape(path)}"]`)?.addClass("is-selected");
    this.gridHost?.querySelectorAll(".ogantt-kcard.is-selected").forEach((el) => el.removeClass("is-selected"));
    this.gridHost?.querySelector(`.ogantt-kcard[data-path="${CSS.escape(path)}"]`)?.addClass("is-selected");

    const k = this.plugin.settings.keys;
    const d = this.detailEl;
    d.empty();
    d.addClass("is-open");
    d.style.width = `${this.plugin.settings.detailWidth}px`;

    // 左端の幅リサイズハンドル / left-edge width resize handle
    const resizer = d.createDiv({ cls: "ogantt-detail-resizer" });
    this.attachResize(resizer, d);

    // ヘッダー: タイトル＝ファイル名（編集でリネーム）/ header: title input renames the file
    const header = d.createDiv({ cls: "ogantt-detail-head" });
    const titleInput = header.createEl("input", { cls: "ogantt-detail-title", type: "text" });
    titleInput.value = t.name;
    titleInput.addEventListener("change", () => void this.renameTaskTo(this.selectedPath!, t.name, titleInput.value));
    // 新規作成直後は名前を選択状態にして即リネームできるように / select the name right after creation
    if (focusTitle) window.setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);
    const openBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(openBtn, "external-link");
    openBtn.setAttr("aria-label", tr().openAsNote);
    openBtn.onclick = () => void this.app.workspace.openLinkText(this.selectedPath!, "", true);
    // ゴミ箱アイコン＝削除メニュー / trash icon = delete menu
    const delBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(delBtn, "trash-2");
    delBtn.setAttr("aria-label", tr().menuDelete);
    delBtn.onclick = (e) => {
      const m = new Menu();
      m.addItem((i) => i.setTitle(tr().menuDelete).setIcon("trash-2").onClick(() => {
        if (this.selectedPath) this.confirmDelete(this.selectedPath);
      }));
      m.showAtMouseEvent(e);
    };
    const closeBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => d.removeClass("is-open");

    const meta = d.createDiv({ cls: "ogantt-detail-meta" });
    const fieldRow = (label: string): HTMLElement => {
      const r = meta.createDiv({ cls: "ogantt-detail-row" });
      r.createSpan({ cls: "ogantt-detail-label", text: label });
      return r.createDiv({ cls: "ogantt-detail-field" });
    };

    // 開始・終了を1つのカレンダーで範囲指定（ClickUp 風・横並び・各×でクリア）
    // start & end via one range calendar (ClickUp-style: side by side, each clearable with ×)
    this.buildDates(meta, t);

    // ステータス / status
    const statusSel = fieldRow(tr().fieldStatus).createEl("select");
    statusSel.createEl("option", { text: "—", value: "" });
    for (const s of this.plugin.settings.statuses) {
      const opt = statusSel.createEl("option", { text: s.label, value: s.id });
      if (s.id === t.status) opt.selected = true;
    }
    statusSel.addEventListener("change", () => void this.saveField(k.status, statusSel.value));

    // 担当 / assignee（wikilink はリンク表示。リンク以外の所をクリックで入力欄に、"[[" でノート候補）
    // assignee: a wikilink shows as a link; click elsewhere in the field to edit, "[[" suggests notes
    const asgField = fieldRow(tr().fieldAssignee);
    asgField.addClass("ogantt-assignee-field");
    const asgView = asgField.createDiv({ cls: "ogantt-assignee-view" });
    const asgIn = asgField.createEl("input", { type: "text" });
    const paintAsg = () => {
      asgView.empty();
      if (t.assignee) renderLinkValue(asgView, t.assignee, "ogantt-assignee-text");
      else asgView.createSpan({ cls: "ogantt-muted", text: "—" });
    };
    paintAsg();
    wireLinkHover(this.app, asgView, this, t.path);
    asgView.addEventListener("click", (e) => {
      if (handleLinkClick(this.app, e, t.path)) return;
      asgIn.value = t.assignee ?? "";
      asgField.addClass("is-editing");
      asgIn.focus();
    });
    attachLinkSuggest(this.app, asgIn, t.path);
    asgIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); asgIn.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); asgIn.value = t.assignee ?? ""; asgIn.blur(); }
    });
    asgIn.addEventListener("blur", () => void (async () => {
      asgField.removeClass("is-editing");
      const v = asgIn.value.trim();
      if (v === (t.assignee ?? "")) return;
      t.assignee = v || undefined; // 再描画前でも表示を合わせる / keep the view in step before the refresh
      paintAsg();
      await this.saveField(k.assignee, v);
    })());

    // タグ（多値・チップ＋×で削除、入力＋Enterで追加。付与は D&D も可）/ tags: chips with × to remove, input+Enter to add (also via drag)
    const tagField = fieldRow(tr().fieldTags);
    tagField.addClass("ogantt-tags-field");
    for (const tag of t.tags) {
      const chip = tagField.createSpan({ cls: "ogantt-tag-chip" });
      this.paintTagChip(chip, tag);
      chip.createSpan({ text: tag });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().removeTagAria);
      x.addEventListener("click", () => void (async () => {
        const path = this.selectedPath;
        if (!path) return;
        await this.mutate(tr().undoRemoveTag(t.name, tag), [path], () => removeTag(this.app, path, tag));
        // 背景 refresh が this.tasks を作り替えるので、クロージャの t ではなく最新を引き直して更新
        // a background refresh may rebuild this.tasks, so look up the live task (not the closure's t)
        const live = this.tasks.find((x) => x.path === path);
        if (live) live.tags = live.tags.filter((y) => y !== tag);
        this.rerender();
        if (this.selectedPath) await this.openDetail(this.selectedPath); // パネルを再描画 / refresh the panel
      })());
    }
    const tagAdd = tagField.createEl("input", { cls: "ogantt-tag-add", type: "text" });
    tagAdd.placeholder = tr().addTagPlaceholder;
    // Vault 内の既存タグを候補に（付与済みは除く）/ suggest the vault's tags, minus the ones already on this task
    this.attachSingleTagSuggestions(tagAdd, t.tags);
    tagAdd.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tagAdd.blur(); } });
    tagAdd.addEventListener("change", () => void (async () => {
      const v = tagAdd.value.trim().replace(/^#/, "");
      const path = this.selectedPath;
      if (!v || !path) return;
      await this.mutate(tr().undoAddTag(t.name, v), [path], async () => (await addTag(this.app, path, v)) || false);
      // 最新オブジェクトを引き直してメモリ更新→即再描画 / look up the live task, update in-memory, re-render
      const live = this.tasks.find((x) => x.path === path);
      if (live && !live.tags.includes(v)) live.tags.push(v);
      this.rerender();
      if (this.selectedPath) await this.openDetail(this.selectedPath); // パネルを再描画 / refresh the panel
    })());

    // 親タスク（ある場合のみ・チップ＋×で解除。設定は D&D が主）/ parent task (shown when set; × detaches. set via drag)
    if (t.parent) {
      const pf = fieldRow(tr().fieldParent);
      const parentTask = this.tasks.find((x) => x.path === t.parent);
      const chip = pf.createSpan({ cls: "ogantt-parent-chip" });
      chip.createSpan({ text: parentTask?.name ?? t.parent });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().clearDate);
      x.addEventListener("click", () => void (async () => {
        if (!this.selectedPath) return;
        await this.reparentTo(this.selectedPath, this.taskFolder(this.selectedPath), null); // 親を解除＝トップレベルへ / detach
        if (this.selectedPath) await this.openDetail(this.selectedPath); // パネルを再描画 / refresh the panel
      })());
    }

    // 進捗 / progress（スライダー＋%表示。ドラッグ中は表示のみ更新、離したら保存＝バーに反映）
    // progress slider + % label; updates the label while dragging, saves on release (reflected in the bar)
    const progField = fieldRow(tr().fieldProgress);
    progField.addClass("ogantt-progress-field");
    const progRange = progField.createEl("input", { type: "range" });
    progRange.min = "0";
    progRange.max = "100";
    progRange.step = "5";
    progRange.value = String(t.progress ?? 0);
    const progVal = progField.createSpan({ cls: "ogantt-progress-val", text: `${t.progress ?? 0}%` });
    progRange.addEventListener("input", () => progVal.setText(`${progRange.value}%`));
    progRange.addEventListener("change", () => void (async () => {
      const path = this.selectedPath;
      if (!path) return;
      // 0% は未設定として削除、それ以外は数値で保存 / drop at 0% (unset), otherwise store the number
      const n = Number(progRange.value);
      await this.mutate(tr().undoEdit(t.name), [path], () => writeField(this.app, path, k.progress, n > 0 ? n : undefined));
      await this.refresh();
    })());

    // Google カレンダー同期（接続済みのときのみ表示）/ Google Calendar sync (shown only while connected)
    const g = this.plugin.settings.gcal;
    if (g.calendarId && isConnected(this.plugin)) {
      const gf = fieldRow(tr().fieldGcal);
      const box = gf.createEl("input", { type: "checkbox" });
      const file = this.app.vault.getAbstractFileByPath(t.path);
      const fm: Record<string, unknown> | undefined = file instanceof TFile
        ? this.app.metadataCache.getFileCache(file)?.frontmatter
        : undefined;
      const flag = fm?.[k.gcal];
      box.checked = !g.optInOnly || flag === true || flag === "true";
      box.disabled = !g.optInOnly; // 全タスク同期モードでは個別選択なし / no per-task choice when everything syncs
      box.addEventListener("change", () => void (async () => {
        const path = this.selectedPath;
        if (!path) return;
        await this.mutate(tr().undoEdit(t.name), [path], () => writeField(this.app, path, k.gcal, box.checked ? true : undefined));
        schedulePush(this.plugin); // 反映（またはオプトアウトのイベント削除）を予約 / schedule the push (or the opt-out cleanup)
      })());
      const link = g.state[t.path]?.link;
      if (link) {
        const a = gf.createEl("a", { text: tr().gcalOpenEvent, href: link });
        a.setAttr("target", "_blank");
      }
    }

    // カスタムフィールド（設定で宣言した任意のフロントマターのキー）：表と同じ値を、パネルでも見て編集できる。表の列を隠していても出す
    // custom fields (frontmatter keys declared in the settings): the same values as the table, viewable and editable here too, even when their column is hidden
    for (const f of validCustomFields(this.plugin.settings)) {
      const label = f.label.trim() || f.key.trim();
      const key = f.key.trim();
      const stored = t.custom[f.id];
      const input = fieldRow(label).createEl("input", { type: f.type === "number" ? "number" : f.type === "date" ? "date" : "text" });
      input.setAttr("aria-label", tr().editCustomField(label));
      let current = f.type === "date" ? (typeof stored === "string" ? stored : "") : customValueText(stored);
      input.value = current;
      const commit = async (): Promise<void> => {
        const raw = input.value;
        if (raw === current) return;
        // 表と同じ解釈：空なら削除、数値にならない入力は書き込まない、リストだった値はカンマで分けてリストのまま
        // read it as the table does: blank deletes, a non-number isn't written, a list value is split back into a list
        const next = f.type === "date" ? raw || undefined : parseCustomInput(raw, f.type, Array.isArray(stored));
        if (next === null) {
          input.value = current;
          return;
        }
        current = raw;
        await this.mutate(tr().undoEdit(t.name), [t.path], () => writeField(this.app, t.path, key, next));
        await this.refresh();
      };
      input.addEventListener("change", () => void commit());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          input.value = current;
          input.blur();
        }
      });
    }

    // 本文 / body（既定は Obsidian と同じレンダリング表示。クリックで編集、フォーカスを外すと保存して表示に戻る）
    // body: rendered like Obsidian's reading view by default; click to edit, blur saves and returns to the rendered view
    d.createDiv({ cls: "ogantt-detail-label", text: tr().fieldBody });
    const bodyWrap = d.createDiv({ cls: "ogantt-detail-body" });
    const preview = bodyWrap.createDiv({ cls: "ogantt-detail-body-preview markdown-rendered" });
    const bodyArea = bodyWrap.createEl("textarea", { cls: "ogantt-detail-body-edit" });
    let bodyText = await readBody(this.app, t.path);

    const renderPreview = async (): Promise<void> => {
      preview.empty();
      if (bodyText.trim()) await MarkdownRenderer.render(this.app, bodyText, preview, t.path, this);
      else preview.createSpan({ cls: "ogantt-muted", text: tr().noneLabel });
    };
    await renderPreview();

    const autosize = () => {
      // 高さを一旦リセットしてから内容に合わせる / reset, then fit to content
      // 変数とドラッグで付いた高さを外すと内容の高さ（auto）になるので、それを測って変数に入れる
      // dropping the variable and any height from a drag resize leaves the content's own height (auto); measure it and put it in the variable
      bodyArea.style.removeProperty("--ogantt-body-h");
      bodyArea.style.removeProperty("height");
      bodyArea.setCssProps({ "--ogantt-body-h": `${bodyArea.scrollHeight + 2}px` });
    };
    wireLinkHover(this.app, preview, this, t.path);
    preview.addEventListener("click", (e) => {
      // リンク・チェックボックスのクリックは編集モードに入らない / clicks on links or checkboxes don't enter edit mode
      if (handleLinkClick(this.app, e, t.path)) return;
      if ((e.target as HTMLElement).closest("input")) return;
      bodyArea.value = bodyText;
      bodyWrap.addClass("is-editing");
      autosize();
      bodyArea.focus();
    });
    bodyArea.addEventListener("input", autosize);
    attachLinkSuggest(this.app, bodyArea, t.path);
    bodyArea.addEventListener("blur", () => void (async () => {
      const path = this.selectedPath;
      if (path && bodyArea.value !== bodyText) {
        bodyText = bodyArea.value;
        await this.mutate(tr().undoEdit(t.name), [path], () => writeBody(this.app, path, bodyText));
      }
      bodyWrap.removeClass("is-editing");
      await renderPreview();
    })());
  }

  // 確認ダイアログを挟んでタスクを削除（ゴミ箱へ）/ confirm, then delete the task (to trash)
  private confirmDelete(path: string): void {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const hasChildren = this.tasks.some((x) => x.parent === path);
    new ConfirmModal(this.app, {
      title: tr().confirmDeleteTitle,
      body: tr().confirmDeleteBody(t.name),
      sub: hasChildren ? tr().confirmDeleteChildren : undefined,
      confirmText: tr().menuDelete,
      cancelText: tr().cancel,
      onConfirm: () => void (async () => {
        const ok = await this.mutate(tr().undoDelete(t.name), [path], async () =>
          (await deleteTask(this.app, path)) ? { deleted: [path] } : false
        );
        if (!ok) return;
        // 削除したタスクの詳細が開いていたら閉じる / close the detail panel if it showed the deleted task
        if (this.selectedPath === path) this.closeDetail();
        new Notice(tr().deletedNotice(t.name));
        await this.refresh();
      })(),
    }).open();
  }

  // フィールド保存（空なら削除）/ save a frontmatter field (delete if empty)
  private async saveField(key: string, value: string): Promise<void> {
    const path = this.selectedPath;
    if (!path) return;
    const name = this.tasks.find((x) => x.path === path)?.name ?? path;
    await this.mutate(tr().undoEdit(name), [path], () => writeField(this.app, path, key, value === "" ? undefined : value));
    await this.refresh();
  }

  // 日付エリア：開始・終了を横並びチップで表示、各×でクリア、クリックで範囲カレンダーを開く
  // dates area: start & end chips side by side, each clearable with ×, click opens the range calendar
  private buildDates(meta: HTMLElement, t: Task): void {
    const fmt = this.plugin.settings.dateFormat;
    const state = { start: t.start ?? "", end: t.end ?? "" };
    // 時刻（任意）。日付があるときだけ編集できる / optional time of day, editable only when the date is set
    const times = { start: t.startTime ?? "", end: t.endTime ?? "" };

    const row = meta.createDiv({ cls: "ogantt-detail-row" });
    row.createSpan({ cls: "ogantt-detail-label", text: tr().fieldDates });
    const chips = row.createDiv({ cls: "ogantt-detail-field ogantt-date-chips" });

    const painters: (() => void)[] = [];
    const repaint = () => painters.forEach((p) => p());

    // 開始・終了を両方フロントマターへ（空は削除・時刻があれば日付に併記）
    // persist both ends (delete when empty; append the time of day when set)
    const save = async (): Promise<void> => {
      if (!this.selectedPath) return;
      // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
      if (state.start && !state.end) state.end = state.start;
      // 同日で 開始時刻 > 終了時刻 は無効 → 終了=開始に補正 / clamp so start ≤ end within the same day
      if (state.start && state.start === state.end && times.start && times.end && times.end < times.start) {
        times.end = times.start;
      }
      repaint(); // 補正を即時反映 / reflect any clamping right away
      state.end = await this.reschedule(this.selectedPath, state, times);
      repaint(); // 期間を保って動いた期限日を反映 / show a due date moved to keep the duration
    };

    const makeChip = (which: "start" | "end"): void => {
      const chip = chips.createDiv({ cls: "ogantt-date-chip" });
      const ico = chip.createSpan({ cls: "ogantt-date-ico" });
      setIcon(ico, "calendar");
      const val = chip.createSpan({ cls: "ogantt-date-val" });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().clearDate);
      const paint = () => {
        const iso = state[which];
        // ×の表示/非表示は .is-empty に応じて CSS 側で制御 / × visibility is handled by CSS via .is-empty
        if (iso) {
          // 時刻があれば日付の後ろに表示 / show the time of day after the date when set
          val.setText(formatDate(iso, fmt) + (times[which] ? ` ${times[which]}` : ""));
          chip.removeClass("is-empty");
        } else {
          val.setText(which === "start" ? tr().fieldStart : tr().fieldDue);
          chip.addClass("is-empty");
        }
      };
      painters.push(paint);
      chip.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".ogantt-date-x")) return; // ×は別処理 / handled below
        this.openRangePicker(chip, state, which, repaint, save);
      });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        state[which] = "";
        repaint();
        void save();
      });
    };

    makeChip("start");
    makeChip("end");

    // 時刻入力（開始・終了）：手動入力は1分単位、時計アイコンは時・分（10分刻み）ドロップダウン
    // ネイティブピッカーは step を無視して1分刻みになる（Chromium）ため、アイコン側は自前ポップアップ
    // time-of-day for start & end: manual typing at 1-minute precision, the clock icon opens
    // hour + minute (10-min steps) dropdowns (Chromium's native picker ignores `step`)
    const trow = meta.createDiv({ cls: "ogantt-detail-row" });
    trow.createSpan({ cls: "ogantt-detail-label", text: tr().fieldTime });
    const tfield = trow.createDiv({ cls: "ogantt-detail-field ogantt-time-inputs" });
    const makeTime = (which: "start" | "end"): void => {
      const wrap = tfield.createDiv({ cls: "ogantt-time-wrap" });
      const inp = wrap.createEl("input", { cls: "ogantt-time-input", type: "time" });
      const btn = wrap.createEl("button", { cls: "clickable-icon ogantt-time-btn" });
      setIcon(btn, "clock");
      btn.setAttr("aria-label", tr().fieldTime);
      const paint = () => {
        inp.value = times[which];
        const dis = !state[which] || (which === "start" && t.milestone);
        inp.disabled = dis;
        btn.disabled = dis;
      };
      painters.push(paint);
      const apply = (v: string) => {
        times[which] = v;
        // 同日で開始>終了になったら常に「終了=開始」へ補正（開始は変更しない）
        // if start > end on the same day, always clamp end = start (never move the start)
        if (state.start && state.start === state.end && times.start && times.end && times.end < times.start) {
          times.end = times.start;
        }
        repaint(); // チップの時刻表示を更新 / refresh the time shown on the chips
        void save();
      };
      inp.addEventListener("change", () => apply(inp.value)); // 手動入力は1分単位OK / manual entry: any minute
      btn.addEventListener("click", () => this.openTimeDropdown(btn, times[which], apply));
    };
    makeTime("start");
    makeTime("end");

    // 期間（稼働日数）。変えると開始日を保って期限日が動く（開始日が無ければ今日から）
    // duration in workdays: changing it keeps the start and moves the due date (from today when there's no start)
    const cal = scheduleOptions(this.plugin.settings).cal;
    const drow = meta.createDiv({ cls: "ogantt-detail-row" });
    drow.createSpan({ cls: "ogantt-detail-label", text: tr().colDuration });
    const dfield = drow.createDiv({ cls: "ogantt-detail-field" });
    const dinp = dfield.createEl("input", { cls: "ogantt-duration-input", type: "number" });
    dinp.min = "1";
    dinp.step = "1";
    dinp.setAttr("aria-label", tr().colDuration);
    painters.push(() => {
      const d = t.milestone ? undefined : taskDuration({ start: state.start || undefined, end: state.end || undefined, milestone: false }, cal);
      dinp.value = d != null ? String(d) : "";
      dinp.disabled = t.milestone;
    });
    dinp.addEventListener("change", () => {
      const n = parseDuration(dinp.value);
      if (n == null) {
        repaint(); // 1 以上の整数でなければ元に戻す / revert anything but a whole number ≥ 1
        return;
      }
      state.start = state.start || dayToStr(todayIndex());
      state.end = dayToStr(endForDuration(dayIndex(state.start), n, cal));
      repaint();
      void save();
    });
    repaint();
  }

  // 時計アイコンのポップアップ：時・分（10分刻み）のドロップダウンで時刻を選ぶ。×で時刻クリア
  // clock-icon popup: pick a time with hour + minute (10-min steps) dropdowns; × clears the time
  private openTimeDropdown(anchor: HTMLElement, current: string, apply: (v: string) => void): void {
    activeDocument.querySelectorAll(".ogantt-timepick").forEach((e) => e.remove());
    const pad = (n: number): string => String(n).padStart(2, "0");
    const pop = activeDocument.body.createDiv({ cls: "ogantt-timepick" });
    const close = () => {
      pop.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!pop.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);

    const [ch, cm] = /^\d{2}:\d{2}$/.test(current) ? current.split(":") : ["09", "00"];
    const hourSel = pop.createEl("select", { cls: "dropdown" });
    for (let h = 0; h < 24; h++) hourSel.createEl("option", { value: pad(h), text: pad(h) });
    hourSel.value = ch;
    pop.createSpan({ text: ":" });
    const minSel = pop.createEl("select", { cls: "dropdown" });
    for (let m = 0; m < 60; m += 10) minSel.createEl("option", { value: pad(m), text: pad(m) });
    // 10分刻みに乗らない既存値（手動入力等）も選べるように / keep an off-grid minute (manual entry) selectable
    if (!minSel.querySelector(`option[value="${cm}"]`)) minSel.createEl("option", { value: cm, text: cm });
    minSel.value = cm;
    const onPick = () => apply(`${hourSel.value}:${minSel.value}`);
    hourSel.addEventListener("change", onPick);
    minSel.addEventListener("change", onPick);
    const clr = pop.createEl("button", { cls: "clickable-icon" });
    setIcon(clr, "x");
    clr.setAttr("aria-label", tr().clearDate);
    clr.onclick = () => { apply(""); close(); };

    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  }

  // 非 name 列のセルを描き、読み取り専用でなければダブルクリックの編集を付ける
  // paint a non-name cell and, unless it's read-only, attach the double-click editor
  private renderCell(td: HTMLElement, row: Row, col: CellColumn): void {
    td.dataset.col = col.id;
    this.wireCellSelect(td, row.task!.path, col.id);
    if (col.paint(this.board, td, row) === false) {
      td.dataset.ro = "1"; // 読み取り専用のセル（貼り付け・フィルの対象外）/ a read-only cell (skipped by paste and fill)
      return;
    }
    this.makeEditableCell(td, col.editAria(), (cell) => col.edit(this.board, cell, row));
  }

  // 列定義などの部品に渡す窓口（GanttView 全体は渡さない）/ the surface handed to parts like column defs (never the whole view)
  private boardCtx: BoardContext | null = null;
  private get board(): BoardContext {
    if (!this.boardCtx) {
      const settings = () => this.plugin.settings;
      const tasks = () => this.tasks;
      const rollup = () => this.rollup;
      this.boardCtx = {
        app: this.app,
        get settings() { return settings(); },
        get tasks() { return tasks(); },
        get rollup() { return rollup(); },
        mutate: (label, paths, fn) => this.mutate(label, paths, fn),
        reschedule: (path, next, times) => this.reschedule(path, next, times),
        refresh: () => this.refresh(),
        rerender: () => this.rerender(),
        inlineInput: (cell, value, repaint, commit, configure) => this.inlineInput(cell, value, repaint, commit, configure),
        openPopover: (anchor, cls, build) => this.openPopover(anchor, cls, build),
        openRangePicker: (anchor, state, active, repaint, save, single) => this.openRangePicker(anchor, state, active, repaint, save, single),
        attachSuggestions: (inp, fill) => this.attachSuggestions(inp, fill),
        attachSingleTagSuggestions: (inp, exclude) => this.attachSingleTagSuggestions(inp, exclude),
        paintTagChip: (chip, tag) => this.paintTagChip(chip, tag),
        openColorMenu: (e, kind, name) => this.openColorMenu(e, kind, name),
      };
    }
    return this.boardCtx;
  }

  // ----- テーブルのセル選択・コピー・貼り付け・フィル / table cell selection, copy, paste and fill -----

  private selRows(): string[] {
    return this.rows.filter((r) => r.kind === "task").map((r) => r.task!.path);
  }

  private selCols(): string[] {
    return this.visibleColumns().map((c) => c.id);
  }

  // 選択範囲（行・列の番号）。選んだセルが今の表に無ければ null / the selected range as row and column indexes; null when a selected cell isn't in the table now
  private selRect(): { r0: number; r1: number; c0: number; c1: number } | null {
    const s = this.cellSel;
    if (!s) return null;
    const rows = this.selRows();
    const cols = this.selCols();
    const ra = rows.indexOf(s.anchor.path);
    const rb = rows.indexOf(s.focus.path);
    const ca = cols.indexOf(s.anchor.col);
    const cb = cols.indexOf(s.focus.col);
    if (ra < 0 || rb < 0 || ca < 0 || cb < 0) return null;
    return { r0: Math.min(ra, rb), r1: Math.max(ra, rb), c0: Math.min(ca, cb), c1: Math.max(ca, cb) };
  }

  private cellEl(path: string, col: string): HTMLElement | null {
    const tr = this.tbodyEl?.querySelector<HTMLElement>(`.ogantt-tr[data-path="${CSS.escape(path)}"]`);
    return tr?.querySelector<HTMLElement>(`[data-col="${CSS.escape(col)}"]`) ?? null;
  }

  // セルを押して選ぶ（Shift で範囲を広げる）。押したままドラッグで範囲を選ぶ / press to select (Shift extends); drag while pressed to select a range
  private wireCellSelect(td: HTMLElement, path: string, col: string): void {
    const ref: CellRef = { path, col };
    td.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("input, select, textarea, a, .internal-link, .ogantt-task-chevron")) return; // 編集中・リンク・開閉 / editing, links, the fold chevron
      if (e.shiftKey && this.cellSel) this.cellSel.focus = ref;
      else this.cellSel = { anchor: ref, focus: ref };
      this.selDragging = true;
      this.paintSelection();
    });
    td.addEventListener("mouseenter", () => {
      if (!this.selDragging || !this.cellSel) return;
      this.cellSel.focus = ref;
      this.paintSelection();
    });
  }

  private clearSelection(): void {
    if (!this.cellSel) return;
    this.cellSel = null;
    this.paintSelection();
  }

  // 選択の見た目：範囲の外枠と、右下のフィルハンドル / the selection's look: the outline of the range and the fill handle at its bottom-right
  private paintSelection(): void {
    const body = this.tbodyEl;
    if (!body) return;
    body.querySelectorAll(".is-cell-sel").forEach((el) => el.removeClasses(["is-cell-sel", "is-sel-t", "is-sel-b", "is-sel-l", "is-sel-r"]));
    body.querySelectorAll(".ogantt-fill-handle").forEach((el) => el.remove());
    const rect = this.selRect();
    if (!rect) {
      this.selBarEl?.addClass("is-hidden");
      return;
    }
    const rows = this.selRows();
    const cols = this.selCols();
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        const td = this.cellEl(rows[r], cols[c]);
        if (!td) continue;
        td.addClass("is-cell-sel");
        if (r === rect.r0) td.addClass("is-sel-t");
        if (r === rect.r1) td.addClass("is-sel-b");
        if (c === rect.c0) td.addClass("is-sel-l");
        if (c === rect.c1) td.addClass("is-sel-r");
      }
    }
    const corner = this.cellEl(rows[rect.r1], cols[rect.c1]);
    corner?.createDiv({ cls: "ogantt-fill-handle" }).addEventListener("mousedown", (e) => this.startFill(e));
    this.paintSelectionSummary(rect, rows, cols);
  }

  // 範囲が 2 セル以上のとき、画面の下に、件数と、数値なら合計・平均・最小・最大、日付なら最小・最大を出す
  // with two or more cells selected, show the count at the bottom, and for numbers the sum, average, min and max, for dates the min and max
  private paintSelectionSummary(rect: { r0: number; r1: number; c0: number; c1: number }, rows: string[], cols: string[]): void {
    const bar = this.selBarEl;
    if (!bar) return;
    bar.empty();
    if (rect.r0 === rect.r1 && rect.c0 === rect.c1) {
      bar.addClass("is-hidden");
      return;
    }
    const values: string[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) values.push(this.cellCopyText(rows[r], cols[c]));
    const sm = summarizeCells(values, this.plugin.settings.dateFormat);
    const fmt = this.plugin.settings.dateFormat;
    const num = (n: number): string => String(Math.round(n * 100) / 100);
    const part = (label: string, value: string): void => {
      const el = bar.createSpan({ cls: "ogantt-selbar-item" });
      el.createSpan({ cls: "ogantt-selbar-label", text: label });
      el.createSpan({ text: value });
    };
    const t = tr();
    part(t.selCount, String(sm.count));
    if (sm.kind === "number" && typeof sm.min === "number" && typeof sm.max === "number" && sm.sum !== undefined) {
      part(t.selSum, num(sm.sum));
      part(t.selAvg, num(sm.sum / sm.count));
      part(t.selMin, num(sm.min));
      part(t.selMax, num(sm.max));
    } else if (sm.kind === "date" && typeof sm.min === "string" && typeof sm.max === "string") {
      part(t.selMin, formatDate(sm.min, fmt));
      part(t.selMax, formatDate(sm.max, fmt));
    }
    bar.removeClass("is-hidden");
  }

  // 矢印キーでの移動（Shift で範囲を広げる）/ move with the arrow keys (Shift extends the range)
  private moveSelection(dr: number, dc: number, extend: boolean): void {
    const s = this.cellSel;
    if (!s) return;
    const rows = this.selRows();
    const cols = this.selCols();
    const r = rows.indexOf(s.focus.path);
    const c = cols.indexOf(s.focus.col);
    if (r < 0 || c < 0) return;
    const ref: CellRef = { path: rows[Math.max(0, Math.min(rows.length - 1, r + dr))], col: cols[Math.max(0, Math.min(cols.length - 1, c + dc))] };
    if (extend) s.focus = ref;
    else this.cellSel = { anchor: ref, focus: ref };
    this.paintSelection();
    this.cellEl(ref.path, ref.col)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // セル操作のキーを受けてよい状況か：このビューが前面で、セルが選ばれていて、文字入力中ではない
  // whether cell keys apply now: this view is in front, cells are selected, and no text is being typed
  private cellKeysActive(): boolean {
    if (!this.cellSel || this.activeType() === "kanban") return false;
    if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return false;
    const ae = activeDocument.activeElement as HTMLElement | null;
    if (!ae || ae === activeDocument.body) return true;
    // ビューの中で、入力欄・ボタン・詳細パネルにフォーカスがあるときは、セルのキーを奪わない / inside the view, never take keys from an input, a button or the detail panel
    return this.contentEl.contains(ae) && !ae.closest("input, select, textarea, button, [contenteditable], .ogantt-detail");
  }

  private onCellKey(e: KeyboardEvent): void {
    if (!this.cellKeysActive() || e.ctrlKey || e.metaKey || e.altKey) return;
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = arrows[e.key] ?? (e.key === "Tab" ? [0, e.shiftKey ? -1 : 1] : undefined);
    if (step) {
      e.preventDefault();
      this.moveSelection(step[0], step[1], e.shiftKey && e.key !== "Tab");
    } else if (e.key === "Escape") {
      this.clearSelection();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      void this.clearCells();
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      this.editFocusedCell();
    }
  }

  // Enter / F2：ダブルクリックと同じ編集（名前の列は詳細パネルを開く）/ Enter / F2 edits like a double-click (the name column opens the detail panel)
  private editFocusedCell(): void {
    const f = this.cellSel?.focus;
    if (!f) return;
    if (f.col === "name") {
      void this.openDetail(f.path);
      return;
    }
    this.cellEl(f.path, f.col)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }

  // セルのコピー用の文字（名前はタスク名、それ以外は列の copyText）/ the text copied out of a cell (the name column: the task name; the rest: the column's copyText)
  private cellCopyText(path: string, colId: string): string {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return "";
    if (colId === "name") return t.name;
    const def = this.columns().find((c) => c.id === colId);
    const row = this.rows.find((r) => r.task?.path === path);
    return def && def.kind === "cell" && row ? def.copyText(this.board, t, row) : "";
  }

  private onCellCopy(e: ClipboardEvent, cut: boolean): void {
    if (!this.cellKeysActive() || !e.clipboardData) return;
    const rect = this.selRect();
    if (!rect) return;
    const rows = this.selRows();
    const cols = this.selCols();
    const matrix: string[][] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const line: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) line.push(this.cellCopyText(rows[r], cols[c]));
      matrix.push(line);
    }
    e.clipboardData.setData("text/plain", toTsv(matrix));
    e.preventDefault();
    if (cut) void this.clearCells();
  }

  private onCellPaste(e: ClipboardEvent): void {
    if (!this.cellKeysActive()) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const rect = this.selRect();
    if (!rect || text === "") return;
    e.preventDefault();
    void this.pasteCells(parseTsv(text), rect);
  }

  // 貼り付け：1 つの値は選んだ範囲すべてに、複数は左上から。表の下端・右端を超えた分は貼らない
  // paste: a single value fills the whole selection; several land from the top-left; whatever runs past the table's last row or column is not pasted
  private async pasteCells(matrix: string[][], rect: { r0: number; r1: number; c0: number; c1: number }): Promise<void> {
    if (!matrix.length) return;
    const rows = this.selRows();
    const cols = this.selCols();
    const single = matrix.length === 1 && matrix[0].length === 1;
    const items: { path: string; col: string; text: string }[] = [];
    let skipped = 0;
    const h = single ? rect.r1 - rect.r0 + 1 : matrix.length;
    const w = single ? rect.c1 - rect.c0 + 1 : Math.max(...matrix.map((l) => l.length));
    for (let i = 0; i < h; i++) {
      for (let j = 0; j < w; j++) {
        const text = single ? matrix[0][0] : matrix[i][j];
        if (text === undefined) continue; // 欄が足りない行 / a short row
        const r = rect.r0 + i;
        const c = rect.c0 + j;
        if (r >= rows.length || c >= cols.length) {
          skipped++;
          continue;
        }
        items.push({ path: rows[r], col: cols[c], text });
      }
    }
    const res = await this.applyCellTexts(tr().cellsPaste, items);
    skipped += res.skipped;
    if (skipped > 0) new Notice(tr().cellsPasted(res.done, skipped));
    // 貼り付けた範囲を選び直す / select what was pasted
    const r1 = Math.min(rows.length - 1, rect.r0 + h - 1);
    const c1 = Math.min(cols.length - 1, rect.c0 + w - 1);
    this.cellSel = { anchor: { path: rows[rect.r0], col: cols[rect.c0] }, focus: { path: rows[r1], col: cols[c1] } };
    this.paintSelection();
  }

  // Delete・切り取り：選んだセルを空にする（空にできないセル・読み取り専用は、そのまま）/ Delete and cut: blank the selected cells (cells that can't be blanked and read-only ones stay)
  private async clearCells(): Promise<void> {
    const rect = this.selRect();
    if (!rect) return;
    const rows = this.selRows();
    const cols = this.selCols();
    const items: { path: string; col: string; text: string }[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) items.push({ path: rows[r], col: cols[c], text: "" });
    await this.applyCellTexts(tr().cellsClear, items);
  }

  // 文字をセルに書く（貼り付け・フィル・消去の共通）。全部まとめて 1 回の取り消しにする。書けた数と、書けなかった数を返す
  // write texts into cells (shared by paste, fill and clear), all as one undo step; returns how many were written and how many couldn't be
  private async applyCellTexts(label: string, items: { path: string; col: string; text: string }[]): Promise<{ done: number; skipped: number }> {
    const defs = new Map(this.columns().map((c) => [c.id, c]));
    const todo: { path: string; def: CellColumn; text: string }[] = [];
    let skipped = 0;
    for (const it of items) {
      const def = defs.get(it.col);
      if (!def || def.kind !== "cell" || !def.applyText || this.cellEl(it.path, it.col)?.dataset.ro === "1") {
        skipped++;
        continue;
      }
      todo.push({ path: it.path, def, text: it.text });
    }
    if (!todo.length) return { done: 0, skipped };
    const paths = [...new Set(todo.map((x) => x.path))];
    let done = 0;
    await this.mutate(label, [...new Set([...paths, ...paths.flatMap((p) => this.cascadePaths(p))])], async () => {
      this.batchActive = true;
      try {
        for (const x of todo) {
          const t = this.tasks.find((y) => y.path === x.path);
          if (t && (await x.def.applyText!(this.board, t, x.text))) done++;
          else skipped++;
        }
      } finally {
        this.batchActive = false;
      }
    });
    await this.refresh();
    return { done, skipped };
  }

  // フィルハンドルのドラッグ：選んだ範囲の値を、ドラッグした行まで（上にも下にも）繰り返しコピーする
  // dragging the fill handle: repeat the selected range's values down or up to the row it is dragged to
  private startFill(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const rect = this.selRect();
    if (!rect) return;
    const rows = this.selRows();
    const cols = this.selCols();
    let target: { from: number; to: number } | null = null; // 埋める行の範囲（元の範囲は含まない）/ the rows to fill (not the source range)
    const clearMarks = (): void => this.tbodyEl?.querySelectorAll(".is-fill-target").forEach((el) => el.removeClass("is-fill-target"));
    const onMove = (ev: MouseEvent): void => {
      const path = activeDocument.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".ogantt-tr[data-path]")?.dataset.path;
      const ri = path ? rows.indexOf(path) : -1;
      clearMarks();
      target = ri > rect.r1 ? { from: rect.r1 + 1, to: ri } : ri >= 0 && ri < rect.r0 ? { from: ri, to: rect.r0 - 1 } : null;
      if (!target) return;
      for (let r = target.from; r <= target.to; r++) for (let c = rect.c0; c <= rect.c1; c++) this.cellEl(rows[r], cols[c])?.addClass("is-fill-target");
    };
    const onUp = (): void => {
      activeDocument.removeEventListener("mousemove", onMove);
      activeDocument.removeEventListener("mouseup", onUp);
      clearMarks();
      if (target) void this.applyFill(rect, target);
    };
    activeDocument.addEventListener("mousemove", onMove);
    activeDocument.addEventListener("mouseup", onUp);
  }

  private async applyFill(rect: { r0: number; r1: number; c0: number; c1: number }, target: { from: number; to: number }): Promise<void> {
    const rows = this.selRows();
    const cols = this.selCols();
    const n = rect.r1 - rect.r0 + 1;
    // 元の値は、書き換える前にすべて読む / read every source value before anything is written
    const items: { path: string; col: string; text: string }[] = [];
    for (let r = target.from; r <= target.to; r++) {
      const src = rect.r0 + fillSourceIndex(r - rect.r0, n);
      for (let c = rect.c0; c <= rect.c1; c++) items.push({ path: rows[r], col: cols[c], text: this.cellCopyText(rows[src], cols[c]) });
    }
    await this.applyCellTexts(tr().cellsFill, items);
    // 埋めた分まで、選択を広げる / grow the selection over what was filled
    const r0 = Math.min(rect.r0, target.from);
    const r1 = Math.max(rect.r1, target.to);
    this.cellSel = { anchor: { path: rows[r0], col: cols[rect.c0] }, focus: { path: rows[r1], col: cols[rect.c1] } };
    this.paintSelection();
  }

  // ----- セルの直接編集 / in-cell editing -----
  // 方針：テーブルに表示できる列はすべてダブルクリックで直接編集できる。
  // 列は src/columns.ts の ColumnDef として定義する（paint と edit が必須＝描画とエディタが必ずセットになる）。
  // Policy: every column the table can show is editable in place via double-click.
  // Columns are ColumnDefs in src/columns.ts, where paint and edit are both required, so a renderer never ships without its editor.
  private makeEditableCell(cell: HTMLElement, aria: string, edit: (cell: HTMLElement) => void): void {
    cell.addClass("ogantt-td-editable");
    cell.setAttr("aria-label", aria);
    // セルのシングルクリックは詳細を開かない（編集操作に専念）/ a single click here edits, it doesn't open the detail panel
    cell.addEventListener("click", (e) => e.stopPropagation());
    cell.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      edit(cell);
    });
  }

  // セルを入力欄に差し替える共通処理。Enter/フォーカス外れで保存、Esc で取消、値が同じなら書き込まない
  // swap a cell for an input: Enter/blur saves, Esc cancels, an unchanged value is never written
  private inlineInput(
    cell: HTMLElement,
    value: string,
    repaint: () => void,
    commit: (v: string) => Promise<void>,
    configure?: (inp: HTMLInputElement) => void
  ): void {
    if (cell.querySelector("input, select")) return; // 編集中の二重起動を防ぐ / already editing
    cell.empty();
    const inp = cell.createEl("input", { type: "text", cls: "ogantt-cell-input" });
    inp.value = value;
    configure?.(inp);
    inp.focus();
    inp.select();
    // Enter 保存後に blur が続いて二重保存にならないよう、一度きりに固定 / run exactly once (Enter is followed by blur)
    let settled = false;
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      repaint();
    };
    const save = (): void => {
      if (settled) return;
      settled = true;
      const v = inp.value.trim();
      if (v === value.trim()) {
        repaint(); // 変更なしなら書き込まない / nothing changed, skip the write
        return;
      }
      void commit(v);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    inp.addEventListener("blur", save);
  }

  // 入力欄に datalist を付けて候補を出す共通処理。候補の中身は fill が入れる
  // attach a datalist to an input; `fill` supplies the options
  private attachSuggestions(inp: HTMLInputElement, fill: (list: HTMLDataListElement) => void): HTMLDataListElement {
    // 同時に別セルを編集中でも id が衝突しないよう連番を振る / a counter keeps ids unique across concurrent editors
    const id = `ogantt-suggest-${++this.cellEditSeq}`;
    const list = (inp.parentElement ?? inp).createEl("datalist");
    list.id = id;
    inp.setAttr("list", id);
    fill(list);
    return list;
  }

  // Vault 内の既存タグを候補に出す（単一タグ入力用。詳細パネルのタグ追加欄）
  // suggest the vault's existing tags for a single-tag input (the detail panel's add field)
  private attachSingleTagSuggestions(inp: HTMLInputElement, exclude: string[] = []): void {
    const all = collectAllTags(this.app).filter((x) => !exclude.includes(x));
    if (all.length === 0) return;
    this.attachSuggestions(inp, (list) => {
      for (const tag of all) list.createEl("option", { value: tag });
    });
  }

  // 範囲カレンダー（開始・終了を1つで指定。月移動は ←→・テーマ追従）
  // range calendar: pick start & end in one popup; month nav ← →, theme-aware
  private openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>,
    // 指定すると単一日付モード（start = end に同じ日を入れ、選んだら閉じる）。値は見出しに出す名前
    // single-date mode when given: a pick sets start = end to that day and closes; the value names the field
    single?: string
  ): void {
    activeDocument.querySelectorAll(".ogantt-cal").forEach((e) => e.remove());
    const todayStr = dayToStr(todayIndex());
    const base = state[active] || state.start || state.end || todayStr;
    let y = parseInt(base.slice(0, 4), 10);
    let m = parseInt(base.slice(5, 7), 10); // 1-based
    let act = active; // 次のクリックで設定する端点 / endpoint the next click sets
    const wk = moment.weekdaysMin(); // ロケールの曜日略称（日曜始まり）/ localized minimal weekday names (Sunday-first)

    const cal = activeDocument.body.createDiv({ cls: "ogantt-cal" });
    const close = () => {
      cal.remove();
      activeDocument.removeEventListener("pointerdown", onOutside, true);
      activeDocument.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!cal.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };

    let mode: "day" | "year" = "day"; // 日ビュー / 年（12ヶ月）ビュー / day view or year (12-month) view
    const months = moment.monthsShort(); // ロケールの月名略称 / localized short month names

    // 端点を1つ設定して交互に切り替え。逆転時は常に「終了=開始」へ補正（開始は変更しない）
    // set one endpoint, then alternate; on inversion always clamp end = start (never move the start)
    const pick = (ds: string) => {
      if (single !== undefined) {
        state.start = state.end = ds;
        repaint();
        void save();
        close();
        return;
      }
      if (act === "start") {
        state.start = ds;
        if (state.end && ds > state.end) state.end = ds; // 終了が前に残ったら追従 / end follows forward
        act = "end";
      } else {
        // 開始より前を選んだら終了=開始 / picking before the start clamps end to the start
        state.end = state.start && ds < state.start ? state.start : ds;
        act = "start";
      }
      repaint();
      void save();
      render();
    };

    // 日ビュー / day view
    const renderDay = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { if (--m < 1) { m = 12; y--; } render(); };
      // タイトルをクリックで年ビューへ / click the title to open the year view
      const title = head.createEl("button", { cls: "ogantt-cal-title", text: `${y} / ${String(m).padStart(2, "0")}` });
      title.onclick = () => { mode = "year"; render(); };
      const next = head.createEl("button", { cls: "clickable-icon" });
      setIcon(next, "chevron-right");
      next.onclick = () => { if (++m > 12) { m = 1; y++; } render(); };

      cal.createDiv({ cls: "ogantt-cal-active", text: `▸ ${single ?? (act === "start" ? tr().fieldStart : tr().fieldDue)}` });

      const wkRow = cal.createDiv({ cls: "ogantt-cal-wk" });
      wk.forEach((w) => wkRow.createSpan({ text: w }));

      const grid = cal.createDiv({ cls: "ogantt-cal-grid" });
      const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let i = 0; i < firstDow; i++) grid.createSpan({ cls: "ogantt-cal-pad" });
      for (let d = 1; d <= dim; d++) {
        const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const cell = grid.createEl("button", { cls: "ogantt-cal-day", text: String(d) });
        if (ds === todayStr) cell.addClass("is-today");
        if (ds === state.start) cell.addClass("is-range-start");
        if (ds === state.end) cell.addClass("is-range-end");
        if (state.start && state.end && ds > state.start && ds < state.end) cell.addClass("is-in-range");
        cell.onclick = () => pick(ds);
      }

      const foot = cal.createDiv({ cls: "ogantt-cal-foot" });
      const todayBtn = foot.createEl("button", { text: tr().today });
      todayBtn.onclick = () => {
        y = parseInt(todayStr.slice(0, 4), 10);
        m = parseInt(todayStr.slice(5, 7), 10); // 表示も今日の月へ / move the view to today
        pick(todayStr);
      };
      const clearBtn = foot.createEl("button", { text: tr().clearDate });
      clearBtn.onclick = () => {
        if (single !== undefined) {
          state.start = state.end = "";
          repaint();
          void save();
          close();
          return;
        }
        state[act] = "";
        repaint();
        void save();
        render();
      };
    };

    // 年ビュー（12ヶ月）/ year view (12 months)
    const renderYear = () => {
      const head = cal.createDiv({ cls: "ogantt-cal-head" });
      const prev = head.createEl("button", { cls: "clickable-icon" });
      setIcon(prev, "chevron-left");
      prev.onclick = () => { y--; render(); }; // ← → で年移動 / year nav
      head.createSpan({ cls: "ogantt-cal-title", text: `${y}` });
      const next = head.createEl("button", { cls: "clickable-icon" });
      setIcon(next, "chevron-right");
      next.onclick = () => { y++; render(); };

      const grid = cal.createDiv({ cls: "ogantt-cal-months" });
      for (let mm = 1; mm <= 12; mm++) {
        const cell = grid.createEl("button", { cls: "ogantt-cal-month", text: months[mm - 1] });
        if (mm === m) cell.addClass("is-current");
        const ym = `${y}-${String(mm).padStart(2, "0")}`;
        if (state.start.startsWith(ym) || state.end.startsWith(ym)) cell.addClass("is-selected"); // 端点を含む月 / months holding an endpoint
        cell.onclick = () => { m = mm; mode = "day"; render(); };
      }
    };

    const render = () => {
      cal.empty();
      if (mode === "year") renderYear();
      else renderDay();
    };
    render();

    // 位置：チップの下（画面外なら上へ反転）/ position below the chip (flip up if it would overflow)
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + cal.offsetHeight > window.innerHeight) top = Math.max(4, r.top - cal.offsetHeight - 4);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - cal.offsetWidth - 8));
    cal.style.top = `${top}px`;
    cal.style.left = `${left}px`;

    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);
  }

  // 詳細パネルの幅をドラッグで変更（幅は記憶）/ drag to resize the detail panel (width persisted)
  private attachResize(resizer: HTMLElement, panel: HTMLElement): void {
    resizer.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      resizer.setPointerCapture(ev.pointerId);
      const board = this.contentEl.getBoundingClientRect();
      const onMove = (e: PointerEvent) => {
        const w = Math.max(280, Math.min(board.width - 120, board.right - e.clientX));
        panel.style.width = `${w}px`;
      };
      const onUp = () => void (async () => {
        resizer.releasePointerCapture(ev.pointerId);
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        this.plugin.settings.detailWidth = parseInt(panel.style.width, 10) || 380;
        await this.plugin.saveData(this.plugin.settings);
      })();
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });
  }

  // SVG 要素生成ヘルパー（Obsidian の createSvg を使用）/ SVG element helper (uses Obsidian's createSvg)
  private svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
    const el = createSvg(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }
}
