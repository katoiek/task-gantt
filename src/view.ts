import { Component, ItemView, Keymap, Menu, MarkdownRenderer, PaneType, Platform, Scope, WorkspaceLeaf, normalizePath, setIcon, Notice, TFile, TFolder, ViewStateResult, moment } from "obsidian";
import type GanttPlugin from "./main";
import { Task, TaskKind, Row, ZoomMode, DepType, GanttViewState, VIEW_TYPE_GANTT, Filter, FilterMatch, FilterPreset, DateFilterItem, CategoryFilter, CategoryField, CategoryOp, TextFilter, TextOp, DateValue, DateOp, DateField, DateUnit, DateDir, StatusDef, StatusGroup, STATUS_GROUPS } from "./types";
import {
  collectTasks,
  collectFolders,
  moveCollapsed,
  movePaths,
  buildRows,
  createTask,
  reparentTask,
  subtreePaths,
  validCustomFields,
  writeDates,
  combineDateTime,
  writeField,
  editListField,
  writeBody,
  renameTask,
  deleteTask,
  addTag,
  removeTag,
  collectAllTags,
  addDependency,
  removeDependency,
  readBody,
  bodyOf,
  kanbanLanes,
  newStatus,
  anchorStart,
  anchorEnd,
  statusGroupOf,
} from "./model";
import { autoStatusChanges, renameAutoStatusId, cascadeDates, depViolated, endForDuration, isWorkday, keepDurationOnStartChange, offDayGradient, parseDuration, scheduleOptions, successorClosure, taskDuration, wouldLoop } from "./schedule";
import {
  DateRange,
  computeRange,
  dayIndex,
  dayToStr,
  pxPerDay,
  buildTicks,
  buildBands,
  todayIndex,
  formatDate,
  growPad,
  nearEdge,
  padRange,
  padToCover,
  RangePad,
  buildProgressLine,
  ProgressLineRow,
  Tick,
} from "./timeline";
import { PALETTE, distinctColors, hashColor, inkOn, resolveTagColor } from "./colors";
import { closePopovers, openPopover, paletteInto, pickColor, pickIcon } from "./popover";
import { ConfirmModal, PickModal } from "./modals";
import { linkLabel } from "./links";
import { attachLinkSuggest, handleLinkClick, renderLinkValue, wireLinkHover } from "./linkui";
import { t as tr, statusGroupLabel } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var
import { schedulePush } from "./gcal/sync";
import { isConnected } from "./gcal/auth";
import { applyFilters, besideHeading, regroup, GroupBy } from "./filter";
import { BoardContext, Move, MutateResult, StatusChange } from "./board";
import { CellColumn, ColumnDef, allColumns, columnList, columnWidth, disabledLast, manualComparator, moveColumn, paintProgress, progressPct, taskComparator, toggleColumn, visibleColumns } from "./columns";

const ROW_H = 30; // 行の高さ（表とタイムラインで共通）/ shared row height
// 日本語などの変換中のキー（Enter は変換の確定、Esc は変換の取り消しで、こちらの操作ではない）
// a key pressed while an input method is composing (Enter confirms the conversion and Esc cancels it; neither is meant for us)
const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;
const HEAD_H = 40; // ヘッダー高さ / header height
const BAR_PAD = 5; // バーの上下余白 / vertical padding inside a row
const RESIZE_EDGE = 8; // バー端リサイズの当たり幅 / edge-resize hit width
const MIN_PPD = 2; // Fit 時の最小 1 日幅（これ未満は横スクロール）/ minimum px/day in Fit mode
const FIT_SCROLLBAR_PAD = 16; // 縦スクロールバー分の余白 / room for the vertical scrollbar
const FALLBACK_BAR = "#7c8db5"; // ステータス/担当者が未設定のときのバー色 / bar color when status/assignee is unset

const MAX_INDENT_DEPTH = 8; // インデントの段数上限（論理ツリーは無制限）/ visual indent cap (the tree itself is unlimited)
const MAX_AVATARS = 3; // バーの横に並べるアバターの数（名前はラベルに全員）/ avatars beside a bar (the label names everyone)
const MAX_PILLS = 3; // ラベルの後ろに並べるタグの数（残りは +N）/ tag pills after a label (the rest become +N)
// バーのラベルとタグの札の文字の大きさ。描くときの font-size と、札の位置を決める幅の計測の両方に使う
// the font sizes of bar labels and tag pills, used both as their font-size and when measuring widths to place the pills
const LABEL_PX = 11;
const PILL_PX = 9.5;
const KEY_PX = 11; // 書き出す画像の色の凡例の文字（配置の計測と描画で同じ値）/ the exported colour key's text size, for laying it out and drawing it alike
// 書き出す画像の文字：SVG 画像の中でも使えるシステムフォント / the exported image's text: a system font that also exists inside an SVG image
const EXPORT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// バー端からラベルまで。依存の矢印が折れる位置（12px）と端のハンドル（11px）の先に置く
// from the bar end to the label: past the turn of a dependency arrow (12px) and the end handle (11px)
const LABEL_GAP = 18;
// 見えている範囲の上下に余分に描く行数（少しのスクロールでは描き直さない）/ rows drawn beyond the viewport, so small scrolls don't repaint
const WINDOW_PAD = 25;
// これより多くのファイルに触る操作は「処理中」の通知を出す / operations touching more files than this show a "working" notice
const BUSY_FILES = 10;

// タスクの種類のアイコン（ノートは付けない）/ task-kind icons (plain notes get none)
const KIND_ICON: Record<TaskKind, string> = { note: "file-text", kanban: "square-kanban", canvas: "layout-dashboard" };

// 名前の頭文字（アバター用・最大 2 文字）/ initials of a name for an avatar (up to two letters)
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
}

// 履歴 1 件：操作前パス→内容（null＝存在しなかった）と、操作中の移動（実行順）
// one history entry: pre-op path → contents (null = didn't exist) and the op's moves, in order
// created / deleted は「書き戻しでファイルを作り直してよいパス」の判定に使う（それ以外は作り直さない）
// created / deleted decide which paths a restore may re-create (no other missing file is ever re-created)
interface HistoryEntry {
  label: string;
  files: Map<string, string | null>;
  // 取り消す（やり直す）ときにあるはずの内容。違っていれば外で書き換えられたので上書きしない（移動を含む操作は確かめない）
  // what the files should hold when this is undone (redone); anything else was changed outside, so it isn't overwritten (ops with moves aren't checked)
  expect?: Map<string, string | null>;
  moves: Move[];
  created: string[]; // 操作で作成 / made by the op
  statuses?: StatusChange[]; // 日付による自動ステータスの変更（取り消しはこの欄だけ）/ automatic status changes (undo touches only this field)
  disable?: { paths: string[]; on: boolean }; // タスクを止めた・戻した（ボードの設定だけ）/ tasks disabled or enabled (board setting only)
  deleted: string[]; // 操作で削除 / removed by the op
}

// 移動 b が移動 a と同じか、a（フォルダ）の移動に伴う配下の移動か / whether move b is move a itself, or follows from a folder move a
function movesUnder(a: Move, b: Move): boolean {
  if (a.from === b.from && a.to === b.to) return true;
  return b.from.startsWith(a.from + "/") && b.to === a.to + b.from.slice(a.from.length);
}

// 依存を作る 2 つのハンドル（全バーで共有。矢印を隠しているときと書き出しには無い）/ the two connector handles, shared by every bar (none with arrows hidden, or in an export)
interface Handles {
  show(t: Task, g: SVGGElement, lx: number, rx: number, cy: number): void;
  hide(): void;
}

// 表示言語の日付書式（UTC）。moment のロケール名には Intl が知らないもの（"x-pseudo" など）があり、そのときは既定の言語で
// a date format in the UI language (UTC); some moment locale names ("x-pseudo", …) are unknown to Intl, which then gets the default language
function dateFormat(o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(moment.locale(), { ...o, timeZone: "UTC" });
  } catch {
    return new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" });
  }
}

// 依存を外す × を、矢印の上の (x, y) に出す（null で隠す）/ shows the × that removes a dependency at (x, y) over its arrow (null hides it)
type DepX = (dep: DepRow | null, x?: number, y?: number) => void;

// 描く依存 1 本と、両端の行番号 / one dependency to draw, with the rows of both ends
interface DepRow {
  t: Task;
  pred: Task;
  type: DepType;
  si: number;
  pi: number;
}

export class GanttView extends ItemView {
  plugin: GanttPlugin;
  private zoom: ZoomMode;
  private tasks: Task[] = [];
  private rows: Row[] = [];
  private range: DateRange = { min: 0, max: 0 }; // 表示範囲（タスクの範囲＋余白）/ the shown range (the tasks' range plus the pad)
  private baseRange: DateRange = { min: 0, max: 0 }; // タスクの範囲 / the tasks' range
  // 終わりの無いタイムライン：スクロールで足した前後の日数（縮尺を変える・ボードを替えると戻る）と、のばしている最中か
  // the endless timeline: days added before and after by scrolling (reset by a zoom or board change), and whether a grow is under way
  private pad: RangePad = { before: 0, after: 0 };
  private extending = false;
  private ppd = 16;
  private selectedPath: string | null = null;
  private folder = ""; // 表示対象フォルダ / scoped folder path
  private collapsed = new Set<string>(); // 折りたたみ中フォルダのキー / collapsed folder keys
  private order: string[] = []; // 手で決めた行の並び（タスクのパス。並べ替えが「手動」のとき）/ the manual row order (task paths; used while the sort is "manual")
  private disabled = new Set<string>(); // 止めたタスク（薄く、兄弟の最後に）/ disabled tasks (greyed, last among their siblings)

  // 表示オプション（ボードごとに settings.boards へ覚える）/ view options (remembered per board in settings.boards)
  private colorBy: "status" | "assignee" = "status";
  private groupBy: GroupBy = "folder";
  private showEmptyFolders = true; // 空フォルダも行として表示（既定ON）/ show empty folders as rows (default on)
  private flat = false; // フラット表示（フォルダ/親子を無視し全タスク一覧）/ flat list ignoring folders & nesting
  private rollup = false; // 親タスクのバーを子孫の集約で描く（既定OFF）/ draw parent bars as a rollup of descendants (default off)
  private progressLine = false; // 稲妻線（今日基準の進捗折れ線・既定OFF）/ progress line against today (default off)
  private showDeps = true; // 依存の矢印（とリンクを作るハンドル）/ dependency arrows (and the handles that make links)
  private showTags = true; // バーの後ろのタグ / tags after the bars' labels
  private allFolders: string[][] = []; // スコープ配下の全フォルダ（相対セグメント）/ all folders under scope
  private groupSel!: HTMLSelectElement; // ツールバーの「グループ化」/ the toolbar's Group by
  private colorSel!: HTMLSelectElement; // ツールバーの「色分け」/ the toolbar's Color by
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

  // Fit モードでペイン幅に追従するための再描画タイマーと、合わせた幅 / debounce timer to re-fit in Fit mode, and the width it fitted
  private fitTimer: number | null = null;
  private fitWidth = 0;

  private boardKey: string | null = null; // 表示オプションを読み込んだボード（フォルダ）/ the board (folder) whose view options are loaded
  private cursor = 0; // キーボードで選んでいる行 / the row the keyboard is on
  private boardMain: HTMLElement | null = null; // スクロールするボード本体 / the scrolling board body
  private paintWindow: ((force?: boolean) => void) | null = null; // 見えている行を描く / draws the rows in view
  private dragPath: string | null = null; // 行をドラッグ中のタスク / the task whose row is being dragged
  private tagCache: string[] | null = null; // Vault のタグ（追加欄に初めてフォーカスしたときに集める）/ the vault's tags, gathered when an add field first gets focus
  private card: { el: HTMLElement | null; timer: number | null; x: number; y: number } = { el: null, timer: null, x: 0, y: 0 }; // バーのホバーカード / the bar hover card
  private saveTimer: number | null = null; // 設定の保存待ち / a pending settings save
  private filterTimer: number | null = null; // 名前フィルタの入力待ち / waits for typing in the name filter to pause
  private detailSeq = 0; // 詳細パネルの描画の世代（古い描画の続きを捨てる）/ detail panel build generation (stale async builds stop)
  private bodyOwner: Component | null = null; // 本文の描画の持ち主（埋め込み・Dataview などの寿命）/ owns the rendered body (embeds, Dataview, …)
  // ボードのスクロール位置（見えている間に覚える。隠れたタブはどの値も 0 と読めるため）と、隠れている間に描き直したときの戻し先
  // the board's scroll position (remembered while visible: a hidden tab reads 0 for every scroll value), and where to return once a hidden redraw becomes visible
  private scrollMemo: { top: number; day: number } | null = null;
  private pendingScroll: { top: number; day: number } | null = null;
  private panelSig: string | null = null; // 詳細パネルが今表示している内容（同じなら描き直さない）/ what the detail panel currently shows (no rebuild while it's unchanged)
  private fieldStart = new WeakMap<HTMLElement, string>(); // パネルの欄に入ったときの値（Esc でここへ戻す）/ a panel field's value when it was entered (Esc puts it back)
  private undoToast: Notice | null = null; // 取り消しボタン付きの通知（履歴が動いたら閉じる）/ the notice with an Undo button (closed once the history moves)

  // セル内エディタの連番（datalist の id 衝突を避ける）/ in-cell editor counter (keeps datalist ids unique)
  private cellEditSeq = 0;

  // DOM 参照 / DOM refs
  private tbodyEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private detailEl!: HTMLElement;
  private titleText: HTMLElement | null = null;
  private legendHost!: HTMLElement; // 色の凡例の行 / the colour key row
  private measureCtx = createEl("canvas").getContext("2d")!; // 文字幅を測る（DOM のレイアウトを起こさない）/ measures text without a DOM layout
  private tagColorCache = new Map<string, string>(); // タグの色（既定色は CSS を読むので、描き直しごとに 1 回）/ tag colours (the default reads CSS, so once per redraw)
  private assigneeCache: string[] | null = null; // ボードの担当者一覧（描き直しごとに作る）/ the board's assignees, built once per redraw
  private peopleColors: Map<string, string> | null = null; // 担当者の自動の色（同上）/ the assignees' automatic colours (likewise)
  private late: Set<string> | null = null; // 矢印を隠しているときの、依存が守られていない後続 / with arrows hidden, successors whose dependency is broken
  private exporting = false; // PNG の書き出し中 / a PNG export is running
  private historyRunning = false; // 取り消し・やり直しの最中 / an undo or redo is running
  private dragging: "bar" | "link" | "column" | null = null; // ドラッグ中のもの（描き直しを待たせる）/ what is being dragged (redraws wait)
  private fontFamily = ""; // バーの文字のフォント（計測用）/ the bars' font, for measuring
  // SVG の模様・グラデーションの id に付ける、このビューだけの印。id は文書全体で 1 つなので、別のタブのボード（非表示）の定義を拾わないように
  // a per-view prefix for the SVG pattern and gradient ids: ids are document-wide, and a hidden board in another tab would otherwise shadow ours
  private uid = Math.random().toString(36).slice(2, 8);
  private bare = false; // 書き出しを描いている間：バーの後ろにタスク名を書かない（名前は左の列）/ while drawing an export: no task name after the bars (it's in the name column)
  private undoBtn: HTMLButtonElement | null = null;
  private redoBtn: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GanttPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.zoom = plugin.settings.defaultZoom;
  }

  getViewType(): string {
    return VIEW_TYPE_GANTT;
  }
  getDisplayText(): string {
    const name = this.folder ? this.folder.split("/").pop() : tr().vaultRoot;
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
    // "Projects/" も "/Projects" も同じボード。ルートは "" にそろえる / "Projects/" and "/Projects" are one board; the root is ""
    if (state && typeof state.folder === "string") this.folder = normalizePath(state.folder) === "/" ? "" : normalizePath(state.folder);
    await super.setState(state, result);
    if (this.gridHost) await this.refresh();
  }

  // ビューの見出しとツールバーのフォルダ名を書き直す（見出しは開いた時点＝フォルダが決まる前の名前のままなので。titleEl は型に無い）
  // rewrite the view header and the toolbar's folder name (the header keeps the name from before the folder was known; titleEl isn't in the typings)
  private retitle(): void {
    (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.getDisplayText());
    this.titleText?.setText(this.folder || tr().vaultRoot);
    // 読み上げる名前は見えている名前から始める（label-in-name）/ the accessible name starts with the visible one (label-in-name)
    this.titleText?.parentElement?.setAttr("aria-label", `${this.folder || tr().vaultRoot} — ${tr().menuOpen}`);
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    this.showPlaceholder();
    // このビューが前面にある間のキー。Obsidian 全体のキー（F2＝ファイル名の変更など）より先に受け、モーダルやメニューが開いていればそちらが先
    // keys while this view is in front: they come before Obsidian's global ones (F2 = rename file, …); an open modal or menu still goes first
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "Escape", (e) => this.onEscape(e));
    this.scope.register([], "F2", () => this.onF2());
    // 対象フォルダは onOpen の直後に setState で届くので、最初の描画はそちらに任せる（届かなければここで描く）
    // the folder arrives through setState right after onOpen, so the first render is left to it (done here only if it never comes)
    window.setTimeout(() => { if (this.boardKey === null) void this.refresh(); }, 0);
    // 描き直すのはこのボードのフォルダ配下が変わったときだけ / redraw only for changes under this board's folder
    const inScope = (path: string) => !this.folder || path === this.folder || path.startsWith(this.folder + "/");
    this.registerEvent(this.app.metadataCache.on("changed", (file) => { if (inScope(file.path)) this.scheduleRefresh(); }));
    // 起動直後の索引づけが終わったら 1 度だけ描き直す（途中までの内容で止まらないように）/ redraw once when startup indexing finishes, so a half-indexed board doesn't stick
    let indexed = false;
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (indexed) return;
      indexed = true;
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.vault.on("create", (file) => { if (inScope(file.path)) this.scheduleRefresh(); }));
    // テーマ・フォントが変わったら描き直す（タグの札の位置は文字幅から決める）/ redraw after a theme or font change (tag pills are placed from text widths)
    this.registerEvent(this.app.workspace.on("css-change", () => { if (this.boardMain) this.rerender(); }));
    this.registerEvent(this.app.vault.on("delete", (file) => { if (inScope(file.path)) this.scheduleRefresh(); }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (this.historyBusy === 0 && !this.isOwnMove(oldPath, file.path)) this.queueOutsideRename(oldPath, file.path);
      // 表示中のフォルダ（かその親）が改名・移動されたら追いかける。表示オプションは main.ts が付け替え済み
      // follow the shown folder (or a parent of it) when it's renamed or moved; main.ts has already re-keyed its view options
      if (this.folder && (oldPath === this.folder || this.folder.startsWith(oldPath + "/"))) {
        this.folder = this.boardKey = file.path + this.folder.slice(oldPath.length);
        this.retitle();
        this.app.workspace.requestSaveLayout();
      }
      // 畳んだ親タスク（キーはパス）も追いかける / collapsed parent tasks (keyed by path) follow too
      const before = [...this.collapsed];
      const collapsed = moveCollapsed(before, oldPath, file.path);
      // 手の並びと止めたタスク（キーはパス）も / the manual order and disabled tasks (keyed by path) too
      const order = movePaths(this.order, oldPath, file.path);
      const disabled = movePaths([...this.disabled], oldPath, file.path);
      if (collapsed.some((k, i) => k !== before[i]) || order.some((k, i) => k !== this.order[i]) || disabled.some((k) => !this.disabled.has(k))) {
        this.collapsed = new Set(collapsed);
        this.order = order;
        this.disabled = new Set(disabled);
        this.saveBoard();
      }
      if (inScope(oldPath) || inScope(file.path)) this.scheduleRefresh();
    }));
    // Ctrl/Cmd+Z で取り消し、Ctrl/Cmd+Shift+Z・Ctrl/Cmd+Y でやり直し。Esc・F2 と同じビューのキーなので、ポップアウトの窓でも効く。
    // 文字の入力中だけネイティブの取り消しに任せる（time 等の入力はガント側の取り消しを通す）
    // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo. Like Esc and F2 they're view keys, so they work in a pop-out window too.
    // Only while typing text does the native undo win (time-like inputs still let the gantt undo through)
    const history = (redo: boolean) => (e: KeyboardEvent): boolean => {
      const ae = activeDocument.activeElement as HTMLElement | null;
      const editingText =
        !!ae &&
        (ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          (ae.instanceOf(HTMLInputElement) && ["text", "search", "url", "tel", "password", "email", "number"].includes(ae.type)));
      if (editingText) return true;
      e.preventDefault();
      void (redo ? this.redo() : this.undo());
      return false;
    };
    this.scope.register(["Mod"], "z", history(false));
    this.scope.register(["Mod", "Shift"], "z", history(true));
    this.scope.register(["Mod"], "y", history(true));
    // 開いたまま日付が変わったら読み直す（今日の線・日付のフィルタ・自動ステータス）/ reload when the day changes while open (today line, date filters, automatic status)
    let day = this.today();
    this.registerInterval(window.setInterval(() => {
      if (this.today() === day) return;
      day = this.today();
      void this.refresh();
      this.plugin.requestAutoStatus();
    }, 60_000));
  }

  // ツールバーと詳細パネルは永続化、再描画はガント部だけ。詳細パネルはボードの右に並べ、ボードを覆わない（閉じるのは × か Esc）
  // persistent toolbar + detail; only the grid re-renders. The detail panel docks beside the board instead of covering it (closed by × or Esc)
  private buildSkeleton(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("ogantt-board");
    // ボードの中をクリックしたらフォーカスはボードに残す（バーなど押せない所でも）。ポップアウトの窓では、ビューのキー（取り消しなど）は
    // フォーカスがビューの中にあるときだけ届くため / a click anywhere in the board keeps focus in it (on bars and blank space too): in a pop-out
    // window the view's keys (undo and the rest) only arrive while focus is inside the view
    root.setAttr("tabindex", "-1");
    const pane = root.createDiv({ cls: "ogantt-pane" });
    this.renderToolbar(pane); // 右端に表示オプション / the view options sit on its right
    this.legendHost = pane.createDiv({ cls: "ogantt-legend" }); // 色の凡例 / the colour key
    this.filterHost = pane.createDiv({ cls: "ogantt-filterbar" }); // 統合フィルタ行 / the filter row
    this.gridHost = pane.createDiv({ cls: "ogantt-host" });
    this.detailEl = root.createDiv({ cls: "ogantt-detail", attr: { tabindex: "-1" } }); // Esc で欄を抜けたときの受け皿 / takes focus when Esc leaves a field
    this.detailEl.addEventListener("focusin", (e) => {
      const el = e.target as HTMLElement;
      if (el.instanceOf(HTMLInputElement)) this.fieldStart.set(el, el.value);
    });
    // ペインの大きさが変わったら（ウィンドウ・サイドバー・詳細パネルの開閉）見える行を描き足し、Fit は幅に合わせ直す
    // when the pane resizes (window, sidebars, the detail panel opening or closing) draw any newly visible rows, and re-fit in Fit
    const ro = new (this.contentEl.win as Window & typeof globalThis).ResizeObserver(() => { // ビューの窓のもの（ポップアウトでも）/ the view's own window's (popouts too)
      // 隠れたタブで描き直していたら、見えた今スクロール位置を戻す / a redraw done while the tab was hidden gets its scroll position now that it shows
      if (this.pendingScroll && this.boardMain?.clientHeight) this.applyScroll(this.boardMain, this.pendingScroll);
      this.paintWindow?.();
      // 最初の描画（boardKey が決まる）までは合わせ直さない：まだタスクが無いので「空」と出てしまう / no re-fit before the first render (with no tasks yet it would show "empty")
      if (this.zoom !== "Fit" || this.boardKey === null || this.gridHost.clientWidth === this.fitWidth) return;
      if (this.fitTimer != null) window.clearTimeout(this.fitTimer);
      this.fitTimer = window.setTimeout(() => this.rerender(), 80);
    });
    ro.observe(this.gridHost);
    this.register(() => ro.disconnect());
    // タッチの長押し＝右クリック（行と見出しのメニュー）。指が動いたらやめる / a touch long-press acts as a right-click (row and heading menus); moving the finger cancels it
    let press: { timer: number; x: number; y: number } | null = null;
    const cancel = () => {
      if (press) window.clearTimeout(press.timer);
      press = null;
    };
    this.gridHost.addEventListener("pointerdown", (e) => {
      cancel(); // 2 本目の指は前の長押しを取り消す / a second finger cancels the first press
      const target = e.target as HTMLElement;
      if (e.pointerType !== "touch" || !e.isPrimary || target.closest("input, textarea, select")) return;
      const timer = window.setTimeout(() => {
        press = null;
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
      }, 500);
      press = { timer, x: e.clientX, y: e.clientY };
    });
    this.gridHost.addEventListener("pointermove", (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancel();
    });
    for (const ev of ["pointerup", "pointercancel", "contextmenu"]) this.gridHost.addEventListener(ev, cancel);
  }

  // Esc：開いたポップオーバーやセルの編集は自分で閉じる。詳細パネルの入力欄にいれば欄を抜け、次の Esc でパネルを閉じて行へ戻る
  // Esc: an open popover or cell editor closes itself; in a panel field the first Esc leaves the field, the next closes the panel and returns to the row
  private onEscape(e: KeyboardEvent): boolean {
    const el = activeDocument.activeElement as HTMLElement | null;
    if (composing(e) || e.defaultPrevented || !this.detailEl.hasClass("is-open") || activeDocument.querySelector(".ogantt-popover, .ogantt-link-suggest") || el?.closest(".ogantt-tr :is(input, select)")) return true;
    if (el?.closest(".ogantt-detail") && el.matches("input, textarea, select")) {
      // 入力を取り消してから欄を抜ける（抜けたときの change で保存しない）。本文は抜けると保存する作りなのでそのまま
      // cancel the typing before leaving the field, so leaving doesn't save it (the body editor saves on leaving by design, so it's left as is)
      if (el.instanceOf(HTMLInputElement)) el.value = this.fieldStart.get(el) ?? el.value;
      this.detailEl.focus();
    } else this.closeDetail(true);
    return false;
  }

  // F2：キーボードで選んだ行の名前をその場で変更 / F2 renames the keyboard's row in place
  private onF2(): boolean {
    const el = activeDocument.activeElement as HTMLElement | null;
    const row = el?.matches(".ogantt-tr") ? this.rows[Number(el.dataset.index)] : undefined;
    const name = el?.querySelector<HTMLElement>(".ogantt-name-text");
    if (row?.kind !== "task" || !name) return true;
    this.renameInCell(name, row.task!, el!);
    return false;
  }

  // 最初の描画までの仮の行 / placeholder rows until the first render
  private showPlaceholder(): void {
    this.gridHost.empty();
    const sk = this.gridHost.createDiv({ cls: "ogantt-skeleton", attr: { "aria-busy": "true" } });
    for (let i = 0; i < 8; i++) sk.createDiv({ cls: "ogantt-skeleton-row" });
  }

  private refreshTimer: number | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 300);
  }

  // ビューを閉じたら保留中のタイマーを止める（破棄後の再描画を防ぐ）/ stop the pending timer on close
  async onClose(): Promise<void> {
    // 名前フィルタの入力待ちと保存待ちは捨てずに、ここで保存する / a pending filter edit or save is written now rather than dropped
    const pending = this.saveTimer != null || this.filterTimer != null;
    for (const timer of [this.refreshTimer, this.fitTimer, this.saveTimer, this.filterTimer, this.card.timer]) if (timer != null) window.clearTimeout(timer);
    this.refreshTimer = this.fitTimer = this.saveTimer = this.filterTimer = this.card.timer = null;
    this.card.el?.remove();
    closePopovers(this.contentEl.ownerDocument); // このビューの窓に開いたままのポップオーバーを閉じる / close any popover left open in this view's window
    if (pending) await this.plugin.saveData(this.plugin.settings);
  }

  // ディスクから集計し直して再描画 / re-collect from disk, then render
  async refresh(): Promise<void> {
    if (!this.gridHost) this.buildSkeleton();
    // 起動中（索引の途中）は仮の行のまま待ち、準備ができてから描く / during startup (mid-indexing) keep the placeholder and draw once ready
    if (!this.app.workspace.layoutReady) {
      this.app.workspace.onLayoutReady(() => this.scheduleRefresh());
      return;
    }
    // 書き込み・取り消し・ドラッグの最中は待つ（更新中のタスクを差し替えたり、掴んでいるバーを消したりしない）
    // wait while a write, an undo or a drag is under way (it would swap the tasks they update, or remove the bar being dragged)
    if (this.historyBusy > 0 || this.dragging) return this.scheduleRefresh();
    // 別のボードに切り替わったら、そのボードの表示オプションを読み、スクロール位置と選択は引き継がない
    // switching to another board loads its view options; the scroll position and the selection don't carry over
    const opened = this.boardKey !== this.folder;
    if (opened) {
      this.boardKey = this.folder;
      this.loadBoard();
      this.pad = { before: 0, after: 0 };
      this.boardMain = null;
      this.cursor = 0;
      this.closeDetail();
      this.retitle();
      // 履歴も新しく（前のボードの履歴は画面に無いファイルを書き戻してしまう）/ a fresh history too (the old one would rewrite files that aren't on screen)
      this.undoStack = [];
      this.redoStack = [];
      this.updateUndoButton();
    }
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.allFolders = collectFolders(this.app, this.plugin.settings, this.folder);
    this.rerender();
    // 日付による自動ステータスはボードを開いたときに頼む（読み直しのたびには回さない）/ automatic status is requested when a board opens (not on every reload)
    if (opened) this.plugin.requestAutoStatus();
    // 開いている詳細パネルも最新に。表示中の内容が変わったときだけ描き直し（別のノートの変更や、パネル自身の編集の後の読み直しでは描き直さない）、
    // 欄の入力中は触らない。タスクが消えていたら閉じる
    // bring an open detail panel up to date: rebuilt only when what it shows changed (not for another note's change, nor the reload after the
    // panel's own edit), and left alone while a field is being edited. Closed when its task is gone
    const path = this.selectedPath;
    if (!path || !this.detailEl.hasClass("is-open")) return;
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return this.closeDetail();
    const ae = activeDocument.activeElement;
    if (ae && ae !== this.detailEl && this.detailEl.contains(ae) && ae.matches("input, textarea, select")) return;
    if (this.panelSig !== this.sigOf(t, await readBody(this.app, path))) await this.openDetail(path);
  }

  // 日付による自動ステータスの 1 回分（tasks は既定のフォルダの配下すべて。main.ts から 1 つずつ呼ばれる）。全部を 1 つの取り消しにまとめ、
  // 件数と取り消しボタンを通知する。取り消しはステータスの欄だけを戻す（本文などその後の編集は消さない）。書けたノートとその行き先を返し、
  // 当たった決まりを記録する（保存は main.ts）。書けなかったノートは記録にもメモリにも載せない
  // one automatic-status run (tasks = everything under the default folder; called one at a time from main.ts). Everything is one undoable action,
  // announced with a count and an Undo button, and its undo puts back only the status field (later edits to the body etc. stay). Returns the notes
  // written with their new status and records the rules that fired (main.ts saves); a note that couldn't be written stays out of both
  async applyAutoStatus(tasks: Task[]): Promise<Map<string, string>> {
    const s = this.plugin.settings;
    const wrote = new Map<string, string>();
    const was = new Map(tasks.map((t) => [t.path, t.status]));
    // 今のままでよいノートは見たことだけ覚える（あとで手で変えたら分かるように）/ notes already right are only remembered as seen, so a later hand edit can be told apart
    const changes = [...autoStatusChanges(tasks, s.statuses, s.autoStatus, this.today())].filter(([p, c]) => {
      if (c.status !== was.get(p)) return true;
      s.autoStatus.fired[p] = { dates: c.dates, status: c.status };
      return false;
    });
    if (!changes.length) return wrote;
    const statuses: StatusChange[] = [];
    await this.mutate(tr().autoStatusLabel, [], async () => {
      // 全部書き終えてから記録する（途中で 1 件失敗しても、記録が実際の中身とずれないように）/ record only after every write settles, so one failure can't skew the record
      // 読んだときのステータスのままのノートだけ書く（その間に手で変えたものには触れない）/ write only notes still holding the status that was read (a hand edit meanwhile is left alone)
      const res = await Promise.allSettled(changes.map(([p, c]) => this.swapStatus(p, was.get(p), c.status)));
      changes.forEach(([p, c], i) => {
        const r = res[i];
        if (r.status !== "fulfilled" || !r.value) return;
        statuses.push({ path: p, from: was.get(p), to: c.status });
        wrote.set(p, c.status);
        s.autoStatus.fired[p] = { dates: c.dates, status: c.status };
      });
      if (res.some((r) => r.status === "rejected")) new Notice(tr().writeFailed);
      return statuses.length ? { statuses } : false;
    });
    if (wrote.size) this.undoToast = this.buttonNotice(tr().autoStatusDone(wrote.size), tr().undoShort, () => void this.undo(), 8000);
    return wrote;
  }

  // 自動ステータスで書いたステータスをメモリ上のタスクに反映して描き直す（メタデータの更新を待たない）
  // take the statuses automatic status wrote into the in-memory tasks and redraw, without waiting for the metadata cache
  takeStatuses(statuses: Map<string, string>): void {
    let hit = false;
    for (const t of this.tasks) {
      const st = statuses.get(t.path);
      if (st !== undefined) (t.status = st), (hit = true);
    }
    if (hit) this.rerender();
  }

  // 書き込み・取り消し・ドラッグの最中か（自動ステータスはどのボードもこれが終わるまで待つ）/ whether a write, an undo or a drag is under way (automatic status waits for every board)
  isBusy(): boolean {
    return this.historyBusy > 0 || this.historyRunning || this.dragging != null;
  }

  // 自動ステータスの取り消し・やり直し：ステータスの欄だけを戻す（進める）。その後で手で変えたノートには触れない
  // undo or redo an automatic-status run: only the status field goes back (or forward); a note whose status was changed by hand since is left alone
  private async replayStatuses(list: StatusChange[], redo: boolean): Promise<void> {
    await Promise.allSettled(list.map((c) => (redo ? this.swapStatus(c.path, c.from, c.to) : this.swapStatus(c.path, c.to, c.from))));
  }

  // ステータスが now のままなら next にする（undefined は未設定）。書いたら true / set the status to `next` if it still is `now` (undefined = unset); true when written
  private async swapStatus(path: string, now: string | undefined, next: string | undefined): Promise<boolean> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return false;
    const key = this.plugin.settings.keys.status;
    let done = false;
    await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
      if ((fm[key] == null ? undefined : String(fm[key])) !== now) return;
      if (next === undefined) delete fm[key];
      else fm[key] = next;
      done = true;
    });
    return done;
  }

  // 詳細パネルが見せている内容の印（タスクのデータと本文）/ a fingerprint of what the detail panel shows (the task's data and its body)
  private sigOf(t: Task, body: string): string {
    return `${JSON.stringify(t)}\u0000${body}`;
  }

  // ボードごとの表示オプション（グループ・色分け・表示切替・折りたたみ）を読む / load this board's view options (grouping, colour, toggles, collapsed rows)
  private loadBoard(): void {
    const b = this.plugin.settings.boards[`folder:${this.folder}`];
    this.groupBy = b?.groupBy ?? "folder";
    this.colorBy = b?.colorBy ?? "status";
    this.flat = b?.flat ?? false;
    this.rollup = b?.rollup ?? false;
    this.progressLine = b?.progressLine ?? false;
    this.showEmptyFolders = b?.showEmptyFolders ?? true;
    this.showDeps = b?.showDeps ?? true;
    this.showTags = b?.showTags ?? true;
    // 折りたたみはグループ化の軸ごと（"folder:Design" のように）。軸の印が無い古いキーはフォルダのもの
    // collapse keys belong to a grouping axis ("folder:Design", …); an older key without one is a folder key
    this.collapsed = new Set((b?.collapsed ?? []).map((k) => (/^(folder|status|assignee|tag):/.test(k) ? k : `folder:${k}`)));
    this.order = [...(b?.order ?? [])];
    this.disabled = new Set(b?.disabled ?? []);
    this.groupSel.value = this.groupBy;
    this.colorSel.value = this.colorBy;
  }

  // 表示オプションを覚える / remember the view options
  private saveBoard(): void {
    const { groupBy, colorBy, flat, rollup, progressLine, showEmptyFolders, showDeps, showTags } = this;
    // 手の並びと止めたタスクは、消えたノートの分を落として保存 / the manual order and disabled tasks are saved without notes that are gone
    const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof TFile;
    this.order = this.order.filter(exists);
    this.disabled = new Set([...this.disabled].filter(exists));
    this.plugin.settings.boards[`folder:${this.folder}`] = { groupBy, colorBy, flat, rollup, progressLine, showEmptyFolders, showDeps, showTags, collapsed: [...this.collapsed], order: this.order, disabled: [...this.disabled] };
    this.saveSoon();
  }

  // 畳んだ見出しのキーを付け替える（ステータスの改名）。保存済みのボード設定は main.ts が付け替える
  // re-key a collapsed heading (a status rename); main.ts re-keys the saved board setups
  renameCollapsed(from: string, to: string): void {
    if (!this.collapsed.has(from) || this.collapsed.has(to)) return;
    this.collapsed.delete(from);
    this.collapsed.add(to);
  }

  // 設定の保存を少し待ってまとめる（打鍵や連続操作のたびに data.json を書き換えない）/ batch settings saves (data.json isn't rewritten on every keystroke or click)
  private saveSoon(): void {
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.plugin.saveData(this.plugin.settings);
    }, 500);
  }

  // メモリ上の this.tasks から描画（ディスクは読まない）/ render from in-memory tasks (no disk read)
  // ドラッグや整列の直後、metadataCache 更新前に正しい位置を即表示するため / shows correct positions before metadataCache updates
  rerender(): void {
    if (!this.gridHost) this.buildSkeleton();
    this.hideCard(); // 下のバーが作り直される / the bar under it is about to be replaced
    this.assigneeCache = this.peopleColors = null;
    this.tagColorCache.clear();
    this.renderLegend(); // 凡例はデータ（担当者）で変わる / the legend depends on the data (the assignees)
    this.renderFilterBar(); // 統合フィルタ行を最新データで更新 / refresh the unified filter row
    const view = this.processTasks(); // フィルタ＋グループ適用後 / after filter + group remap
    const compare = this.comparator();
    if (this.flat) {
      // フラット：フォルダも親子も無視して全タスクを1本のソート済みリストに / flat: one sorted list, no grouping/nesting
      this.rows = view.slice().sort(compare).map((task) => ({ kind: "task", group: "", depth: 0, task }));
    } else {
      // フォルダグループ化＋オプションON のときだけ空フォルダもノード化 / seed empty folders only when grouping by folder and the option is on
      const folders = this.showEmptyFolders && this.groupBy === "folder" ? this.allFolders : [];
      // 親子ネストはフォルダグループ化のときだけ / nest by parent only when grouping by folder
      const axis = `${this.groupBy}:`;
      const shut = new Set([...this.collapsed].filter((k) => k.startsWith(axis)).map((k) => k.slice(axis.length)));
      this.rows = buildRows(view, shut, folders, compare, this.groupBy === "folder");
    }
    // 描き直してもスクロール位置を保つ。縦はそのまま、横は画面中央の日付で（縮尺を変えても同じ日が中央に残る）
    // keep the scroll position across redraws: vertical as is, horizontal by the date in the middle (a zoom change keeps that day centred)
    // 隠れたタブではどの値も 0 と読めるので、見えていたときに覚えた位置を使う / a hidden tab reads 0 everywhere, so use the position remembered while visible
    const prev = this.boardMain;
    const keep = prev && (prev.clientHeight ? this.scrollOf(prev) : this.pendingScroll ?? this.scrollMemo);
    const hadFocus = !!this.tbodyEl?.contains(activeDocument.activeElement); // キーボードで行にいたら描き直した後も行へ / keep keyboard focus on the rows
    this.baseRange = computeRange(view, this.today());
    // Fit は範囲を幅に合わせるのでのばさない。ほかは描き直しの前に見ていた日が範囲に残るよう余白を足す
    // Fit fits the range to the width, so it never grows; otherwise the pad keeps the day in view before the redraw inside the range
    if (this.zoom === "Fit") this.range = this.baseRange;
    else {
      // 見ていた日が範囲の外に出たときだけ（縮尺の変更・タスクの移動）。中にあれば余白は変えない（描き直しのたびに上限を超えて育たない）
      // only when that day fell outside the range (a zoom change, a task moved); otherwise the pad stays, so redraws can't grow it past the limit
      const shown = padRange(this.baseRange, this.pad);
      if (keep && (keep.day < shown.min || keep.day > shown.max + 1)) this.pad = padToCover(this.baseRange, this.pad, keep.day, this.zoom);
      this.range = padRange(this.baseRange, this.pad);
    }
    this.ppd = this.computePpd();

    // のばすときは同じスクロール枠を使い続ける（つまみのドラッグや慣性のスクロールが途切れない）/ a grow keeps the same scroll box, so a thumb drag or momentum scroll carries on
    // 何も出ないとき：絞り込みのせいならそう伝えて解除ボタンを、フォルダが本当に空なら新規作成ボタンを出す
    // nothing to show: when the filters hide everything say so and offer Clear filters; when the folder is truly empty offer New task
    const filtered = view.length === 0 && this.tasks.length > 0;
    const empty = this.rows.length === 0 || filtered;
    const reuse = this.extending && !empty && prev?.isConnected ? prev : null;
    if (!reuse) this.gridHost.empty();
    this.boardMain = null;
    this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
    if (empty) return this.renderEmpty(filtered);
    const main = reuse ?? this.gridHost.createDiv({ cls: "ogantt-main" });
    reuse?.empty();
    this.boardMain = main;
    this.renderGrid(main);
    if (keep) this.applyScroll(main, keep);
    this.paintWindow?.(true);
    // 端に着いたまま描き直したとき（開いた直後など）は、スクロールを待たずにのばす / when drawn right at an edge (just opened, say), grow without waiting for a scroll
    if (!this.extending) main.win.requestAnimationFrame(() => this.growNearEdge());
    // キーボードで行にいたら描き直した後も行へ（スクロールはさせない。行が描かれていなければ表の本体へ）
    // keyboard focus stays on the rows after a redraw, without scrolling (on the table body when that row isn't drawn)
    if (hadFocus) (this.tbodyEl.querySelector<HTMLElement>(`.ogantt-tr[data-index="${this.cursor}"]`) ?? this.tbodyEl).focus({ preventScroll: true });
  }

  // 行の並べ方：列で並べ替え中はその列、「手動」なら手で決めた並び。止めたタスクはいつも兄弟の最後
  // how rows sort: by the sorted column, or the manual order while the sort is "manual"; disabled tasks always last among their siblings
  private comparator(): (a: Task, b: Task) => number {
    const s = this.plugin.settings;
    const byColumn = taskComparator(this.columns(), s); // "manual" は列に無いので開始日順 / "manual" is no column, so this is by start
    return disabledLast(this.disabled, s.sortBy === "manual" ? manualComparator(this.order, byColumn) : byColumn);
  }

  // 行を兄弟の中で 1 つ上・下へ（並べ替えは「手動」になる）。動かせたら true
  // move a row one up or down among its siblings (the sort becomes "manual"); true when it moved
  private moveRow(i: number, dir: -1 | 1): boolean {
    const row = this.rows[i];
    if (row?.kind !== "task") return false;
    let j = i + dir;
    while (this.rows[j]?.kind === "task" && this.rows[j].depth > row.depth) j += dir; // 子の行は飛ばす / skip child rows
    const other = this.rows[j];
    if (other?.kind !== "task" || other.depth !== row.depth) return false;
    this.placeRow(row.task!.path, other.task!.path, dir < 0 ? "before" : "after");
    return true;
  }

  // src を target の前か後ろへ。今の並びを起点に（列で並べていたなら、その見た目から）手の並びを作る
  // place `src` before or after `target`; the manual order starts from the order on screen (a column sort included)
  private placeRow(src: string, target: string, where: "before" | "after"): void {
    const order = [...new Set(this.tasks.slice().sort(this.comparator()).map((t) => t.path))].filter((p) => p !== src);
    order.splice(order.indexOf(target) + (where === "after" ? 1 : 0), 0, src);
    this.order = order;
    this.plugin.settings.sortBy = "manual";
    this.saveBoard();
    this.rerender();
    const k = this.rows.findIndex((r) => r.task?.path === src);
    if (k >= 0) this.focusRow(k);
  }

  // タスクを止める・戻す（取り消せる。ノートには書かない）/ disable or enable tasks (undoable; nothing is written to the notes)
  private setDisabled(paths: string[], on: boolean, label?: string): void {
    for (const p of paths) {
      if (on) this.disabled.add(p);
      else this.disabled.delete(p);
    }
    if (label) this.record({ label, files: new Map(), moves: [], created: [], deleted: [], disable: { paths, on } });
    this.saveBoard();
    this.rerender();
  }

  // スクロール位置：縦はそのまま、横は画面の中央の日付（縮尺が変わっても同じ日が中央に残る）
  // the scroll position: vertical as is, horizontal as the date in the middle (a zoom change keeps that day centred)
  private scrollOf(main: HTMLElement): { top: number; day: number } {
    return { top: main.scrollTop, day: this.range.min + (main.scrollLeft + (main.clientWidth - this.tableWidth()) / 2) / this.ppd };
  }

  // 位置を戻す。隠れていて戻せなければ、見えたときに戻す（ResizeObserver から）/ restore a position; when hidden and it can't be, it's restored once shown (from the ResizeObserver)
  private applyScroll(main: HTMLElement, at: { top: number; day: number }): void {
    if (!main.clientHeight) return void (this.pendingScroll = at);
    this.pendingScroll = null;
    main.scrollTop = at.top;
    main.scrollLeft = (at.day - this.range.min) * this.ppd - (main.clientWidth - this.tableWidth()) / 2;
    this.scrollMemo = this.scrollOf(main);
  }

  // 空の状態：理由と次の一手 / the empty state: why it's empty, and what to do next
  private renderEmpty(filtered: boolean): void {
    this.paintWindow = null;
    const box = this.gridHost.createDiv({ cls: "ogantt-empty" });
    box.createDiv({ text: filtered ? tr().noMatches : tr().emptyMessage(this.folder || tr().vaultRoot) });
    const btn = box.createEl("button", { cls: "mod-cta", text: filtered ? tr().presetClear : tr().newTaskName });
    btn.onclick = () => {
      if (!filtered) return void this.createNewTask();
      this.plugin.settings.filters = [];
      this.commitFilters();
    };
  }

  // 1 日あたりピクセルを決定。Fit はペイン幅から算出（収まらなければ最小幅で横スクロール）
  // pixels-per-day; Fit derives it from the pane width (falls back to scrolling below MIN_PPD)
  private computePpd(): number {
    if (this.zoom !== "Fit") return pxPerDay(this.zoom);
    const totalDays = Math.max(1, this.range.max - this.range.min + 1);
    this.fitWidth = this.gridHost?.clientWidth ?? 0;
    const avail = this.fitWidth - this.tableWidth() - FIT_SCROLLBAR_PAD;
    if (avail <= 0) return pxPerDay("Week"); // まだレイアウト前 / not laid out yet
    return Math.max(MIN_PPD, Math.floor(avail / totalDays));
  }

  // ----- テーブル列 / table columns -----
  // 表示中の列（name は常時、その他は設定の visibleColumns に従い、columnOrder の順）/ visible columns (name always; the rest per settings, in columnOrder)
  private visibleColumns(): ColumnDef[] {
    return visibleColumns(this.columns(), this.plugin.settings.visibleColumns ?? [], this.plugin.settings.columnOrder ?? []);
  }

  // 設定タイムゾーンでの今日 / today in the configured timezone
  private today(): number {
    return todayIndex(undefined, this.plugin.settings.tz);
  }
  // 全列の定義（組み込み→Custom field の順）。Custom field の構成が変わったときだけ作り直す
  // every column definition (built-ins, then custom fields); rebuilt only when the custom fields change
  private columnCache: { sig: string; cols: ColumnDef[] } | null = null;
  private columns(): ColumnDef[] {
    const sig = JSON.stringify(validCustomFields(this.plugin.settings));
    if (this.columnCache?.sig !== sig) this.columnCache = { sig, cols: allColumns(this.plugin.settings) };
    return this.columnCache.cols;
  }
  // 表全体の幅（表示中の列幅の合計）/ total table width (sum of visible column widths)
  private tableWidth(): number {
    // スクロールのたびに呼ばれるので、列ごとに列定義を引き直さない / called on every scroll, so the definitions aren't looked up again per column
    const widths = this.plugin.settings.columnWidths;
    return this.visibleColumns().reduce((w, c) => w + columnWidth(c, widths), 0);
  }

  // 列の実効幅（ユーザー上書き > 既定）/ effective column width (user override > default)
  private colW(id: string): number {
    const def = this.columns().find((c) => c.id === id);
    return def ? columnWidth(def, this.plugin.settings.columnWidths) : 0;
  }

  // 列幅を内容に合わせて自動フィット（グリップの 2 回押し）。描かれていない行も含め、全タスク行のその列を見えない場所に描いて実測する
  // auto-fit a column to its content (grip double-press): every task row's cell for it, drawn or not, is painted off-screen and measured
  private autoFitColumn(id: string, th: HTMLElement): void {
    const col = this.visibleColumns().find((c) => c.id === id);
    if (!col) return;
    const probe = this.tbodyEl.createDiv({ cls: "ogantt-measure-probe" });
    const noWidth = new Map([[id, 0]]);
    this.rows.forEach((row, i) => { if (row.kind === "task") this.renderRow(probe, row, i, [col], noWidth); });
    // 計測中はインライン幅を外して計測用クラスを付与（!important を使わないため）
    // remove inline widths while measuring so the measuring class applies without !important
    const saved = th.style.width;
    const cells = [th, ...Array.from(probe.querySelectorAll<HTMLElement>(".ogantt-td"))];
    cells.forEach((el) => {
      el.style.removeProperty("width");
      el.addClass("ogantt-measure");
    });
    const w = Math.max(40, ...cells.map((el) => el.offsetWidth)) + 2;
    th.removeClass("ogantt-measure");
    th.style.width = saved;
    probe.remove();
    this.plugin.settings.columnWidths[id] = w;
    void this.plugin.saveLook(); // 保存して開いているボードを描き直す / persist and redraw the open boards
  }
  // 列ヘッダクリックでソート列/方向を切替えて永続化 / clicking a header toggles sort column/direction (persisted)
  private toggleSort(id: string, refocus = false): void {
    const s = this.plugin.settings;
    if (s.sortBy === id) s.sortDir = s.sortDir === "asc" ? "desc" : "asc";
    else {
      s.sortBy = id;
      s.sortDir = "asc";
    }
    this.saveSoon();
    this.rerender();
    // キーボードで並べ替えたら、作り直したヘッダーへフォーカスを戻す / after a keyboard sort, focus goes back to the rebuilt header
    if (refocus) this.boardMain?.querySelector<HTMLElement>(`.ogantt-th[data-col="${CSS.escape(id)}"]`)?.focus();
  }

  // 列の表示/非表示を切替えて永続化 / toggle a column's visibility and persist
  private setColumnVisible(id: string, on: boolean): void {
    const s = this.plugin.settings;
    Object.assign(s, toggleColumn(this.columns(), s.visibleColumns ?? [], s.columnOrder ?? [], id, on));
    void this.plugin.saveLook(); // 列はどのボードでも共通なので、開いているボードと設定画面も描き直す / columns are shared, so every open board and the settings tab redraw
  }

  // 列を 1 つ上か下へ（表示中・隠した列それぞれの中で）。動かせたら true / move a column one up or down (within the shown or the hidden ones); true when it moved
  private shiftColumn(id: string, dir: -1 | 1): boolean {
    const s = this.plugin.settings;
    const order = moveColumn(this.columns(), s.visibleColumns ?? [], s.columnOrder ?? [], id, dir);
    if (!order) return false;
    s.columnOrder = order;
    void this.plugin.saveLook();
    return true;
  }

  // ----- 統合フィルタ（ステータス/担当者/タグ/開始日/期限日）/ unified filter -----

  // 保存＋盤面再描画（ポップオーバーは body 上なので残る）/ save + redraw board (popovers survive on body)
  private commitFilters(): void {
    this.saveSoon();
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
    else if (field === "assignee") base = this.assigneeList().map((a) => [a, linkLabel(a)] as [string, string]);
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
    const s = this.plugin.settings;
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
      const open = chip.createEl("button", { cls: "ogantt-filter-chip-main", attr: { "data-focus": `filter-${i}` } });
      setIcon(open.createSpan({ cls: "ogantt-filter-chip-ico" }), this.filterIcon(f));
      open.createSpan({ text: this.filterSummary(f) });
      open.onclick = () => this.openFilterEditor(chip, i);
      const x = chip.createEl("button", { cls: "ogantt-filter-chip-x", attr: { "aria-label": tr().dfRemove } });
      setIcon(x, "x");
      x.onclick = () => { filters.splice(i, 1); this.commitFilters(); };
    });
    // 2 件以上のとき、右端に AND/OR トグル / with 2+ filters, a match-all/any toggle on the right
    if (filters.length >= 2) {
      const match = host.createDiv({ cls: "ogantt-filter-match" });
      match.createSpan({ cls: "ogantt-filter-match-label", text: tr().dfMatchLabel });
      const sel = match.createEl("select", { cls: "dropdown" });
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
      this.plugin.settings.filters.push({ kind: "text", field: "name", op: "contains", value: "" });
      this.commitFilters();
      this.openLastFilterEditor();
    }));
    const addCat = (field: CategoryField, label: string, icon: string) => {
      m.addItem((i) => i.setTitle(label).setIcon(icon).onClick(() => {
        this.plugin.settings.filters.push({ kind: "category", field, op: "is", values: [] });
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
        this.plugin.settings.filters.push({ kind: "date", field, op: "onOrAfter", value: { kind: "preset", preset: "today" } });
        this.commitFilters();
        this.openLastFilterEditor();
      }));
    };
    addDate("start", tr().fieldStart);
    addDate("end", tr().fieldDue);
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom + 4 }, anchor.doc);
  }

  // 追加直後、最後のフィルタのエディタを開く / open the just-added filter's editor
  private openLastFilterEditor(): void {
    const chips = this.filterHost.querySelectorAll(".ogantt-filter-chip");
    const last = chips[chips.length - 1] as HTMLElement | undefined;
    if (last) this.openFilterEditor(last, this.plugin.settings.filters.length - 1);
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
    this.plugin.settings.filters = clone.filters;
    this.plugin.settings.filterMatch = clone.filterMatch;
    this.commitFilters();
  }

  // 現在のフィルタ構成をプリセットとして保存 / save the current filter config as a preset
  private savePreset(name: string): void {
    const s = this.plugin.settings;
    s.filterPresets.push({ name, filterMatch: s.filterMatch, filters: JSON.parse(JSON.stringify(s.filters)) as Filter[] });
    this.commitFilters();
  }

  // プリセットのポップオーバー（組み込み＋マイプリセット＋保存/クリア）/ presets popover
  private openPresetMenu(anchor: HTMLElement): void {
    const s = this.plugin.settings;
    openPopover(anchor, "ogantt-datemenu", (menu, close) => {
      menu.addClass("ogantt-presetmenu");
      const renderBody = () => {
        menu.empty();
        // 組み込み / built-in
        menu.createDiv({ cls: "ogantt-preset-heading", text: tr().presetBuiltinHeading });
        for (const p of this.builtinPresets()) {
          menu.createEl("button", { cls: "ogantt-preset-item", text: p.name }).onclick = () => { this.applyPreset(p); close(); };
        }
        // マイプリセット（クリックで適用／ゴミ箱で削除）/ user presets (apply on click, trash to delete)
        if (s.filterPresets.length > 0) {
          menu.createDiv({ cls: "ogantt-preset-heading", text: tr().presetUserHeading });
          s.filterPresets.forEach((p, i) => {
            const item = menu.createDiv({ cls: "ogantt-preset-item ogantt-preset-user" });
            item.createEl("button", { cls: "ogantt-preset-apply", text: p.name }).onclick = () => { this.applyPreset(p); close(); };
            const del = item.createEl("button", { cls: "ogantt-preset-del", attr: { "aria-label": tr().presetDelete } });
            setIcon(del, "trash-2");
            del.onclick = () => { s.filterPresets.splice(i, 1); this.commitFilters(); renderBody(); };
          });
        }
        // 現在フィルタがあるとき：保存フォーム＋クリア / when filters exist: save form + clear
        if (s.filters.length > 0) {
          menu.createDiv({ cls: "ogantt-preset-sep" });
          const save = menu.createDiv({ cls: "ogantt-preset-save" });
          const input = save.createEl("input", { type: "text", cls: "ogantt-preset-name", attr: { "aria-label": tr().presetNamePlaceholder } });
          input.placeholder = tr().presetNamePlaceholder;
          const btn = save.createEl("button", { cls: "ogantt-preset-savebtn", text: tr().presetSave });
          const doSave = () => { const name = input.value.trim(); if (!name) { input.focus(); return; } this.savePreset(name); renderBody(); };
          btn.onclick = doSave;
          input.onkeydown = (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); doSave(); } };
          const clear = menu.createEl("button", { cls: "ogantt-preset-item ogantt-preset-clear" });
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
    const f = this.plugin.settings.filters[index];
    if (!f) return;
    openPopover(anchor, "ogantt-datemenu", (menu, close) => {
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
        del.onclick = () => { this.plugin.settings.filters.splice(index, 1); commit(); close(); };

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
    const opSel = opRow.createEl("select", { cls: "dropdown" });
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
        // 人は表示名で比べる（"[[Ben]]" と "Ben" は同じ人。絞り込みと同じ決まり）/ people compare by display name ("[[Ben]]" and "Ben" are one person, as in the filter)
        const same = (x: string): boolean => (f.field === "assignee" ? linkLabel(x) === linkLabel(val) : x === val);
        cb.checked = f.values.some(same);
        item.createSpan({ text: label });
        cb.onchange = () => {
          if (cb.checked) { if (!f.values.some(same)) f.values.push(val); }
          else f.values = f.values.filter((x) => !same(x));
          commit(); // チェック状態はローカルに残るので rebuild 不要 / no rebuild: checkbox keeps its own state
        };
      }
    }
  }

  // テキスト（タスク名）のエディタ本体 / text (task name) editor body
  private renderTextEditor(menu: HTMLElement, f: TextFilter, commit: () => void): void {
    const opRow = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const opSel = opRow.createEl("select", { cls: "dropdown" });
    for (const op of ["is", "isNot", "contains", "notContains", "startsWith", "endsWith"] as TextOp[]) {
      const o = opSel.createEl("option", { text: this.textOpLabel(op), value: op });
      if (op === f.op) o.selected = true;
    }
    opSel.onchange = () => { f.op = opSel.value as TextOp; commit(); };
    const body = menu.createDiv({ cls: "ogantt-datemenu-val" });
    const input = body.createEl("input", { type: "text", cls: "ogantt-datemenu-text", attr: { "aria-label": tr().fieldName } });
    input.value = f.value;
    // 打つ手が止まってから絞り込む（打鍵ごとに描き直さない）/ filter once typing pauses, not on every keystroke
    input.oninput = () => {
      f.value = input.value;
      if (this.filterTimer != null) window.clearTimeout(this.filterTimer);
      this.filterTimer = window.setTimeout(() => {
        this.filterTimer = null;
        commit();
      }, 150);
    };
  }

  // 日付（開始日/期限日）のエディタ本体 / date editor body
  private renderDateEditor(menu: HTMLElement, f: DateFilterItem, commit: () => void, rebuild: () => void): void {
    const todayISO = dayToStr(this.today());
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
    const opSel = opRow.createEl("select", { cls: "dropdown" });
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
    const modeSel = body.createEl("select", { cls: "dropdown" });
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
      const unitSel = body.createEl("select", { cls: "dropdown" });
      for (const [u, text] of [["day", tr().dfDay], ["week", tr().dfWeek], ["month", tr().dfMonth]] as [DateUnit, string][]) {
        const o = unitSel.createEl("option", { text, value: u });
        if (u === v.unit) o.selected = true;
      }
      unitSel.onchange = () => { v.unit = unitSel.value as DateUnit; commit(); };
      const dirSel = body.createEl("select", { cls: "dropdown" });
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
    // フォルダ名はボードの切り替えも兼ねる（押すと別のフォルダを開ける）/ the folder name doubles as a board switcher
    const title = bar.createEl("button", { cls: "ogantt-title" }); // 名前は retitle() が付ける / retitle() names it
    this.titleText = title.createSpan();
    setIcon(title.createSpan({ cls: "ogantt-title-caret" }), "chevron-down");
    title.onclick = () => {
      const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => (f.isRoot() ? "" : f.path)).sort();
      new PickModal(this.app, folders, (f) => f || tr().vaultRoot, tr().menuOpen, (folder) =>
        void this.leaf.setViewState({ type: VIEW_TYPE_GANTT, active: true, state: { folder } })).open();
    };
    // 新規タスク追加（アイコン＋ラベル）/ add a new task (icon + label)
    const add = bar.createEl("button", { cls: "ogantt-add" });
    setIcon(add, "plus");
    add.createSpan({ cls: "ogantt-add-label", text: tr().newTaskName });
    add.setAttr("aria-label", tr().newTaskAria);
    add.onclick = () => void this.createNewTask();
    // 種類（ノート / カンバン / キャンバス）を選んで作る / pick the kind (note / kanban / canvas) to create
    const kinds = bar.createEl("button", { cls: "ogantt-add-kind", attr: { "aria-label": tr().newTaskKindAria } });
    setIcon(kinds, "chevron-down");
    kinds.onclick = () => {
      const m = new Menu();
      const label: Record<TaskKind, string> = { note: tr().kindNote, kanban: tr().kindKanban, canvas: tr().kindCanvas };
      for (const kind of ["note", "kanban", "canvas"] as TaskKind[]) {
        m.addItem((i) => i.setTitle(label[kind]).setIcon(KIND_ICON[kind]).onClick(() => void this.createNewTask(kind)));
      }
      // ボタンの下に開く（キーボードで押したときマウスの位置は 0,0）/ opened under the button (a keyboard press has its mouse position at 0,0)
      const r = kinds.getBoundingClientRect();
      m.showAtPosition({ x: r.left, y: r.bottom + 4 }, kinds.doc);
    };
    // 今日へスクロール / scroll to today
    const todayBtn = bar.createEl("button", { cls: "ogantt-today-btn", text: tr().today });
    todayBtn.onclick = () => this.scrollToToday();
    // 縮尺は 1 つにつながったボタン群（押されている 1 つが現在の縮尺）/ zoom as a segmented control (the pressed one is current)
    const zoomLabel: Record<ZoomMode, string> = { Day: tr().zoomDay, Week: tr().zoomWeek, Month: tr().zoomMonth, Fit: tr().zoomFit };
    const seg = bar.createDiv({ cls: "ogantt-seg", attr: { role: "group" } });
    for (const z of ["Day", "Week", "Month", "Fit"] as ZoomMode[]) {
      const btn = seg.createEl("button", { text: zoomLabel[z], attr: { "aria-pressed": String(z === this.zoom) } });
      btn.toggleClass("is-active", z === this.zoom);
      btn.onclick = () => {
        this.zoom = z; // ppd は rerender 内の computePpd() が決める / ppd is set by computePpd() in rerender
        this.pad = { before: 0, after: 0 }; // 足した日は捨てる（中央の日は rerender が範囲に入れる）/ drop the added days (rerender keeps the centre day in range)
        seg.querySelectorAll("button").forEach((b) => {
          b.toggleClass("is-active", b === btn);
          b.setAttr("aria-pressed", String(b === btn));
        });
        this.rerender(); // 縮尺だけの変更なのでディスクは読み直さない / only the scale changed, so no disk read
      };
    }
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

    // 右端：グループ化・色分け・表示メニュー。データに依存しないので一度だけ作る（描き直しても表示メニューの起点が消えない）。
    // ときどき切り替える表示と列は表示メニューへ、読み直しと PNG の書き出しは「⋯」メニューへ
    // on the right: group by, colour by and the Display menu, built once since they don't depend on the data (so the Display menu's
    // anchor survives redraws). Occasional switches and the columns live in the Display menu; reload and PNG export in the "⋯" menu
    const host = bar.createDiv({ cls: "ogantt-options" });
    // 見える名前つきのセレクト（アイコンだけに頼らない）/ a select with a visible name, not just an icon
    const makeSelect = (icon: string, label: string, opts: [string, string][], on: (v: string) => void): HTMLSelectElement => {
      const wrap = host.createEl("label", { cls: "ogantt-opt" });
      setIcon(wrap.createSpan({ cls: "ogantt-opt-ico" }), icon);
      wrap.createSpan({ text: label });
      const sel = wrap.createEl("select", { cls: "dropdown", attr: { "aria-label": label } });
      for (const [value, text] of opts) sel.createEl("option", { text, value });
      sel.addEventListener("change", () => on(sel.value));
      return sel;
    };
    this.groupSel = makeSelect("layers", tr().optGroupLabel,
      [["folder", tr().optGroupFolder], ["status", tr().fieldStatus], ["assignee", tr().fieldAssignee], ["tag", tr().fieldTags]],
      (v) => { this.groupBy = v as GroupBy; this.saveBoard(); this.rerender(); });
    this.colorSel = makeSelect("palette", tr().optColorLabel, [["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
      (v) => { this.colorBy = v as typeof this.colorBy; this.saveBoard(); this.rerender(); });
    const display = host.createEl("button", { cls: "ogantt-opt-gear", attr: { "aria-haspopup": "true" } });
    setIcon(display.createSpan({ cls: "ogantt-opt-ico" }), "sliders-horizontal");
    display.createSpan({ text: tr().optDisplay });
    setIcon(display.createSpan({ cls: "ogantt-preset-caret" }), "chevron-down");
    display.onclick = () => this.openDisplayMenu(display);
  }

  // 表示の「⋯」メニュー：PNG に書き出す・読み直す（ツールバーに置くほど頻繁ではない操作）
  // the view's "⋯" menu: export as PNG and reload (not frequent enough for the toolbar)
  onPaneMenu(menu: Menu, source: string): void {
    menu.addItem((i) => i.setTitle(tr().exportPng).setIcon("image-down").onClick(() => void this.exportPng()));
    menu.addItem((i) => i.setTitle(tr().reloadAria).setIcon("refresh-cw").onClick(() => void this.refresh()));
    super.onPaneMenu(menu, source);
  }

  // 表示メニュー：このボードの表示の切り替えと、表の列の出し分け。一度だけ作り、切り替えたら使える項目だけを更新する
  // the Display menu: this board's display switches and the table's columns; built once, a switch only updates which items are available
  private openDisplayMenu(anchor: HTMLElement): void {
    openPopover(anchor, "ogantt-colmenu", (menu) => {
      const row = (label: string, checked: boolean, on: (v: boolean) => void): HTMLInputElement => {
        const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
        const cb = item.createEl("input", { type: "checkbox" });
        cb.checked = checked;
        item.createSpan({ text: label });
        cb.addEventListener("change", () => on(cb.checked));
        return cb;
      };
      // ロールアップと空フォルダは、フォルダでグループ化してフラット表示でないときだけ。消さずに無効で残し、理由を添える
      // roll up and empty folders need folder grouping with Flat off; they stay, disabled, with the reason underneath
      const folderOnly: HTMLInputElement[] = [];
      let note: HTMLElement | null = null;
      const sync = () => {
        const off = this.groupBy !== "folder" || this.flat;
        folderOnly.forEach((cb) => (cb.disabled = off));
        note?.toggle(off);
      };
      const toggle = (key: "showDeps" | "showTags" | "progressLine" | "flat" | "rollup" | "showEmptyFolders", label: string) =>
        row(label, this[key], (v) => {
          this[key] = v;
          this.saveBoard();
          this.rerender();
          sync();
        });
      menu.createDiv({ cls: "ogantt-preset-heading", text: tr().optTimeline });
      toggle("showDeps", tr().optArrows);
      toggle("showTags", tr().optTagLabels);
      toggle("progressLine", tr().optProgressLine);
      menu.createDiv({ cls: "ogantt-preset-heading", text: tr().optRows });
      toggle("flat", tr().optFlat);
      folderOnly.push(toggle("rollup", tr().optRollup), toggle("showEmptyFolders", tr().optShowEmpty));
      note = menu.createDiv({ cls: "ogantt-colmenu-note", text: tr().folderOnly });
      sync();
      menu.createDiv({ cls: "ogantt-preset-heading", text: tr().optColumns });
      // 列：表示中の列を表の順に、その下に隠した列を薄く。矢印で並べ替え（キーボードでも）、作り直した後もフォーカスは同じ操作へ
      // columns: the shown ones in table order, the hidden ones dimmed below; the arrows reorder (keyboard too), and focus stays on the same control after a rebuild
      const cols = menu.createDiv();
      const paintCols = (focus?: string): void => {
        cols.empty();
        const s = this.plugin.settings;
        const list = columnList(this.columns(), s.visibleColumns ?? [], s.columnOrder ?? []);
        list.forEach(({ col, on }, i) => {
          const item = cols.createDiv({ cls: "ogantt-colmenu-col" + (on ? "" : " is-off") });
          const label = item.createEl("label", { cls: "ogantt-colmenu-item" });
          const cb = label.createEl("input", { type: "checkbox", attr: { "data-col": `${col.id}|0` } });
          cb.checked = on;
          label.createSpan({ text: col.label() });
          cb.addEventListener("change", () => {
            this.setColumnVisible(col.id, cb.checked);
            paintCols(`${col.id}|0`);
          });
          for (const dir of [-1, 1] as const) {
            const b = item.createEl("button", { cls: "clickable-icon", attr: { "data-col": `${col.id}|${dir}`, "aria-label": dir < 0 ? tr().colMoveUp(col.label()) : tr().colMoveDown(col.label()) } });
            setIcon(b, dir < 0 ? "arrow-up" : "arrow-down");
            b.disabled = list[i + dir]?.on !== on; // 端と、表示中/隠した列の境目 / at an end, or at the shown/hidden boundary
            b.onclick = () => { if (this.shiftColumn(col.id, dir)) paintCols(`${col.id}|${dir}`); };
          }
        });
        // 端まで動かして押せなくなったら、反対向きの矢印へ / once a column reaches an end and its arrow is disabled, focus moves to the other arrow
        const el = focus ? cols.querySelector<HTMLInputElement | HTMLButtonElement>(`[data-col="${CSS.escape(focus)}"]`) : null;
        const box = el?.closest(".ogantt-colmenu-col");
        (el?.disabled ? box?.querySelector<HTMLElement>("button:not(:disabled)") ?? box?.querySelector("input") : el)?.focus();
      };
      paintCols();
    });
  }

  // 色の凡例の中身。画面の凡例と書き出す PNG の両方がここから作る（ステータスは押すと編集、担当者は押すと色を選ぶ）
  // the colour key's entries; both the on-screen legend and the exported PNG are built from them (a status opens its editor, a person their colour)
  private colorKey(): { color: string; label: string; edit?: (chip: HTMLElement) => void }[] {
    if (this.colorBy === "status") {
      return this.plugin.settings.statuses.map((s) => ({ color: s.color, label: s.label, edit: (chip: HTMLElement) => this.openStatusEditor(chip, s) }));
    }
    const none = this.tasks.some((t) => !t.assignees.length) ? [{ color: FALLBACK_BAR, label: tr().noneLabel }] : [];
    return [...this.assigneeList().map((a) => ({
      color: this.assigneeColor(a),
      label: linkLabel(a),
      // 色を選んである人には「自動の色に戻す」も / someone with a picked colour also gets "back to automatic"
      edit: (chip: HTMLElement) => pickColor(chip, this.assigneeColor(a), (c) => this.setColorOverride("assignee", linkLabel(a), c),
        this.plugin.settings.assigneeColors.some((c) => c.name === linkLabel(a)) ? () => this.setColorOverride("assignee", linkLabel(a), null) : undefined),
    })), ...none];
  }

  // 凡例（色分けの基準を説明）。ステータスなら ＋ で追加できる / the legend explaining the colours; with statuses, + adds one
  private renderLegend(): void {
    const legend = this.legendHost;
    legend.empty();
    for (const k of this.colorKey()) this.legendChip(legend, k.color, k.label, k.edit);
    if (this.colorBy !== "status") return;
    const add = legend.createEl("button", { cls: "ogantt-legend-chip ogantt-legend-add clickable-icon", attr: { "aria-label": tr().setAddStatus } });
    setIcon(add, "plus");
    add.onclick = () => this.openStatusEditor(add);
  }

  // 凡例のチップ。onClick があればボタン（キーボードでも開ける）/ a legend chip; a button when clickable, so the keyboard reaches it too
  private legendChip(parent: HTMLElement, color: string, label: string, onClick?: (chip: HTMLElement) => void): void {
    const chip = onClick ? parent.createEl("button", { cls: "ogantt-legend-chip" }) : parent.createDiv({ cls: "ogantt-legend-chip" });
    const sw = chip.createSpan({ cls: "ogantt-legend-swatch" });
    sw.style.background = color;
    chip.createSpan({ text: label });
    if (onClick) chip.onclick = () => onClick(chip);
  }

  // ボードの担当者（重複なし・表示名順。表示名が同じなら元の文字列順で、選ばれる表記がいつも同じになる）。描き直しごとに 1 回だけ作る
  // the board's assignees, deduplicated and sorted by display name (ties by the raw string, so the same spelling is always picked); built once per redraw
  private assigneeList(): string[] {
    const seen = new Set<string>();
    return (this.assigneeCache ??= [...new Set(this.tasks.flatMap((t) => t.assignees))]
      .map((a) => [linkLabel(a), a] as const)
      .sort(([la, a], [lb, b]) => la.localeCompare(lb) || (a < b ? -1 : a > b ? 1 : 0))
      .filter(([l]) => !seen.has(l) && !!seen.add(l)) // 同じ人（表示名）は 1 回 / one entry per person (display name)
      .map(([, a]) => a));
  }

  // ステータスの編集ポップオーバー（名前・色・グループ・削除）。st が無ければ新規作成（名前を入れた時点で追加）
  // the status editor popover (name, colour, group, delete); without `st` it drafts a new one, added once it has a name
  private openStatusEditor(anchor: HTMLElement, st?: StatusDef): void {
    const s = this.plugin.settings;
    const draft: StatusDef = st ?? { ...newStatus(s.statuses, ""), id: "" };
    const persist = () => void this.plugin.saveLook();
    // 名前が付くまでは下書きなので保存しない / a draft without a name isn't saved yet
    const save = () => { if (s.statuses.includes(draft)) persist(); };
    openPopover(anchor, "ogantt-statusmenu", (menu, close) => {
      const head = menu.createDiv({ cls: "ogantt-statusmenu-head" });
      const dot = head.createSpan({ cls: "ogantt-status-dot" });
      dot.style.background = draft.color;
      const name = head.createEl("input", { type: "text", attr: { placeholder: tr().setStatusLabel, "aria-label": tr().setStatusLabel } });
      name.value = draft.label;
      name.onkeydown = (e) => { if (e.key === "Enter" && !composing(e)) name.blur(); };
      name.onchange = () => {
        const v = name.value.trim();
        if (!v) { name.value = draft.label; return; }
        if (draft.id) this.plugin.renameStatusKeys(draft.label, v); // 名前で覚えている見出しの設定も / settings kept under the old name follow
        draft.label = v;
        if (!draft.id) {
          // 新規の id は名前から（既存と重ならないよう連番）/ a new id comes from the name, numbered to stay unique
          draft.id = newStatus(s.statuses, v).id;
          s.statuses.push(draft);
        }
        save();
      };
      paletteInto(menu, draft.color, (c) => {
        draft.color = c;
        dot.style.background = c;
        menu.querySelectorAll(".ogantt-swatch.is-active").forEach((el) => el.removeClass("is-active"));
        menu.querySelector(`.ogantt-swatch[aria-label="${c}"]`)?.addClass("is-active");
        save();
      });
      const foot = menu.createDiv({ cls: "ogantt-statusmenu-foot" });
      const group = foot.createEl("select", { cls: "dropdown", attr: { "aria-label": tr().setStatusGroup } });
      for (const g of STATUS_GROUPS) group.createEl("option", { value: g, text: statusGroupLabel(g) });
      group.value = draft.group;
      group.onchange = () => { draft.group = group.value as StatusGroup; save(); };
      if (st) {
        const del = foot.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().setDeleteTooltip } });
        setIcon(del, "trash-2");
        del.onclick = () => {
          close();
          new ConfirmModal(this.app, {
            title: tr().setStatusesHeading,
            // ステータスは Vault 全体で使われるので、このボードの外のノートも数える / statuses apply vault-wide, so notes outside this board count too
            body: tr().confirmDeleteStatus(st.label, this.app.vault.getMarkdownFiles().filter((f) => this.app.metadataCache.getFileCache(f)?.frontmatter?.[s.keys.status] === st.id).length),
            confirmText: tr().menuDelete,
            cancelText: tr().cancel,
            onConfirm: () => {
              const at = s.statuses.indexOf(st);
              if (at >= 0) s.statuses.splice(at, 1);
              renameAutoStatusId(this.plugin.settings.autoStatus, st.id, null);
              persist();
            },
          }).open();
        };
      }
      if (!st) window.setTimeout(() => name.focus(), 0);
    });
  }

  // タグ/フォルダの色（手動上書きがあればそれ、無ければ名前ハッシュで自動生成）/ tag/folder color (manual override, else auto from name)
  // 既定色は CSS 変数を読むので、描き直しごとにタグ単位で覚える（札ごとにスタイルを読まない）/ the default colour reads a CSS variable, so it's kept per tag per redraw
  private tagColor(tag: string): string {
    let c = this.tagColorCache.get(tag);
    if (c === undefined) this.tagColorCache.set(tag, (c = resolveTagColor(this.plugin.settings.tagColors, this.plugin.settings.defaultTagColor, tag)));
    return c;
  }
  private folderColor(name: string): string {
    return this.plugin.settings.folderColors.find((c) => c.name === name)?.color || hashColor(name);
  }
  // 担当者の色（表示名ごとの上書き > ボードの中で重ならない自動の色）。まだボードにいない人（追加した直後）は名前ハッシュ
  // an assignee's colour (override by display name > an automatic colour no one else on the board has); someone not on the board yet (just added) gets the name hash
  private assigneeColor(who: string): string {
    const name = linkLabel(who);
    const own = this.plugin.settings.assigneeColors;
    const picked = own.find((c) => c.name === name)?.color;
    if (picked) return picked;
    if (!this.peopleColors) {
      // 色を選んだ人は自動の色を使わず、選んだ色はほかの人に回さない / people with a picked colour take no automatic one, and picked colours aren't handed out
      const people = this.assigneeList().map(linkLabel);
      const mine = own.filter((c) => people.includes(c.name));
      this.peopleColors = distinctColors(people.filter((p) => !mine.some((c) => c.name === p)), mine.map((c) => c.color));
    }
    return this.peopleColors.get(name) || hashColor(name);
  }
  // タグチップに色を塗る（枠＋淡い背景＋文字色。テーブル列/詳細パネル共通）/ paint a tag chip (border + faint bg + text)
  private paintTagChip(chip: HTMLElement, tag: string): void {
    const c = this.tagColor(tag);
    chip.style.borderColor = c;
    chip.style.color = c;
    chip.style.background = `color-mix(in srgb, ${c} 14%, transparent)`;
  }

  // タグ/フォルダ/担当者の色の上書きを設定（color=null でリセット＝自動へ）/ set or clear a tag/folder/assignee color override (null = reset to auto)
  private setColorOverride(kind: "tag" | "folder" | "assignee", name: string, color: string | null): void {
    const s = this.plugin.settings;
    const arr = kind === "tag" ? s.tagColors : kind === "folder" ? s.folderColors : s.assigneeColors;
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
    void this.plugin.saveLook(); // 開いているボードと設定画面にも反映 / reflected on every open board and in an open settings tab
  }

  // 見出し・タグチップの右クリックメニュー。色（フォルダ・タグ・担当者・ステータス）はパレットで、アイコンは見出しだけ変えられる
  // the right-click menu of a heading or tag chip: colour (folders, tags, assignees, statuses) from the palette, and the icon (headings only)
  // heading は見出しのアイコンのキー（見出しのときだけ。フォルダはパス、それ以外は名前）/ `heading` is a heading's icon key (headings only: a folder's path, else the name)
  private openStyleMenu(e: MouseEvent, axis: GroupBy, name: string, heading?: string): void {
    e.preventDefault();
    e.stopPropagation();
    const anchor = e.currentTarget as HTMLElement; // メニューを選ぶ頃には currentTarget が消えるので先に控える / gone by the time an item is picked
    const s = this.plugin.settings;
    const status = axis === "status" ? s.statuses.find((x) => x.label === name) : undefined;
    const m = new Menu();
    if (axis !== "status" || status) {
      m.addItem((i) => i.setTitle(tr().menuChangeColor).setIcon("palette").onClick(() =>
        pickColor(anchor, this.groupColor(axis, name) ?? "", (c) => {
          if (axis !== "status") return this.setColorOverride(axis, name, c);
          status!.color = c;
          void this.plugin.saveLook();
        })
      ));
      // タグは既定色へ、フォルダ・担当者は名前から自動生成へ戻る。行き先が違うのでラベルも分ける（ステータスは設定の色そのもの）
      // tags fall back to the default colour, folders and assignees to their name-derived one, so the labels differ (a status colour has no fallback)
      if (axis !== "status") {
        const reset = axis === "tag" ? tr().menuResetTagColor : tr().menuResetColor;
        m.addItem((i) => i.setTitle(reset).setIcon("rotate-ccw").onClick(() => this.setColorOverride(axis, name, null)));
      }
    }
    if (heading != null) {
      const key = `${axis}:${heading}`;
      // 以前のフォルダ名のキーから来たアイコンは、ほかのフォルダのものでもあるので消さず、このフォルダだけ「なし」（空）にする
      // an icon that comes from the older folder-name key is shared with other folders, so it isn't deleted: this folder alone is set to none (empty)
      const legacy = this.legacyIcon(heading, name) != null;
      const setGroupIcon = (icon: string | null) => {
        if (icon) s.icons[key] = icon;
        else if (legacy) s.icons[key] = "";
        else delete s.icons[key];
        void this.plugin.saveLook();
      };
      m.addItem((i) => i.setTitle(tr().menuChangeIcon).setIcon("shapes").onClick(() => pickIcon(anchor, setGroupIcon)));
      if (s.icons[key] || legacy) m.addItem((i) => i.setTitle(tr().menuResetIcon).setIcon("rotate-ccw").onClick(() => setGroupIcon(null)));
    }
    m.showAtMouseEvent(e);
  }

  // 見出しの色（(なし) は色なし）/ a heading's colour (none for the "(none)" group)
  private groupColor(axis: GroupBy, name: string): string | undefined {
    if (axis !== "folder" && name === tr().noneLabel) return undefined;
    if (axis === "folder") return this.folderColor(name);
    if (axis === "tag") return this.tagColor(name);
    if (axis === "status") return this.plugin.settings.statuses.find((x) => x.label === name)?.color;
    const raw = this.assigneeList().find((a) => linkLabel(a) === name);
    return raw ? this.assigneeColor(raw) : undefined;
  }

  // 見出しのアイコンのキー。フォルダは名前でなく Vault のパス（A/Design と B/Design を分け、どのボードから見ても同じ）
  // a heading's icon key: for a folder its vault path rather than its name (A/Design and B/Design differ, and every board agrees)
  private headingKey(row: Row): string {
    if (this.groupBy !== "folder" || row.key == null) return row.group;
    return this.folder ? `${this.folder}/${row.key}` : row.key;
  }

  // 見出しのアイコン（ユーザーの指定 > 軸ごとの既定）。フォルダは以前の名前のキーも読む / a heading's icon (the user's pick > the axis default); folders also read the older name key
  private groupIcon(key: string, name: string, collapsed: boolean): string {
    const icons = this.plugin.settings.icons;
    const custom = icons[`${this.groupBy}:${key}`] ?? (this.groupBy === "folder" ? this.legacyIcon(key, name) : undefined);
    if (custom) return custom;
    if (this.groupBy === "folder") return collapsed ? "folder" : "folder-open";
    return this.groupBy === "tag" ? "tag" : this.groupBy === "assignee" ? "user" : "circle-dot";
  }

  // 以前のフォルダ名のキー（"folder:<名前>"）のアイコン。入れ子のフォルダで、自分のキーが無く、同じ名前のフォルダが Vault の直下に無いときだけ
  // （直下にあれば、そのキーはそのフォルダのパスのキー）/ the icon under the older folder-name key ("folder:<name>"); only for a nested folder with no
  // key of its own, and only when no top-level folder has that name (if one does, the key is that folder's path key)
  private legacyIcon(path: string, name: string): string | undefined {
    const icons = this.plugin.settings.icons;
    if (path === name || `folder:${path}` in icons || this.app.vault.getAbstractFileByPath(name) instanceof TFolder) return undefined;
    return icons[`folder:${name}`];
  }

  // フィルタ→グループ再マッピングを適用したタスク列を返す（判定本体は filter.ts）/ tasks after filter + group remap (logic lives in filter.ts)
  private processTasks(): Task[] {
    const { filters, filterMatch, statuses } = this.plugin.settings;
    // today は 1 回だけ評価して共有 / evaluate `today` once and share it
    const list = applyFilters(this.tasks, filters, filterMatch, statuses, this.today());
    return regroup(list, this.groupBy, this.flat, statuses, tr().noneLabel);
  }

  // 今日の線が中央に来るよう横スクロール / scroll horizontally so the today marker is centered
  private scrollToToday(): void {
    // 今日が表示範囲の外なら、範囲をのばしてから（Fit はのばさない）/ when today is outside the shown range, grow it first (not in Fit)
    const today = this.today();
    if (this.zoom !== "Fit" && this.boardMain && (today < this.range.min || today > this.range.max)) {
      this.pad = padToCover(this.baseRange, this.pad, today, this.zoom);
      this.rerender();
    }
    const main = this.boardMain;
    const todayLine = main?.querySelector<SVGElement>(".ogantt-today");
    if (!main || !todayLine) return; // 今日が範囲外＝線が無い / no marker when today is out of range
    const mb = main.getBoundingClientRect();
    const tb = todayLine.getBoundingClientRect();
    main.scrollLeft += tb.left - mb.left - (main.clientWidth + this.tableWidth()) / 2;
  }

  // ----- 取り消し・やり直し（Undo / Redo）-----
  // 書き込みはすべてここを通す：対象ファイルだけ操作前の内容を控え、fn を実行して履歴に積む。
  // fn が false を返したら「変化なし」として履歴に残さない。作成したファイルは created で知らせる（Undo でゴミ箱へ）
  // every write goes through here: snapshot only the affected files, run fn, record the entry.
  // fn returns false for "nothing changed" (not recorded); report new files via `created` (trashed on undo)
  private async mutate(label: string, paths: string[], fn: () => Promise<MutateResult>): Promise<boolean> {
    return this.busy(new Set(paths).size, async () => {
      this.historyBusy++;
      let res: MutateResult = false;
      let files = new Map<string, string | null>();
      try {
        files = await this.snapshot(paths);
        res = await fn();
      } catch (e) {
        // 途中で失敗しても書けた分は残るので、変わったファイルがあれば記録して取り消せるようにする
        // a failure part-way leaves what was written, so record whatever changed and let undo put it back
        console.error(e);
        new Notice(tr().writeFailed);
        res = true;
      } finally {
        this.historyBusy--;
      }
      if (res === false) return false;
      const r = typeof res === "object" ? res : {};
      for (const p of r.created ?? []) files.set(p, null);
      // 操作後の内容。移動が無く何も変わっていなければ記録しない（本文の #tag だけのタグ削除など）。取り消すときはこの内容のままかを確かめる
      // the contents after the op: with no move and nothing changed it isn't recorded (e.g. removing an inline-only #tag); undo checks they're still these
      // 移動したファイルは移動先から読み、元のパスのキーで持つ（取り消すときは移動を戻してから元のパスで確かめる）
      // a moved file is read at its new path and kept under its old one (undo puts the moves back first, then checks the old paths)
      const at = (p: string) => (r.moves ?? []).reduce((q, m) => (q === m.from || q.startsWith(m.from + "/") ? m.to + q.slice(m.from.length) : q), p);
      const moved = await this.snapshot([...files.keys()].map(at));
      const post = new Map([...files.keys()].map((p) => [p, moved.get(at(p)) ?? null]));
      if (!r.moves?.length && !r.statuses?.length && [...files].every(([p, c]) => post.get(p) === c)) return false;
      this.record({ label, files, expect: post, moves: r.moves ?? [], created: r.created ?? [], deleted: r.deleted ?? [], statuses: r.statuses });
      return true;
    });
  }

  // 多くのファイルに触る操作のあいだ「処理中」の通知を出す / show a "working" notice while an operation touches many files
  private async busy<T>(files: number, fn: () => Promise<T>): Promise<T> {
    const notice = files > BUSY_FILES ? new Notice(tr().workingOn(files), 0) : null;
    try {
      return await fn();
    } finally {
      notice?.hide();
    }
  }

  // 新しい操作を履歴へ（やり直し履歴は無効になる）/ record a new op (invalidates redo)
  private record(entry: HistoryEntry): void {
    this.dropUndoToast();
    this.pushHistory(this.undoStack, entry);
    this.redoStack = [];
    this.updateUndoButton();
  }

  // 指定パスの現在内容（無ければ null）/ current contents of the given paths (null when missing)
  private async snapshot(paths: Iterable<string>): Promise<Map<string, string | null>> {
    const unique = [...new Set(paths)];
    // 別々のファイルなので並行に読む / different files, so they're read in parallel
    const contents = await Promise.all(unique.map((p) => {
      const f = this.app.vault.getAbstractFileByPath(p);
      return f instanceof TFile ? this.app.vault.read(f) : null;
    }));
    return new Map(unique.map((p, i) => [p, contents[i]]));
  }

  // スナップショットを書き戻す。null はゴミ箱へ。無いファイルは recreatable に含まれるときだけ作り直し、
  // それ以外（外部で消された等）は触らない
  // write a snapshot back: null trashes the file; a missing file is re-created only when it is in
  // `recreatable`, otherwise (e.g. deleted outside the board) it is left alone
  private async restore(files: Map<string, string | null>, recreatable: string[], current: Map<string, string | null>): Promise<void> {
    // 別々のファイルなので並行に書き戻す。作り直しだけは後で 1 件ずつ（同じフォルダを二重に作らないように）
    // different files, so they're written back in parallel; re-creations go afterwards one by one (so a folder is never created twice)
    const recreate: [string, string][] = [];
    await Promise.all([...files].map(async ([path, content]) => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (content === null) {
        if (!(f instanceof TFile)) return;
        await this.app.fileManager.trashFile(f);
        if (this.selectedPath === path) this.closeDetail();
      } else if (f instanceof TFile) {
        if (current.get(path) !== content) await this.app.vault.modify(f, content);
      } else if (!f && recreatable.includes(path)) recreate.push([path, content]);
    }));
    for (const [path, content] of recreate) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      await this.app.vault.create(path, content);
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
  // 取り消しボタン付きの通知を閉じる（その後に別の操作や取り消しがあると、ボタンが別のものを取り消してしまうため）
  // close the notice with the Undo button (after another change or an undo, its button would undo something else)
  private dropUndoToast(): void {
    this.undoToast?.hide();
    this.undoToast = null;
  }

  // 取り消し・やり直しの共通部。一度に 1 つだけ（連打や長押しで重なると履歴が混ざる）。あるはずの内容と違うファイルがあれば
  // 外で書き換えられたので上書きせず、「それでも取り消す」ボタン付きの通知で知らせる（force で確認を飛ばす）
  // shared by undo and redo. One at a time (overlapping runs from fast presses mix up the history). When a file no longer holds what it
  // should, it was changed outside, so nothing is overwritten and a notice offers to go ahead anyway (`force` skips the check).
  // そのときも履歴は元の場所に残す（次の取り消しが古い操作を先に戻さないように）/ the entry then stays where it was, so the next undo can't skip past it
  private async replay(redo: boolean, force = false): Promise<void> {
    if (this.historyRunning) return;
    this.dropUndoToast();
    const stack = redo ? this.redoStack : this.undoStack;
    const entry = stack.pop();
    if (!entry) {
      new Notice(redo ? tr().nothingToRedo : tr().nothingToUndo);
      return;
    }
    this.historyRunning = true;
    this.historyBusy++;
    let conflict = false;
    try {
      await this.busy(entry.files.size + (entry.statuses?.length ?? 0), async () => {
        if (entry.statuses || entry.disable) {
          if (entry.statuses) await this.replayStatuses(entry.statuses, redo);
          if (entry.disable) this.setDisabled(entry.disable.paths, redo === entry.disable.on);
          this.pushHistory(redo ? this.undoStack : this.redoStack, entry);
          return;
        }
        if (!redo) await this.replayMoves(entry.moves.map((m) => ({ from: m.to, to: m.from })).reverse());
        const now = await this.snapshot(entry.files.keys());
        conflict = !force && [...(entry.expect ?? [])].some(([p, c]) => now.get(p) !== c);
        if (conflict) {
          if (!redo) await this.replayMoves(entry.moves); // 移動を元に戻す / put the moves back
          stack.push(entry);
          return;
        }
        // 取り消しは削除だけ、やり直しは作成だけを作り直す / undo re-creates only what was deleted, redo only what was created
        await this.restore(entry.files, redo ? entry.created : entry.deleted, now);
        if (redo) await this.replayMoves(entry.moves);
        this.pushHistory(redo ? this.undoStack : this.redoStack, { ...entry, files: now, expect: entry.expect && entry.files });
      });
    } finally {
      this.historyBusy--;
      this.historyRunning = false;
    }
    if (conflict) {
      this.undoToast = this.buttonNotice(tr().changedSince(entry.label), redo ? tr().redoAnyway : tr().undoAnyway, () => void this.replay(redo, true), 10000);
    } else new Notice(redo ? tr().redone(entry.label) : tr().undone(entry.label));
    await this.refresh();
    if (this.selectedPath && this.detailEl.hasClass("is-open") && this.tasks.some((x) => x.path === this.selectedPath)) await this.openDetail(this.selectedPath);
    this.updateUndoButton();
  }

  private undo(): Promise<void> {
    return this.replay(false);
  }

  // 取り消した操作をやり直す（操作後の内容を書き戻し→移動を再生）/ redo an undone op (restore post-op contents → replay moves)
  private redo(): Promise<void> {
    return this.replay(true);
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
      const res = await renameTask(this.app, from, newName);
      if (res === "taken") new Notice(tr().nameTaken(newName.trim())); // 同名のタスクがある / a task of that name exists
      np = res === "taken" ? null : res;
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

  // 詳細パネルを閉じて選択を外す。returnFocus なら元の行へフォーカスを戻す / close the detail panel and clear the selection; returnFocus puts focus back on the row
  private closeDetail(returnFocus = false): void {
    this.selectedPath = null;
    this.detailEl?.removeClass("is-open");
    if (this.bodyOwner) this.removeChild(this.bodyOwner);
    this.bodyOwner = null;
    this.tbodyEl?.querySelectorAll(".ogantt-tr.is-selected").forEach((el) => el.removeClass("is-selected"));
    if (returnFocus) this.focusRow(this.cursor);
  }

  // 取り消し・やり直しボタンの有効/無効を更新 / enable or disable the undo and redo buttons
  private updateUndoButton(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
    if (this.redoBtn) this.redoBtn.disabled = this.redoStack.length === 0;
  }

  // ----- 表＋タイムラインを 1 つの CSS グリッドで（sticky で行を揃える）。行は見えている範囲だけ DOM にする -----
  // ----- table + timeline in one CSS grid; sticky heads/left column keep rows aligned. Only rows near the viewport become DOM -----
  private renderGrid(main: HTMLElement): void {
    const totalDays = this.range.max - this.range.min + 1;
    const width = totalDays * this.ppd;
    const bodyH = this.rows.length * ROW_H;
    const cols = this.visibleColumns();
    // 列幅は描画ごとに 1 回だけ求める（セルごとに引くと行数×列数ぶん定義を探し直す）/ column widths, worked out once per render
    const colWidth = new Map(cols.map((c) => [c.id, this.colW(c.id)]));
    const grid = main.createDiv({ cls: "ogantt-grid" });
    grid.style.gridTemplateColumns = `${this.tableWidth()}px ${width}px`;
    grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;
    const tickZoom = this.tickZoom();
    this.fontFamily = getComputedStyle(this.contentEl).fontFamily; // タグの札の位置を測る / for placing the tag pills
    this.renderHeader(grid, cols, colWidth, width);
    this.renderAxis(grid, tickZoom, width);

    const body = grid.createDiv({ cls: "ogantt-tbody", attr: { role: "tree", tabindex: "-1" } });
    this.tbodyEl = body;
    body.addEventListener("keydown", (e) => this.onRowKey(e));
    // フォーカスを受けた行（シェブロン・ドラッグ・クリック経由でも）をキーボードの行にする / the row that takes focus (via a chevron, a drag or a click) becomes the keyboard's row
    body.addEventListener("focusin", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ogantt-tr");
      if (row) this.cursor = Number(row.dataset.index);
    });

    const svgWrap = grid.createDiv({ cls: "ogantt-svgwrap" });
    // 行の区切り線と休日の網掛けは背景で描く（行ごと・日ごとに要素を作らない）/ row lines and non-working days are a background, not elements
    const offDays = tickZoom === "Month" ? "" : offDayGradient(this.range.min, scheduleOptions(this.plugin.settings).cal, this.ppd, "var(--ogantt-offday)");
    const rowLines = `repeating-linear-gradient(to bottom, transparent 0 ${ROW_H - 1}px, var(--background-modifier-border-hover) ${ROW_H - 1}px ${ROW_H}px)`;
    svgWrap.style.backgroundImage = [offDays, rowLines].filter((x) => x && x !== "none").join(", ");
    const svg = svgWrap.createSvg("svg", { cls: "ogantt-svg" });
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(bodyH));
    const layer = (cls: string) => svg.appendChild(this.svgEl("g", { class: cls }));
    const bgLayer = layer("ogantt-bg-layer");
    this.drawToday(svg, width, bodyH);
    const copyLayer = layer("ogantt-copy-layer");
    // 依存の矢印はバーの下：重なったところではバーがクリックとホバーを受ける（矢印の先はバーの端の外なので隠れない）
    // dependency arrows sit below the bars, so a bar gets the click and hover where they overlap (arrowheads stop outside the bar's edge, so they stay visible)
    const depLayer = layer("ogantt-dep-layer");
    const barLayer = layer("ogantt-bar-layer");
    // 稲妻線はバーの上（隠れると意味がない）/ the progress line goes above the bars (hidden, it would be useless)
    if (this.progressLine) this.drawProgressLine(svg, width, bodyH);
    // 依存作成ハンドルは最前面のレイヤーに 2 つだけ置き、全バーで共有する。矢印を隠しているときは矢印もハンドルも描かない
    // two connector handles in the topmost layer, shared by every bar; with arrows hidden, neither arrows nor handles are drawn
    const handles = this.showDeps ? this.makeHandles(svg, layer("ogantt-handles-layer")) : null;
    const depX = this.showDeps ? this.makeDepX(layer("ogantt-depx-layer")) : null;
    const fill = this.barFill(svg);
    const deps = this.showDeps ? this.depRows() : [];
    // 矢印を隠しても、依存が守られていない後続はバーの赤い縁で分かる。先行が畳まれていたり絞り込まれていたりしても同じ
    // with arrows hidden, a successor whose dependency is broken still gets a red outline, even when its predecessor is collapsed or filtered out
    this.late = this.showDeps ? null : this.lateTasks();

    // 行かバーにマウスを載せると、同じタスクの行・バー・複製（担当者やタグごとの重複表示）をまとめて強調する
    // hovering a row or bar highlights every row, bar and copy of that task (copies come from grouping by assignee or tag)
    let hl: string | null = null;
    const highlight = (path: string | null) => {
      if (path === hl) return;
      grid.querySelectorAll(".is-hl").forEach((el) => el.removeClass("is-hl"));
      hl = path;
      if (path) grid.querySelectorAll(`[data-path="${CSS.escape(path)}"]`).forEach((el) => el.addClass("is-hl"));
    };
    grid.addEventListener("mouseover", (e) => highlight((e.target as Element).closest("[data-path]")?.getAttribute("data-path") ?? null));
    grid.addEventListener("mouseleave", () => highlight(null));

    // 見えている行（＋前後の余白）だけを描き、スクロールでその範囲を出たら描き直す
    // draw only the rows in view (plus a margin); repaint once scrolling leaves that range
    let win = { first: -1, last: -1 };
    this.paintWindow = (force = false) => {
      const first = Math.floor(main.scrollTop / ROW_H);
      const last = Math.min(this.rows.length - 1, Math.ceil((main.scrollTop + main.clientHeight) / ROW_H));
      if (!force && first >= win.first && last <= win.last) return;
      // バーを掴んでいる間とセルを編集している間は描き直さない（掴んだバーや入力欄が消えて、ドラッグや入力が途切れる）
      // no repaint while a bar is held or a cell is being edited (removing the bar or the input would cut the drag or the typing short)
      const ae = activeDocument.activeElement;
      if (!force && (this.dragging === "bar" || (ae && body.contains(ae) && ae.matches("input, select, textarea")))) return;
      win = { first: Math.max(0, first - WINDOW_PAD), last: Math.min(this.rows.length - 1, last + WINDOW_PAD) };
      const hadFocus = body.contains(activeDocument.activeElement); // 描き直しで行が消えてもキーボードの位置は保つ / keep keyboard focus through the repaint
      this.hideCard();
      body.empty();
      bgLayer.empty();
      copyLayer.empty();
      barLayer.empty();
      depLayer.empty();
      this.drawCopyLinks(copyLayer, win.first, win.last);
      for (let i = win.first; i <= win.last; i++) {
        const row = this.rows[i];
        this.renderRow(body, row, i, cols, colWidth);
        if (row.kind === "group") this.drawGroupRow(bgLayer, barLayer, row, i, width);
        else this.drawBar(barLayer, svg, row, i, fill, handles);
      }
      for (const dep of deps) if (Math.max(dep.si, dep.pi) >= win.first && Math.min(dep.si, dep.pi) <= win.last) this.drawDep(depLayer, dep, depX);
      // キーボードの行が描かれていなければ、描いた先頭の行を Tab で入れる行にする / when the keyboard's row isn't drawn, the first drawn row takes Tab
      if (this.cursor < win.first || this.cursor > win.last) {
        body.querySelector(`.ogantt-tr[data-index="${Math.min(first, win.last)}"]`)?.setAttribute("tabindex", "0");
        if (hadFocus) body.focus({ preventScroll: true }); // 行は消えたがキーボードは表に残る / the row is gone but the keyboard stays in the table
      } else if (hadFocus) body.querySelector<HTMLElement>(`.ogantt-tr[data-index="${this.cursor}"]`)?.focus({ preventScroll: true });
      highlight(null);
    };
    // スクロールの受け手は枠ごとに 1 回だけ（のばすときは同じ枠を使い続ける）/ one scroll listener per scroll box (a grow keeps the box)
    if (main.dataset.scroll) return;
    main.dataset.scroll = "1";
    let ticking = false;
    let left = main.scrollLeft;
    main.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      main.win.requestAnimationFrame(() => { // ビューの窓の（ポップアウトでも止まらない）/ the view's own window (keeps running in a popout)
        ticking = false;
        if (main.clientHeight) this.scrollMemo = this.scrollOf(main);
        this.paintWindow?.();
        // 縦だけのスクロールでは端を見ない / a vertical-only scroll doesn't check the edges
        if (main.scrollLeft === left) return;
        left = main.scrollLeft;
        this.growNearEdge();
      });
    });
  }

  // 横スクロールが端から画面 1 つ分以内に来たら、その側に日を足す（左に足したら同じ日付を見せたまま）。Fit・ドラッグ中・セルの編集中・書き出し中はしない
  // when the horizontal scroll comes within one screen of an edge, add days on that side (keeping the same dates in view when adding on the left);
  // not in Fit, during a drag, while a cell is being edited, or during an export
  private growNearEdge(): void {
    const main = this.boardMain;
    if (!main?.clientWidth || this.zoom === "Fit" || this.dragging || this.exporting || this.extending) return;
    const ae = activeDocument.activeElement;
    if (ae && this.tbodyEl?.contains(ae) && ae.matches("input, select, textarea")) return;
    const margin = main.clientWidth;
    const side = nearEdge(main.scrollLeft, main.clientWidth, main.scrollWidth, margin);
    if (!side) return;
    // 1 回で端の帯から出るだけ足す（何度も描き直さない）/ add enough in one go to leave the edge zone (no chain of redraws)
    const gap = side === "before" ? main.scrollLeft : main.scrollWidth - main.scrollLeft - main.clientWidth;
    const next = growPad(this.pad, side, this.zoom, Math.ceil((margin - gap) / this.ppd) + 1);
    if (!next) return;
    this.pad = next;
    this.extending = true;
    try {
      this.rerender(); // 中央の日付を保って描き直すので、左に足しても見ている日はずれない / the redraw keeps the centre date, so adding on the left doesn't move the view
    } finally {
      this.extending = false;
    }
  }

  // 表ヘッダー（表示中の列・クリックか Enter でソート・右端グリップで幅）/ the table header: visible columns, sort by click or Enter, width grip
  private renderHeader(grid: HTMLElement, cols: ColumnDef[], colWidth: Map<string, number>, width: number): void {
    const corner = grid.createDiv({ cls: "ogantt-corner" });
    const s = this.plugin.settings;
    for (const col of cols) {
      const id = col.id;
      const sorted = s.sortBy === id;
      const th = corner.createDiv({
        cls: "ogantt-th ogantt-th-sortable" + (id === "name" ? " ogantt-th-name" : ""),
        attr: { role: "button", tabindex: "0", "data-col": id },
      });
      if (id !== "name") th.style.width = `${colWidth.get(id)}px`;
      th.createSpan({ text: col.label() });
      // アクティブなソート列に ↑/↓ を表示 / show ↑/↓ on the active sort column
      if (sorted) th.createSpan({ cls: "ogantt-sort-arrow", text: s.sortDir === "asc" ? "↑" : "↓" });
      th.onclick = () => this.toggleSort(id);
      th.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.toggleSort(id, true); } };
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
          this.autoFitColumn(id, th);
          return;
        }
        lastDown = e.timeStamp;
        grip.setPointerCapture(e.pointerId);
        this.dragging = "column";
        grip.addEventListener("lostpointercapture", () => { if (this.dragging === "column") this.dragging = null; }, { once: true });
        const startX = e.clientX;
        const startW = this.colW(id);
        let moved = false;
        const onMove = (ev: PointerEvent) => {
          moved = true;
          const w = Math.max(40, Math.round(startW + ev.clientX - startX));
          s.columnWidths[id] = w;
          // ドラッグ中は再描画せず幅だけ反映 / live-apply widths without a full re-render
          grid.style.gridTemplateColumns = `${this.tableWidth()}px ${width}px`;
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
          if (moved) void this.plugin.saveLook();
        };
        grip.addEventListener("pointermove", onMove);
        grip.addEventListener("pointerup", onUp, { once: true });
      });
    }
  }

  // 目盛りの粒度（Fit は算出した ppd から選ぶ）/ the tick granularity (Fit picks it from the computed ppd)
  private tickZoom(): ZoomMode {
    return this.zoom !== "Fit" ? this.zoom : this.ppd >= 24 ? "Day" : this.ppd >= 10 ? "Week" : "Month";
  }

  // 日付軸の目盛りと、その上の月（Month では年）の帯。表示言語の書式 / the axis ticks and the month (year in Month zoom) bands above, in the UI language's format
  private axisMarks(zoom: ZoomMode): { ticks: Tick[]; bands: Tick[] } {
    const fmt = dateFormat;
    const md = fmt({ month: "short", day: "numeric" });
    const mo = fmt({ month: "short" });
    const wk = moment.weekdaysMin(); // 表示言語の曜日（日曜始まり）/ the UI language's weekdays (Sunday first)
    const label = (d: Date, z: ZoomMode) => (z === "Day" ? `${d.getUTCDate()} ${wk[d.getUTCDay()]}` : z === "Week" ? md.format(d) : mo.format(d));
    const band = zoom === "Month" ? fmt({ year: "numeric" }) : fmt({ year: "numeric", month: "long" });
    return { ticks: buildTicks(this.range, zoom, this.ppd, label), bands: buildBands(this.range, zoom, this.ppd, (d) => band.format(d)) };
  }

  // 日付軸 / the date axis
  private renderAxis(grid: HTMLElement, zoom: ZoomMode, width: number): void {
    const axis = grid.createDiv({ cls: "ogantt-axis" });
    const { ticks, bands } = this.axisMarks(zoom);
    for (const tick of ticks) {
      const t = axis.createDiv({ cls: "ogantt-tick" + (tick.major ? " is-major" : "") });
      t.style.left = `${tick.x}px`;
      t.setText(tick.label);
    }
    // 帯は月（Month では年）の幅いっぱいの箱。名前は時間軸の左端に貼り付き、スクロールしても今見ている月・年が分かる
    // each band is a box as wide as its month (a year in Month zoom); its name sticks to the timeline's left edge, so the month or year in view stays named
    const tw = this.tableWidth();
    bands.forEach((b, k) => {
      const box = axis.createDiv({ cls: "ogantt-band" });
      box.style.left = `${b.x}px`;
      box.style.width = `${(bands[k + 1]?.x ?? width) - b.x}px`;
      box.createSpan({ text: b.label }).style.left = `${tw}px`;
    });
  }

  // 表の 1 行（グループ見出しかタスク）。見えている範囲だけ作るので、行番号から絶対位置に置く
  // one table row (a group heading or a task); only rows in view are built, so each is placed absolutely by its index
  private renderRow(body: HTMLElement, row: Row, i: number, cols: ColumnDef[], colWidth: Map<string, number>): void {
    const el = body.createDiv({ cls: "ogantt-tr", attr: { role: "treeitem", "aria-level": String(row.depth + 1), "data-index": String(i), tabindex: i === this.cursor ? "0" : "-1" } });
    el.style.top = `${i * ROW_H}px`;
    el.style.height = `${ROW_H}px`;
    const indent = this.indentOf(row);
    if (row.kind === "group") {
      el.addClass("is-group");
      const isCollapsed = this.isCollapsed(row.key);
      el.setAttr("aria-expanded", String(!isCollapsed));
      const g = el.createDiv({ cls: "ogantt-td-group" });
      g.style.paddingLeft = `${indent}px`;
      setIcon(g.createSpan({ cls: "ogantt-chevron", attr: { "aria-hidden": "true" } }), isCollapsed ? "chevron-right" : "chevron-down");
      const ic = g.createSpan({ cls: "ogantt-folder-icon", attr: { "aria-hidden": "true" } });
      // 軸ごとのアイコン（フォルダ・タグ・人・ステータス）か、ユーザーが選んだアイコン。色は見出しの色（(なし) は既定色のまま）
      // the axis icon (folder, tag, person, status) or the user's pick, tinted with the heading's colour ("(none)" stays plain)
      const none = this.groupBy !== "folder" && row.group === tr().noneLabel;
      setIcon(ic, none ? "circle-dashed" : this.groupIcon(this.headingKey(row), row.group, isCollapsed));
      const color = this.groupColor(this.groupBy, row.group);
      if (color) ic.style.color = color;
      g.createSpan({ text: row.group });
      // 見出しを右クリック＝色・アイコンを変更（(なし) は除く）/ right-click a heading to change its colour or icon (not "(none)")
      if (!none) g.addEventListener("contextmenu", (e) => this.openStyleMenu(e, this.groupBy, row.group, this.headingKey(row)));
      el.onclick = () => {
        this.focusRow(i);
        this.toggleCollapse(row.key);
      };
      // フォルダグループへドロップ＝親を解除してそのフォルダのトップレベルへ / drop onto a folder = detach + move to its top level
      if (this.groupBy === "folder" && row.key != null) {
        const dest = this.folder ? `${this.folder}/${row.key}` : row.key;
        this.makeDropTarget(el, tr().dropMove(row.group), (src) => void this.reparentTo(src, dest, null));
      }
      // タグ・担当者のグループへドロップ＝そのタグ・担当者を足す（(なし) は対象外）/ drop onto a tag or assignee group = add it (not "(none)")
      if ((this.groupBy === "tag" || this.groupBy === "assignee") && !none) {
        const field = this.groupBy === "tag" ? "tags" : "assignees";
        const value = field === "tags" ? row.group : this.assigneeList().find((a) => linkLabel(a) === row.group) ?? row.group;
        this.makeDropTarget(el, field === "tags" ? tr().dropTag(value) : tr().dropAssign(row.group), (src) => void this.editList(src, field, value, true));
      }
      return;
    }
    const t = row.task!;
    el.setAttr("data-path", t.path);
    if (row.hasChildren && row.key != null) el.setAttr("aria-expanded", String(!this.isCollapsed(row.key)));
    if (t.path === this.selectedPath) el.addClass("is-selected");
    if (this.disabled.has(t.path)) el.addClass("is-disabled");
    // 表示中の列を順に描画 / render each visible column
    for (const col of cols) {
      if (col.kind !== "name") {
        const td = el.createDiv({ cls: "ogantt-td" });
        td.style.width = `${colWidth.get(col.id)}px`;
        this.renderCell(td, row, col);
        continue;
      }
      const nameTd = el.createDiv({ cls: "ogantt-td ogantt-td-name" });
      nameTd.style.paddingLeft = `${indent}px`;
      // シェブロン枠は常に確保＝親でも単独タスクでも名前位置を揃える。親はボタンで開閉 / always reserve the chevron slot; for a parent it's the toggle button
      if (row.hasChildren && row.key != null) {
        const key = row.key;
        const open = !this.isCollapsed(key);
        const chev = nameTd.createEl("button", { cls: "ogantt-task-chevron is-clickable", attr: { "aria-label": open ? tr().collapse : tr().expand, "aria-expanded": String(open), tabindex: "-1" } });
        setIcon(chev, open ? "chevron-down" : "chevron-right");
        chev.addEventListener("click", (e) => {
          e.stopPropagation(); // 行クリック（詳細を開く）を抑止 / don't open the detail panel
          this.toggleCollapse(key);
        });
      } else nameTd.createSpan({ cls: "ogantt-task-chevron" });
      const nameText = nameTd.createSpan({ cls: "ogantt-name-text", text: t.name });
      // 種類（カンバン・キャンバス）と共有（担当者が複数）の印は名前の後ろに置き、名前の左端を揃えたままにする
      // markers for the kind (kanban, canvas) and for shared tasks (2+ assignees) trail the name, so names stay left-aligned
      if (t.kind !== "note") setIcon(nameTd.createSpan({ cls: "ogantt-name-icon", attr: { "aria-label": t.kind === "kanban" ? tr().kindKanban : tr().kindCanvas } }), KIND_ICON[t.kind]);
      if (t.assignees.length > 1) setIcon(nameTd.createSpan({ cls: "ogantt-name-icon", attr: { "aria-label": t.assignees.map(linkLabel).join(", ") } }), "users");
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
        this.renameInCell(nameText, t, el);
      });
      // 入力欄のクリックで詳細を開き直さない / clicks inside the input don't re-open the panel
      nameText.addEventListener("click", (e) => {
        if (nameText.querySelector("input")) e.stopPropagation();
      });
      // 名前を右クリック（タッチは長押し）＝行のメニュー / right-click the name (long-press on touch) for the row menu
      nameTd.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openRowMenu(t, e);
      });
    }
    el.onclick = () => {
      this.focusRow(i);
      void this.openDetail(t.path);
    };
    if (this.groupBy === "folder") {
      this.makeDraggableTask(el, t.path);
      // タスク行へドロップ＝そのタスクのサブタスクにする（親フォルダへ同居）/ drop onto a task = make it that task's subtask
      this.makeDropTarget(el, tr().dropSubtask(t.name), (src) => void this.reparentTo(src, this.taskFolder(t.path), t.path));
    } else if (this.groupBy === "tag" || this.groupBy === "assignee") {
      // タグ・担当者の表示ではグループへドラッグして足す（タスクへのドロップ＝サブタスク化はしない）
      // when grouping by tag or assignee, drag onto a group to add it (no subtask drop)
      this.makeDraggableTask(el, t.path);
    }
  }

  // 入れ子インデント（上限あり）。画面と書き出しで同じ / the nesting indent (capped), the same on screen and in the export
  private indentOf(row: Row): number {
    return 8 + Math.min(row.depth, MAX_INDENT_DEPTH) * 16;
  }

  // 折りたたみの切り替え（表示だけの変更。ボードごとに覚える）/ toggle a group or parent (display only; remembered per board)
  private toggleCollapse(key?: string): void {
    if (key == null) return;
    const k = `${this.groupBy}:${key}`;
    if (this.collapsed.has(k)) this.collapsed.delete(k);
    else this.collapsed.add(k);
    this.saveBoard();
    this.rerender();
  }

  // 今のグループ化の軸で畳んでいるか / whether a row is collapsed under the current grouping
  private isCollapsed(key?: string): boolean {
    return key != null && this.collapsed.has(`${this.groupBy}:${key}`);
  }

  // 表の行をキーボードで：↑↓ Home End PageUp PageDown で移動、→← で開閉、Enter/Space で開く・開閉、
  // Shift+F10 かメニューキーで行のメニュー（F2 と Esc はビューのキーとして onF2 / onEscape で扱う）
  // keyboard on table rows: ↑↓ Home End PageUp PageDown move, →← expand/collapse, Enter/Space open or toggle,
  // Shift+F10 or the menu key opens the row menu (F2 and Esc are view keys, handled by onF2 / onEscape)
  private onRowKey(e: KeyboardEvent): void {
    const el = e.target as HTMLElement;
    // 行の中の入力欄などはそのまま。表の本体にいるとき（キーボードの行が描画範囲の外）は、その行にいるものとして動く
    // leave inputs inside rows alone; on the table body itself (the keyboard's row is outside the drawn window) act as if on that row
    const onBody = el === this.tbodyEl;
    if (!onBody && !el.matches(".ogantt-tr")) return;
    const i = onBody ? this.cursor : Number(el.dataset.index);
    const row = this.rows[i];
    if (!row) return;
    const key = row.kind === "group" ? row.key : row.hasChildren ? row.key : undefined;
    const page = Math.max(1, Math.floor(((this.boardMain?.clientHeight ?? 0) - HEAD_H) / ROW_H) - 1);
    const go = (n: number) => { e.preventDefault(); this.focusRow(Math.max(0, Math.min(this.rows.length - 1, n))); };
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      return void this.moveRow(i, e.key === "ArrowUp" ? -1 : 1);
    }
    if (e.key === "ArrowDown") return go(i + 1);
    if (e.key === "ArrowUp") return go(i - 1);
    if (e.key === "Home") return go(0);
    if (e.key === "End") return go(this.rows.length - 1);
    if (e.key === "PageDown") return go(i + page);
    if (e.key === "PageUp") return go(i - page);
    if ((e.key === "ArrowRight" && key != null && this.isCollapsed(key)) || (e.key === "ArrowLeft" && key != null && !this.isCollapsed(key))) {
      e.preventDefault();
      return this.toggleCollapse(key);
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row.kind === "group") return this.toggleCollapse(row.key);
      return void this.openDetail(row.task!.path);
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      if (row.kind === "task") return this.openRowMenu(row.task!, el);
      // 見出しは右クリックと同じメニュー（色・アイコン）/ a heading gets its right-click menu (colour, icon)
      const r = el.getBoundingClientRect();
      el.querySelector(".ogantt-td-group")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }));
    }
  }

  // 行へフォーカスを移す（範囲外ならスクロールして描いてから）/ move focus to a row, scrolling it into view (and drawing it) first
  private focusRow(i: number): void {
    this.cursor = i;
    const main = this.boardMain;
    if (!main) return;
    const top = i * ROW_H;
    const view = main.clientHeight - HEAD_H;
    if (top < main.scrollTop) main.scrollTop = top;
    else if (top + ROW_H > main.scrollTop + view) main.scrollTop = top + ROW_H - view;
    this.paintWindow?.();
    this.tbodyEl.querySelectorAll('.ogantt-tr[tabindex="0"]').forEach((el) => el.setAttr("tabindex", "-1"));
    const el = this.tbodyEl.querySelector<HTMLElement>(`.ogantt-tr[data-index="${i}"]`);
    el?.setAttr("tabindex", "0");
    el?.focus({ preventScroll: true });
  }

  // 行のメニュー（開く・サブタスクにする・親から外す・フォルダへ移動・削除）。ドラッグ＆ドロップの代わりにもなる
  // the row menu (open, make subtask, detach, move to folder, delete); also the alternative to drag and drop
  private openRowMenu(t: Task, at: MouseEvent | HTMLElement): void {
    const m = new Menu();
    m.addItem((i) => i.setTitle(tr().openAsNote).setIcon("external-link").onClick(() => this.openTask(t.path, "tab")));
    m.addItem((i) => i.setTitle(tr().menuMakeSubtask).setIcon("corner-down-right").onClick(() => {
      const banned = new Set(subtreePaths(this.tasks, t.path)); // 循環になる候補は出さない / no candidate that would make a cycle
      new PickModal(this.app, this.tasks.filter((x) => !banned.has(x.path)), (x) => this.taskLabel(x), tr().menuMakeSubtask, (p) =>
        void this.reparentTo(t.path, this.taskFolder(p.path), p.path)).open();
    }));
    if (t.parent) m.addItem((i) => i.setTitle(tr().menuDetach).setIcon("corner-left-up").onClick(() => void this.reparentTo(t.path, this.taskFolder(t.path), null)));
    m.addItem((i) => i.setTitle(tr().menuMoveToFolder).setIcon("folder-input").onClick(() => {
      const dirs = ["", ...this.allFolders.map((f) => f.join("/"))].map((rel) => (this.folder && rel ? `${this.folder}/${rel}` : this.folder || rel));
      new PickModal(this.app, dirs, (d) => d || tr().vaultRoot, tr().menuMoveToFolder, (d) => void this.reparentTo(t.path, d, null)).open();
    }));
    // 兄弟の中で上・下へ（キーボードは Alt+↑/↓）/ up or down among its siblings (Alt+↑/↓ on the keyboard)
    const i = this.rows[this.cursor]?.task?.path === t.path ? this.cursor : this.rows.findIndex((r) => r.task?.path === t.path);
    m.addItem((it) => it.setTitle(tr().menuMoveUp).setIcon("arrow-up").onClick(() => this.moveRow(i, -1)));
    m.addItem((it) => it.setTitle(tr().menuMoveDown).setIcon("arrow-down").onClick(() => this.moveRow(i, 1)));
    const off = this.disabled.has(t.path);
    m.addItem((it) => it.setTitle(off ? tr().menuEnable : tr().menuDisable).setIcon(off ? "circle-play" : "circle-off").onClick(() =>
      this.setDisabled([t.path], !off, off ? tr().menuEnable : tr().menuDisable)));
    m.addSeparator();
    m.addItem((i) => i.setTitle(tr().menuDelete).setIcon("trash-2").onClick(() => this.confirmDelete(t.path)));
    if ("clientX" in at) m.showAtMouseEvent(at); // instanceof はポップアウトの窓では成り立たない / instanceof fails across popout windows
    else {
      const r = at.getBoundingClientRect();
      m.showAtPosition({ x: r.left + 24, y: r.bottom }, at.doc);
    }
  }

  // ピッカーに出すタスク名（同名があり得るのでフォルダも添える）/ a task's name in pickers, with its folder since names can repeat
  private taskLabel(t: Task): string {
    return t.groups.length ? `${t.name} — ${t.groups.join("/")}` : t.name;
  }

  private xOf(dateStr: string): number {
    return (dayIndex(dateStr) - this.range.min) * this.ppd;
  }

  // 今日の線 / today marker
  private drawToday(svg: SVGElement, width: number, height: number): void {
    const x = (this.today() - this.range.min) * this.ppd;
    if (x >= 0 && x <= width) svg.appendChild(this.svgEl("line", { x1: x, y1: 0, x2: x, y2: height, class: "ogantt-today" }));
  }

  // 同じタスクが複数の行に出ているとき（複数の担当者・タグでグループ化）、バーの左端を点線でつなぐ
  // when one task shows on several rows (grouped by its assignees or tags), join its copies with a dotted line at the bar's start
  private drawCopyLinks(svg: SVGElement, first = 0, last = Infinity): void {
    const rowsOf = new Map<string, number[]>();
    this.rows.forEach((r, i) => { if (r.task) rowsOf.set(r.task.path, [...(rowsOf.get(r.task.path) ?? []), i]); });
    for (const [path, idx] of rowsOf) {
      if (idx[idx.length - 1] < first || idx[0] > last) continue; // 描いている範囲にかからない / outside the rows being drawn
      const start = idx.length > 1 ? anchorStart(this.rows[idx[0]].task!) : undefined;
      if (!start) continue;
      const x = this.xOf(start);
      const y = (i: number) => i * ROW_H + ROW_H / 2;
      svg.appendChild(this.svgEl("line", { x1: x, y1: y(idx[0]), x2: x, y2: y(idx[idx.length - 1]), class: "ogantt-copy-link", "data-path": path }));
    }
  }

  // グループ行：背景と、配下の期間をまとめたバー（見出しの色で）/ a group row: its background and the summary bar of its span, in the heading's colour
  private drawGroupRow(bg: SVGElement, bars: SVGElement, row: Row, i: number, width: number): void {
    bg.appendChild(this.svgEl("rect", { x: 0, y: i * ROW_H, width, height: ROW_H, class: "ogantt-grid-group" }));
    if (!row.span) return;
    const gx = this.xOf(row.span.start);
    const gw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
    const gy = i * ROW_H + ROW_H / 2 - 3;
    const color = this.groupColor(this.groupBy, row.group);
    for (const el of [
      this.svgEl("rect", { x: gx, y: gy, width: gw, height: 6, rx: 2, class: "ogantt-group-bar" }),
      // 端のキャップ / end caps
      this.svgEl("path", { d: `M ${gx} ${gy} l 0 8 l 5 -8 z`, class: "ogantt-group-cap" }),
      this.svgEl("path", { d: `M ${gx + gw} ${gy} l 0 8 l -5 -8 z`, class: "ogantt-group-cap" }),
    ]) {
      if (color) el.style.fill = color;
      bars.appendChild(el);
    }
  }

  // 稲妻線：今日を基準に、各行の「実績到達点」を結ぶ折れ線。左へ折れる＝遅れ / 右＝進み
  // progress line: joins each row's achieved-progress point against today; left = behind, right = ahead
  private drawProgressLine(svg: SVGElement, width: number, height: number): void {
    const basisX = (this.today() - this.range.min) * this.ppd;
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

  // バーの塗り：ステータス色か担当者色。担当者が複数なら各人の色の横縞 / the bar fill: status or assignee colour, one band per person when shared
  private barFill(svg: SVGElement): (t: Task) => string {
    const statusColor = new Map(this.plugin.settings.statuses.map((x) => [x.id, x.color]));
    return (t) => {
      if (this.colorBy !== "assignee") return (t.status && statusColor.get(t.status)) || FALLBACK_BAR;
      if (t.assignees.length < 2) return t.assignees.length ? this.assigneeColor(t.assignees[0]) : FALLBACK_BAR;
      return this.bands(svg, t.assignees.map((a) => this.assigneeColor(a)));
    };
  }

  // タスク 1 行のバー（ロールアップ・マイルストーン・通常）。ステータスの種類は色以外でも示す：完了は ✓、延期は斜線、キャンセルは取り消し線
  // one task's bar (rollup, milestone or regular). The status group also shows without colour: ✓ completed, hatching deferred, strike-through cancelled
  private drawBar(layer: SVGElement, svg: SVGElement, row: Row, i: number, fill: (t: Task) => string, handles: Handles | null): void {
    const t = row.task!;
    const group = statusGroupOf(this.plugin.settings.statuses, t.status);
    const cyMid = i * ROW_H + ROW_H / 2;
    const y = i * ROW_H + BAR_PAD;
    const h = ROW_H - BAR_PAD * 2;
    const open = (g: SVGGElement) => {
      // クリックで詳細パネル（ドラッグした直後のクリックは除く）、ホバーで情報カード / a click opens the panel (not right after a drag); hovering shows the card
      g.addEventListener("click", (ev) => {
        if (this.dragged.get(g)) return;
        ev.stopPropagation();
        void this.openDetail(t.path);
      });
      g.addEventListener("pointermove", (e) => this.moveCard(e));
      g.addEventListener("pointerleave", () => this.hideCard());
    };
    // ロールアップ ON：子を持つ親は「子孫を含む範囲」のフルバーで描く（自分のバーは描かない）
    // rollup on: draw a parent as a full bar spanning its whole subtree (not its own bar)
    if (this.rollup && row.span) {
      const sx = this.xOf(row.span.start);
      const sw = Math.max((dayIndex(row.span.end) - dayIndex(row.span.start) + 1) * this.ppd, 6);
      const rg = this.svgEl("g", { class: "ogantt-bar-g ogantt-rollup-g", "data-path": t.path });
      rg.appendChild(this.svgEl("rect", { x: sx, y, width: sw, height: h, rx: 4, class: "ogantt-bar ogantt-rollup-bar", fill: fill(t) }));
      this.drawLabel(rg, t, sx + sw + LABEL_GAP, cyMid, group, row.group);
      rg.addEventListener("pointerenter", (e) => this.showCard(t, e));
      open(rg);
      layer.appendChild(rg);
      return;
    }
    const aStart = anchorStart(t);
    if (!aStart) return;
    const x = this.xOf(aStart);
    const g = this.svgEl("g", { class: "ogantt-bar-g" + (group === "cancelled" ? " is-cancelled" : "") + (this.disabled.has(t.path) ? " is-disabled" : this.late?.has(t.path) ? " is-late" : ""), "data-path": t.path });
    let lx = x; // 左端ハンドル位置 / left handle x
    let rx = x; // 右端ハンドル位置 / right handle x
    if (t.milestone) {
      const r = h / 2;
      const dia = this.svgEl("path", {
        d: `M ${x} ${cyMid - r} L ${x + r} ${cyMid} L ${x} ${cyMid + r} L ${x - r} ${cyMid} Z`,
        class: "ogantt-milestone",
        fill: fill(t),
      });
      g.appendChild(dia);
      this.attachDrag(g, dia, t);
      lx = x - r;
      rx = x + r;
    } else {
      const w = Math.max((dayIndex(anchorEnd(t) ?? aStart) - dayIndex(aStart) + 1) * this.ppd, 6);
      const rect = g.appendChild(this.svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar", fill: fill(t) }));
      const p = Math.min(100, t.progress ?? 0);
      const prog = p > 0 ? g.appendChild(this.svgEl("rect", { x, y, width: (w * p) / 100, height: h, rx: 4, class: "ogantt-bar-progress" })) : null;
      const hatch = group === "deferred" ? g.appendChild(this.svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar-hatch", fill: this.hatch(svg) })) : null;
      // 端の伸縮中は、進捗・斜線もバーに合わせる / while an edge is dragged, the progress fill and hatching follow the bar
      const place = (nx: number, nw: number) => {
        for (const r of [rect, hatch]) {
          r?.setAttribute("x", String(nx));
          r?.setAttribute("width", String(nw));
        }
        prog?.setAttribute("x", String(nx));
        prog?.setAttribute("width", String((nw * p) / 100));
      };
      this.attachDrag(g, rect, t, place);
      // 端ホバーで ↔ カーソル、中央は掴むカーソル / ew-resize near edges, grab in the middle
      rect.addEventListener("mousemove", (e: MouseEvent) => {
        const box = rect.getBoundingClientRect();
        const off = e.clientX - box.left;
        const edge = Math.min(RESIZE_EDGE, box.width / 4);
        rect.style.cursor = off < edge || off > box.width - edge ? "ew-resize" : "grab";
      });
      rx = x + w;
    }
    this.drawLabel(g, t, rx + LABEL_GAP, cyMid, group, row.group);
    g.addEventListener("pointerenter", (e) => {
      handles?.show(t, g, lx, rx, cyMid);
      this.showCard(t, e);
    });
    g.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") handles?.hide(); });
    open(g);
    layer.appendChild(g);
  }

  // 依存を作る 2 つの丸ハンドル（左＝開始、右＝終了）。全バーで共有し、マウスが載ったバーの両端へ動かす
  // the two connector handles (left = start, right = finish), shared by every bar and moved to the ends of the hovered one
  private makeHandles(svg: SVGElement, layer: SVGElement): Handles {
    const HGAP = 11; // バー端からの距離 / gap from the bar edge
    let cur: { t: Task; g: SVGGElement } | null = null;
    // バーから離れても少しの間は残し、その間にハンドルへ移れるようにする。隠したら画面の外へ（見えないまま押されないように）
    // they linger briefly after the pointer leaves the bar, so it can reach a handle; once hidden they move off-canvas (never pressed unseen)
    let timer: number | null = null;
    const cancel = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    };
    const ends = (["start", "finish"] as const).map((end) => {
      const handle = layer.appendChild(this.svgEl("circle", { r: 7, cx: -99, cy: -99, class: "ogantt-handle" }));
      handle.appendChild(this.svgEl("title", {})).textContent = tr().linkHint;
      handle.addEventListener("pointerdown", (e: PointerEvent) => { if (cur) this.startLink(cur.g, svg, cur.t, end, e); });
      handle.addEventListener("pointerenter", cancel);
      handle.addEventListener("pointerleave", () => api.hide());
      return { end, handle };
    });
    const api: Handles = {
      show: (t, g, lx, rx, cy) => {
        cancel();
        cur = { t, g };
        for (const { end, handle } of ends) {
          handle.setAttribute("cx", String(end === "start" ? lx - HGAP : rx + HGAP));
          handle.setAttribute("cy", String(cy));
          handle.classList.add("is-visible");
        }
      },
      hide: () => {
        cancel();
        timer = window.setTimeout(() => ends.forEach(({ handle }) => {
          handle.classList.remove("is-visible");
          handle.setAttribute("cx", "-99");
        }), 300);
      },
    };
    return api;
  }

  // バーの右に、担当者のアバター（頭文字の丸・共有タスクは重ねて並べる）、ラベル（タスク名・担当者）、タグの札を描く。完了は ✓ を前に付ける。
  // 見出しが示している値は繰り返さない：担当者でグループ化しているときは見出しの人を省いてほかの人を「+」付きで、タグでグループ化しているときは見出しのタグを省く。
  // 書き出しではタスク名（と ✓）は左の列にあるので、バーの後ろは人とタグだけ
  // to the right of a bar: assignee avatars (initials; overlapping for a shared task), the label (task name, assignees) and tag pills; ✓ marks
  // completed. What the heading already says isn't repeated: grouped by assignee, the heading's person is left out and the others follow a "+";
  // grouped by tag, the heading's tag is left out. In an export the task's name (and ✓) is in the name column, so only people and tags follow the bar
  private drawLabel(g: SVGElement, t: Task, x: number, cy: number, group: StatusGroup | undefined, heading: string): void {
    const people = besideHeading(t.assignees, "assignees", this.groupBy, heading);
    const shown = people.slice(0, MAX_AVATARS);
    shown.forEach((a, k) => {
      const c = this.assigneeColor(a);
      const av = g.appendChild(this.svgEl("g", { class: "ogantt-bar-avatar" }));
      av.appendChild(this.svgEl("circle", { cx: x + 7 + k * 10, cy, r: 7, fill: c }));
      av.appendChild(this.svgEl("text", { x: x + 7 + k * 10, y: cy + 3, fill: inkOn(c) })).textContent = initials(linkLabel(a));
    });
    if (shown.length) x += 18 + (shown.length - 1) * 10;
    const others = people.length < t.assignees.length; // 見出しの人を省いた / the heading's person was left out
    const who = people.map(linkLabel).join(", ");
    let text = who && others ? `+ ${who}` : who;
    if (!this.bare) text = `${group === "completed" ? "✓ " : ""}${t.name}${text ? (others ? " " : " · ") + text : ""}`;
    if (text) g.appendChild(this.svgEl("text", { x, y: cy + 4, class: "ogantt-bar-label", "font-size": LABEL_PX })).textContent = text;
    // タグはラベルの後ろに小さな札で、タグの色で控えめに（表示メニューで隠せる）/ tags follow the label as small pills, quietly in their colour (hidden from the Display menu)
    if (!this.showTags) return;
    const tags = besideHeading(t.tags, "tags", this.groupBy, heading);
    if (!tags.length) return;
    let px = text ? x + this.textWidth(text, LABEL_PX) + 8 : x;
    for (const tag of tags.slice(0, MAX_PILLS)) {
      const w = this.textWidth(tag, PILL_PX) + 12;
      const c = this.tagColor(tag);
      const pill = g.appendChild(this.svgEl("g", { class: "ogantt-tag-pill" }));
      pill.appendChild(this.svgEl("rect", { x: px, y: cy - 5, width: w, height: 14, rx: 7, fill: c, stroke: c }));
      pill.appendChild(this.svgEl("text", { x: px + w / 2, y: cy + 3, fill: c, "font-size": PILL_PX })).textContent = tag;
      px += w + 4;
    }
    if (tags.length > MAX_PILLS) g.appendChild(this.svgEl("text", { x: px, y: cy + 4, class: "ogantt-bar-label", "font-size": LABEL_PX })).textContent = `+${tags.length - MAX_PILLS}`;
  }

  // 文字列の幅（キャンバスで測るので DOM のレイアウトを起こさない）/ a string's width, measured on a canvas (no DOM layout)
  private textWidth(text: string, px: number, weight = 400): number {
    this.measureCtx.font = `${weight} ${px}px ${this.fontFamily}`;
    return this.measureCtx.measureText(text).width;
  }

  // 色を等分した横縞のグラデーションを用意して fill の url を返す（共有タスクの担当者の色）
  // set up a gradient of equal horizontal stripes and return its fill url (a shared task's assignee colours)
  private bands(svg: SVGElement, colors: string[]): string {
    const id = `ogantt-bands-${this.uid}-${colors.join("-").replace(/[^\w-]/g, "")}`;
    if (!svg.querySelector(`#${CSS.escape(id)}`)) {
      const grad = this.defs(svg).appendChild(this.svgEl("linearGradient", { id, x2: 0, y2: 1 }));
      colors.forEach((c, k) => {
        for (const at of [k, k + 1]) grad.appendChild(this.svgEl("stop", { offset: at / colors.length, "stop-color": c }));
      });
    }
    return `url(#${id})`;
  }

  // 延期のバーに重ねる斜線の模様 / the hatching laid over a deferred bar
  private hatch(svg: SVGElement): string {
    const id = `ogantt-hatch-${this.uid}`;
    if (!svg.querySelector(`#${id}`)) {
      const p = this.defs(svg).appendChild(this.svgEl("pattern", { id, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }));
      p.appendChild(this.svgEl("rect", { width: 2.5, height: 6, class: "ogantt-hatch-line" }));
    }
    return `url(#${id})`;
  }

  private defs(svg: SVGElement): SVGDefsElement {
    return svg.querySelector("defs") ?? svg.insertBefore(this.svgEl("defs", {}), svg.firstChild);
  }

  // ハンドルから線を引いて他タスクへドロップ＝依存作成 / drag from a handle to another task = create dependency
  private startLink(g: SVGGElement, svg: SVGElement, source: Task, sourceEnd: "start" | "finish", ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.hideCard();
    this.dragged.set(g, true); // バーのクリックを抑止 / suppress the bar click
    const handle = ev.target as Element;
    handle.setPointerCapture(ev.pointerId);
    this.dragging = "link";
    handle.addEventListener("lostpointercapture", () => { if (this.dragging === "link") this.dragging = null; }, { once: true });
    // SVG の位置は毎回測り直す（引いている間にボードをスクロールしても、狙った行に付く）/ measure the svg each time, so scrolling mid-drag still hits the right row
    const box = () => svg.getBoundingClientRect();
    const x1 = ev.clientX - box().left;
    const y1 = ev.clientY - box().top;
    const tmp = this.svgEl("path", { d: `M ${x1} ${y1} L ${x1} ${y1}`, class: "ogantt-link-temp" });
    svg.appendChild(tmp);

    const clearHi = () =>
      svg.querySelectorAll(".is-link-target").forEach((el) => el.removeClass("is-link-target"));
    const onMove = (e: PointerEvent) => {
      const x2 = e.clientX - box().left;
      const y2 = e.clientY - box().top;
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
      this.dragging = null;
      // クリック抑止フラグはこの後の click 後に解除 / clear the click-suppress flag after the click fires
      window.setTimeout(() => this.dragged.set(g, false), 0);
      const row = this.rows[Math.floor((e.clientY - box().top) / ROW_H)];
      if (row?.kind !== "task" || !row.task || row.task.path === source.path) return;
      const target = row.task;
      if (!anchorStart(target) && !anchorEnd(target)) return; // 日付の無いタスクには付けられない / a task without dates can't take a link
      // ドロップ先のどの端か判定（左半分=start, 右半分=finish）/ which end was dropped on
      const tLeft = this.xOf(anchorStart(target) ?? anchorEnd(target)!);
      const tRight = this.xOf(anchorEnd(target) ?? anchorStart(target)!) + this.ppd;
      const targetEnd: "start" | "finish" = e.clientX - box().left < (tLeft + tRight) / 2 ? "start" : "finish";
      // 端の組み合わせで種類を決定（先行=ドラッグ元、後続=ドロップ先。start→finish の SF は未対応）
      // pick the type from the connected ends (predecessor = drag source, successor = drop target; SF is unsupported)
      const type: DepType | null =
        sourceEnd === "finish" ? (targetEnd === "start" ? "FS" : "FF") : targetEnd === "start" ? "SS" : null;
      if (type == null) new Notice(tr().sfUnsupported);
      else await this.addDep(source.path, target.path, type);
    })();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  // 依存を足して後続を連動させる（取り消し可）。ドラッグでも詳細パネルの「追加」からでも使う
  // add a dependency and cascade its successors (undoable); used by the drag and by the panel's "Add" alike
  private async addDep(predPath: string, succPath: string, type: DepType): Promise<void> {
    // 行はグループ化の複製のことがあるので、連動が読む本物に依存を足す / rows may hold grouping copies; add the dep to the live task
    const target = this.tasks.find((x) => x.path === succPath);
    if (!target) return;
    // 輪になる依存は足さない（連動の日付が決まらなくなる）/ a dependency that would close a loop is refused (the cascade would have no answer)
    if (wouldLoop(this.tasks, predPath, succPath)) return void new Notice(tr().depLoop);
    // 連動しうるのは target（新しい辺）と、先行・後続それぞれの後続 / the cascade can reach target plus the successors of both ends
    const fs = this.plugin.settings.autoScheduleFS;
    const paths = [succPath, ...successorClosure(this.tasks, predPath, fs), ...successorClosure(this.tasks, succPath, fs)];
    await this.mutate(tr().undoAddDep(type), paths, async () => {
      await addDependency(this.app, this.plugin.settings, succPath, predPath, type);
      // メモリにも依存を反映（metadataCache 更新前でも整列できるように）/ reflect the dep in memory (aligns before the metadata cache updates)
      target.deps = target.deps.filter((d) => d.path !== predPath);
      target.deps.push({ path: predPath, type });
      await this.cascade([predPath]);
    });
    this.rerender();
  }

  // 依存を外す（取り消し可）。すぐ消えるので、取り消しボタン付きの通知を出す
  // remove a dependency (undoable); it goes at once, so a notice offers an Undo button
  private async removeDep(succPath: string, predPath: string, type: DepType): Promise<void> {
    const ok = await this.mutate(tr().undoRemoveDep(type), [succPath], () => removeDependency(this.app, this.plugin.settings, succPath, predPath));
    // record() が前の通知を閉じたので、新しい通知だけ出す / record() already closed the previous notice
    if (ok) this.undoToast = this.buttonNotice(tr().depRemoved(type), tr().undoShort, () => void this.undo(), 6000);
    await this.refresh();
  }

  // ボタン付きの通知（取り消す・開く）/ a notice with a button (Undo, Open)
  private buttonNotice(message: string, button: string, onClick: () => void, ms: number): Notice {
    return new Notice(createFragment((f) => {
      f.appendText(`${message} `);
      f.createEl("button", { text: button }).onclick = onClick;
    }), ms);
  }

  // roots の日付変更を依存に沿って後続へ伝える（SS/FF は揃える、FS は設定で押し出す・稼働日で期間を保つ）。
  // ディスクへ書き、メモリ上のタスクも更新する。mutate の中から呼ぶこと
  // propagate the roots' date changes to their successors (SS/FF snap, FS pushes when enabled; durations kept in
  // workdays). Writes to disk and updates the in-memory tasks; call it from inside mutate
  private async cascade(roots: string[]): Promise<void> {
    const changes = cascadeDates(this.cascadeTasks(), roots, scheduleOptions(this.plugin.settings));
    // 依存が輪になっていると日付が決まらないので、後続は動かさずに知らせる / dependencies in a loop have no answer: successors stay put, and we say why
    if (!changes) return void new Notice(tr().depLoop);
    // 書く先はそれぞれ別のファイルなので並行に書く。どれかが失敗しても残りは書き終えてから知らせる（取り消しの記録が書いた分とずれない）
    // each change is a different file, so they're written in parallel; if one fails the rest still finish first, so the undo record matches what was written
    const results = await Promise.allSettled([...changes].map(async ([path, d]) => {
      const t = this.tasks.find((x) => x.path === path);
      if (!t) return;
      await writeDates(this.app, this.plugin.settings, path, d.start, d.end, false);
      t.start = d.start;
      t.end = d.end;
    }));
    const failed = results.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (failed) throw failed.reason;
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
      // 期限日の無いタスクは、動かしても 1 日のままなら期限日を足さない / a task with no due date gets none when it's moved and stays a single day
      if (!(t.endFilled && end === next.start)) await writeField(this.app, path, k.end, combineDateTime(end || undefined, times.end, tz));
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
    return successorClosure(this.cascadeTasks(), root, this.plugin.settings.autoScheduleFS);
  }

  // 連動に使うタスク：止めたタスクは押されない（依存を持たないものとして扱うので、その先へも伝わらない）
  // the tasks a cascade sees: a disabled task is never pushed (treated as having no dependencies, so the push doesn't pass through it)
  private cascadeTasks(): Task[] {
    return this.disabled.size ? this.tasks.map((t) => (this.disabled.has(t.path) ? { ...t, deps: [] } : t)) : this.tasks;
  }

  // 描く依存の一覧（後続・先行の行番号つき）。描画のたびに見えている範囲で絞る
  // the dependencies to draw, with the rows of both ends; each paint keeps those crossing the rows in view
  // 担当者・タグでグループ化するとタスクが複数の行に出るので、後続の行ごとに、いちばん近い先行の行へ引く
  // grouped by assignee or tag a task shows in several rows, so each successor row gets an arrow from the nearest predecessor row
  private depRows(): DepRow[] {
    const rowsOf = new Map<string, number[]>();
    this.rows.forEach((r, i) => {
      if (r.kind !== "task") return;
      const list = rowsOf.get(r.task!.path);
      if (list) list.push(i);
      else rowsOf.set(r.task!.path, [i]);
    });
    const byPath = new Map(this.tasks.map((x) => [x.path, x]));
    const out: DepRow[] = [];
    for (const t of this.tasks) {
      for (const si of rowsOf.get(t.path) ?? []) {
        for (const dep of t.deps) {
          const pred = byPath.get(dep.path);
          const pis = rowsOf.get(dep.path);
          if (!pred || !pis) continue;
          const pi = pis.reduce((a, b) => (Math.abs(b - si) < Math.abs(a - si) ? b : a));
          out.push({ t, pred, type: dep.type, si, pi });
        }
      }
    }
    return out;
  }

  // 依存の矢印 1 本。線に載ると最前面の × がその中点に出て、× を押したときだけ外す（線のどこかを押しても消えない）
  // one dependency arrow; hovering it brings the shared × (on top of everything) to its midpoint, and only the × removes it
  private drawDep(layer: SVGElement, dep: DepRow, depX?: DepX | null): void {
    const { t, pred, type: depType, si, pi } = dep;
    const sStart = anchorStart(t);
    const sEnd = anchorEnd(t);
    const pStartD = anchorStart(pred);
    const pEndD = anchorEnd(pred);
    if (!sStart || !sEnd || !pStartD || !pEndD) return;
    const GAP = 12;
    // マイルストーンはひし形の先端で止める（中心まで引くと矢じりがひし形の下に隠れる）/ a milestone's arrows stop at its tips (at the centre the arrowhead hides under the diamond)
    const tip = (ROW_H - BAR_PAD * 2) / 2;
    const sLeft = this.xOf(sStart) - (t.milestone ? tip : 0);
    const sRight = this.xOf(sEnd) + (t.milestone ? tip : this.ppd);
    const sy = si * ROW_H + ROW_H / 2;
    const pLeft = this.xOf(pStartD) - (pred.milestone ? tip : 0);
    const pRight = this.xOf(pEndD) + (pred.milestone ? tip : this.ppd);
    const py = pi * ROW_H + ROW_H / 2;
    const mid = (py + sy) / 2;
    let d: string;
    let mxX: number;
    const mxY = mid;
    let arrowD: string;
    const violation = depViolated(t, pred, depType, scheduleOptions(this.plugin.settings).cal);
    if (depType === "FS") {
      // 先行の終了 → 後続の開始（左から差し込む）/ pred finish → succ start
      const sx0 = pRight;
      const tx = sLeft;
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
    } else if (depType === "SS") {
      // 先行の開始 → 後続の開始（左側を回る）/ pred start → succ start
      const sx0 = pLeft;
      const tx = sLeft;
      const leftMost = Math.min(sx0, tx) - GAP;
      d = `M ${sx0} ${py} L ${leftMost} ${py} L ${leftMost} ${sy} L ${tx} ${sy}`;
      mxX = leftMost;
      arrowD = `M ${tx} ${sy} l -7 -4 l 0 8 z`; // 右向き / points right
    } else {
      // FF: 先行の終了 → 後続の終了（右側を回る）/ pred finish → succ finish
      const sx0 = pRight;
      const tx = sRight;
      const rightMost = Math.max(sx0, tx) + GAP;
      d = `M ${sx0} ${py} L ${rightMost} ${py} L ${rightMost} ${sy} L ${tx} ${sy}`;
      mxX = rightMost;
      arrowD = `M ${tx} ${sy} l 7 -4 l 0 8 z`; // 左向き / points left
    }
    const depG = this.svgEl("g", { class: "ogantt-dep-g" });
    const hit = depG.appendChild(this.svgEl("path", { d, class: "ogantt-dep-hit" }));
    hit.appendChild(this.svgEl("title", {})).textContent = tr().depTooltip(depType);
    depG.appendChild(this.svgEl("path", { d, class: "ogantt-dep" + (violation ? " is-violation" : "") }));
    depG.appendChild(this.svgEl("path", { d: arrowD, class: "ogantt-dep-arrow" + (violation ? " is-violation" : "") }));
    // FS 以外は種類ラベルを表示 / show a type label for non-FS
    if (depType !== "FS") {
      const lbl = depG.appendChild(this.svgEl("text", { x: mxX, y: mxY - 9, class: "ogantt-dep-type" }));
      lbl.textContent = depType;
    }
    if (depX) {
      depG.addEventListener("pointerenter", () => depX(dep, mxX, mxY));
      depG.addEventListener("pointerleave", () => depX(null));
    }
    layer.appendChild(depG);
  }

  // 依存を外す × は最前面に 1 つだけ置き、矢印に載ったときにその中点へ動かす（ほかのバーの下に隠れない）。
  // 離れても少し残すので、その間に × へ移れる / the × that removes a dependency: one per board, on top of everything, moved to the
  // midpoint of the arrow under the pointer (so no bar can cover it); it lingers briefly after the pointer leaves, long enough to reach it
  private makeDepX(layer: SVGElement): DepX {
    let cur: DepRow | null = null;
    let timer: number | null = null;
    const xg = layer.appendChild(this.svgEl("g", { class: "ogantt-dep-x", role: "button" }));
    const ring = xg.appendChild(this.svgEl("circle", { r: 8, class: "ogantt-dep-x-bg" }));
    const mark = xg.appendChild(this.svgEl("path", { class: "ogantt-dep-x-mark" }));
    const stop = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      stop();
      timer = window.setTimeout(() => xg.classList.remove("is-visible"), 300);
    };
    xg.addEventListener("pointerenter", stop);
    xg.addEventListener("pointerleave", hide);
    xg.addEventListener("click", (e) => {
      e.stopPropagation();
      xg.classList.remove("is-visible");
      if (cur) void this.removeDep(cur.t.path, cur.pred.path, cur.type);
    });
    return (dep, x = 0, y = 0) => {
      if (!dep) return hide();
      stop();
      cur = dep;
      ring.setAttribute("cx", String(x));
      ring.setAttribute("cy", String(y));
      mark.setAttribute("d", `M ${x - 3} ${y - 3} L ${x + 3} ${y + 3} M ${x + 3} ${y - 3} L ${x - 3} ${y + 3}`);
      xg.setAttribute("aria-label", tr().depTooltip(dep.type));
      xg.classList.add("is-visible");
    };
  }

  // 依存が守られていない後続（矢印を隠しているときの赤い縁）。先行が画面に無くても（畳まれた・絞り込まれた）判定する
  // successors whose dependency is broken (the red outline while arrows are hidden), judged even when the predecessor isn't on screen
  private lateTasks(): Set<string> {
    const cal = scheduleOptions(this.plugin.settings).cal;
    const byPath = new Map(this.tasks.map((x) => [x.path, x]));
    return new Set(this.tasks.filter((t) => t.deps.some((d) => {
      const pred = byPath.get(d.path);
      return !!pred && depViolated(t, pred, d.type, cal);
    })).map((t) => t.path));
  }

  // バー/菱形のドラッグで日付を書き戻す。place はバーの端を伸縮するときの描き直し（菱形には無い）
  // drag a bar or diamond to reschedule; `place` redraws a bar while an edge is dragged (diamonds have none)
  private attachDrag(g: SVGGElement, handle: SVGElement, task: Task, place?: (x: number, w: number) => void): void {
    const EDGE = RESIZE_EDGE;
    const milestone = task.milestone;
    handle.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      // preventDefault はフォーカスを移さないため、入力中の欄からボードへ移す（Ctrl+Z をガント側へ。ポップアウトの窓でも）
      // preventDefault keeps focus on a previously focused input, so move it to the board (Ctrl+Z then reaches the gantt undo, in a pop-out too)
      this.contentEl.focus({ preventScroll: true });
      this.hideCard();
      this.dragged.set(g, false);
      const startX = ev.clientX;
      handle.setPointerCapture(ev.pointerId);
      // 掴んでいる間は描き直さない（掴んだバーが消えるとドラッグが途切れる）。外れたら必ず戻す
      // no redraw while the bar is held (removing it would drop the drag); always released once capture ends
      this.dragging = "bar";
      handle.addEventListener("lostpointercapture", () => { if (this.dragging === "bar") this.dragging = null; }, { once: true });

      let mode: "move" | "l" | "r" = "move";
      let x0 = 0;
      let w0 = 0;
      if (place) {
        x0 = parseFloat(handle.getAttribute("x")!);
        w0 = parseFloat(handle.getAttribute("width")!);
        // rect 実画面座標から相対オフセットを求める（SVG の offsetX は不正確）
        // use screen box for offset; SVG offsetX is unreliable in Chromium
        const box = handle.getBoundingClientRect();
        const offset = ev.clientX - box.left;
        const edge = Math.min(EDGE, box.width / 4); // 短いバーにも動かせる真ん中を残す / short bars keep a middle to move them by
        mode = offset < edge ? "l" : offset > box.width - edge ? "r" : "move";
      }

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 3) this.dragged.set(g, true);
        // 移動はバー一式（進捗・タグの帯・ラベル）を平行移動、端は伸縮（最短 1 日）
        // a move slides the whole bar (progress, tag band, label); an edge resizes it (one day at least)
        if (mode === "move") g.setAttribute("transform", `translate(${dx},0)`);
        else if (mode === "r") place!(x0, Math.max(this.ppd, w0 + dx));
        else place!(x0 + Math.min(dx, w0 - this.ppd), Math.max(this.ppd, w0 - dx));
      };
      const onUp = (e: PointerEvent) => void (async () => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        this.dragging = null;
        // 3px 未満の動きはクリック（縮尺が小さいと 1 日が数 px なので、指先の揺れで日付を動かさない）
        // a move under 3px is a click: at small zooms a day is a few pixels, so a shaky click mustn't reschedule
        const dxDays = this.dragged.get(g) ? Math.round((e.clientX - startX) / this.ppd) : 0;
        if (dxDays !== 0) {
          // 行のタスクはグループ化（ステータス・担当者・タグ）の複製のことがあるので、連動が読む本物を直す
          // a row may hold a copy made for grouping (status, assignee, tag), so update the live task the cascade reads
          const live = this.tasks.find((x) => x.path === task.path) ?? task;
          await this.mutate(tr().undoReschedule(task.name), [task.path, ...this.cascadePaths(task.path)], async () => {
            if (milestone) {
              const nd = dayToStr(dayIndex(task.end ?? task.start!) + dxDays);
              await writeDates(this.app, this.plugin.settings, task.path, nd, nd, true);
              live.end = nd; // メモリ更新 / update in-memory
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
              live.start = nsS; // メモリ更新 / update in-memory
              live.end = neS;
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
          g.removeAttribute("transform");
          place?.(x0, w0);
        }
      })();
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // ----- 新規タスク作成 / create a new task -----
  // 今のフォルダに 1 日タスク（開始=終了=今日）を作り、詳細パネルを開いて命名を促す（キャンバスは .canvas も作る）
  // create a 1-day task (start = end = today) in the current folder, then open the panel to name it (a canvas also gets its .canvas)
  private async createNewTask(kind: TaskKind = "note"): Promise<void> {
    let created: string[] = [];
    await this.mutate(tr().undoCreate(tr().newTaskName), [], async () => {
      created = await createTask(this.app, this.plugin.settings, this.folder, tr().newTaskName, kind);
      const today = dayToStr(this.today());
      await writeDates(this.app, this.plugin.settings, created[0], today, today, false);
      return { created };
    });
    if (!created.length) return;
    await this.refresh();
    await this.openDetail(created[0], true);
  }

  // ----- ドラッグ＆ドロップ（フォルダへ＝親解除して移動／タスクへ＝サブタスク化）-----
  // ----- drag & drop (onto a folder = detach + move; onto a task = make subtask) -----
  // タスク行をドラッグ可能にする / make a task row draggable
  private makeDraggableTask(row: HTMLElement, path: string): void {
    row.setAttr("draggable", "true");
    row.addEventListener("dragstart", (e: DragEvent) => {
      e.dataTransfer?.setData("text/plain", path);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.dragPath = path;
      this.hideCard();
      row.addClass("is-dragging");
    });
    row.addEventListener("dragend", () => {
      this.dragPath = null;
      row.removeClass("is-dragging");
    });
  }

  // 行をドロップ先にする。重ねている間は、落とすと何が起きるか（label）を行に出す / make a row a drop target; while hovering, the row shows what a drop will do
  // タスクの行の上端・下端の 4 分の 1 に落とすと、その前・後ろへ並べ替え（真ん中は handler）
  // on a task row, dropping in the top or bottom quarter places the dragged row before or after it (the middle runs `handler`)
  private makeDropTarget(row: HTMLElement, label: string, handler: (srcPath: string) => void): void {
    const target = row.dataset.path;
    const zone = (e: DragEvent): "before" | "after" | null => {
      if (!target) return null;
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      return y < 0.25 ? "before" : y > 0.75 ? "after" : null;
    };
    const clear = () => row.removeClass("is-drop-target", "is-drop-before", "is-drop-after");
    row.addEventListener("dragover", (e: DragEvent) => {
      if (this.dragPath != null && this.dragPath === target) return; // 自分の上には落とせない / not onto itself
      e.preventDefault(); // preventDefault でドロップを許可 / allow dropping
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const z = zone(e);
      row.dataset.dropLabel = z ? tr().dropReorder : label;
      row.toggleClass("is-drop-target", !z);
      row.toggleClass("is-drop-before", z === "before");
      row.toggleClass("is-drop-after", z === "after");
    });
    row.addEventListener("dragleave", (e: DragEvent) => {
      if (!row.contains(e.relatedTarget as Node | null)) clear();
    });
    row.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      clear();
      this.dragPath = null;
      const src = e.dataTransfer?.getData("text/plain");
      const z = zone(e);
      if (src && z && target) this.placeRow(src, target, z);
      else if (src) handler(src);
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

  // タグ・担当者（多値）を 1 つ足す/外す（取り消し可・変化が無ければ何もしない）。メモリ上のタスクも直して即再描画する。
  // 本文の #tag は外せないので、書き込みで変化しなかったときはメモリも触らない
  // add or remove one tag / assignee (undoable; a no-op change does nothing) and mirror it in memory for an instant redraw.
  // An inline #tag can't be removed from here, so when the write changed nothing the in-memory task is left alone too
  private async editList(path: string, field: "tags" | "assignees", value: string, add: boolean): Promise<void> {
    const t = this.tasks.find((x) => x.path === path);
    // 人は表示名で比べる（"Ben" と "[[Ben]]" は同じ人）/ people compare by display name ("Ben" and "[[Ben]]" are one person)
    const same = (v: string) => (field === "assignees" ? linkLabel(v) === linkLabel(value) : v === value);
    if (!t || !value || add === t[field].some(same)) return;
    const next = add ? [...t[field], value] : t[field].filter((v) => !same(v));
    const label = field === "assignees" ? tr().undoEdit(t.name) : add ? tr().undoAddTag(t.name, value) : tr().undoRemoveTag(t.name, value);
    const ok = await this.mutate(label, [path], async () => {
      // 今のフロントマターを読み直して 1 件だけ変える（直前のほかの編集を消さない）/ re-read the frontmatter and change just this one entry (a moment-earlier edit survives)
      if (field === "assignees") return editListField(this.app, path, this.plugin.settings.keys.assignee, value, add);
      return add ? (await addTag(this.app, path, value)) || false : removeTag(this.app, path, value);
    });
    // 背景 refresh で this.tasks が作り替わる場合に備え、最新を引き直して更新 / look up the live task (survives a background refresh)
    const live = this.tasks.find((x) => x.path === path);
    if (ok && live) live[field] = next;
    // 足したタグは候補の一覧にも（一覧は Vault 全体を読むので、ビューの間は使い回す）/ an added tag joins the suggestions (that list reads the whole vault, so it's kept for the view's life)
    if (ok && add && field === "tags" && this.tagCache && !this.tagCache.includes(value)) this.tagCache.push(value);
    this.rerender();
  }

  // タグ・担当者のチップ（× で外す）と追加欄（Enter で足す）。詳細パネルと表のポップオーバーで共用し、追加欄を返す
  // chips for tags / assignees (× removes) plus an add field (Enter adds); shared by the detail panel and the table popover. Returns the field
  private chipList(host: HTMLElement, now: () => string, field: "tags" | "assignees", changed: () => void): HTMLInputElement {
    const path = now();
    const t = this.tasks.find((x) => x.path === path);
    const values = t?.[field] ?? [];
    const tags = field === "tags";
    for (const v of values) {
      const chip = host.createSpan({ cls: "ogantt-tag-chip" });
      if (tags) {
        this.paintTagChip(chip, v);
        chip.createSpan({ text: v });
        chip.addEventListener("contextmenu", (e) => this.openStyleMenu(e, "tag", v));
      } else {
        chip.addClass("ogantt-person-chip");
        this.avatar(chip, v);
        renderLinkValue(chip, v, "").addEventListener("click", (e) => handleLinkClick(this.app, e, path));
      }
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon", attr: { "aria-label": tags ? tr().removeTagAria : tr().removeAssigneeAria } });
      setIcon(x, "x");
      x.onclick = () => void this.editList(now(), field, v, false).then(changed);
    }
    const add = host.createEl("input", { cls: "ogantt-tag-add", type: "text", attr: { placeholder: tags ? tr().addTagPlaceholder : tr().addAssigneePlaceholder } });
    // 既存の値を候補に出して表記ゆれを防ぐ（担当者は "[[" でノートも）/ suggest existing values to avoid spelling drift ("[[" suggests notes for assignees)
    if (tags) this.attachSingleTagSuggestions(add, values);
    else {
      const names = this.assigneeList().filter((a) => !values.some((v) => linkLabel(v) === linkLabel(a)));
      if (names.length) this.attachSuggestions(add, (list) => names.forEach((n) => list.createEl("option", { value: n })));
      attachLinkSuggest(this.app, add, path);
    }
    add.addEventListener("keydown", (e) => { if (e.key === "Enter" && !composing(e)) { e.preventDefault(); add.blur(); } });
    add.addEventListener("change", () => {
      const v = tags ? add.value.trim().replace(/^#/, "") : add.value.trim();
      if (v) void this.editList(now(), field, v, true).then(changed);
    });
    return add;
  }

  // 担当者のアバター（頭文字の丸）/ an assignee avatar (initials in a circle)
  private avatar(parent: HTMLElement, who: string): void {
    const c = this.assigneeColor(who);
    const av = parent.createSpan({ cls: "ogantt-avatar", text: initials(linkLabel(who)) });
    av.style.background = c;
    av.style.color = inkOn(c);
  }

  // ----- 詳細パネル（編集モード）/ editable detail slide-over -----
  private async openDetail(path: string, focusTitle = false): Promise<void> {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const d = this.detailEl;
    // 同じタスクを描き直すときはパネルのスクロール位置を保つ / redrawing the same task keeps the panel's scroll position
    const keepScroll = this.isDetailOpenFor(path) ? d.scrollTop : 0;
    const seq = ++this.detailSeq;
    this.selectedPath = path;
    // 前のタスクの本文の描画（埋め込み・Dataview など）を片付ける / unload the previous task's rendered body (embeds, Dataview, …)
    if (this.bodyOwner) this.removeChild(this.bodyOwner);
    this.bodyOwner = null;
    // 選択行ハイライト更新（複製も含めて）。Esc で戻る行もこのタスクに / refresh the selection highlight (copies included); Esc returns to this task's row
    this.tbodyEl?.querySelectorAll(".ogantt-tr.is-selected").forEach((el) => el.removeClass("is-selected"));
    this.tbodyEl?.querySelectorAll(`.ogantt-tr[data-path="${CSS.escape(path)}"]`).forEach((el) => el.addClass("is-selected"));
    const at = this.rows.findIndex((r) => r.task?.path === path);
    if (at >= 0 && this.rows[this.cursor]?.task?.path !== path && !this.tbodyEl?.contains(activeDocument.activeElement)) this.cursor = at;

    const k = this.plugin.settings.keys;
    d.empty();
    d.addClass("is-open");
    // スマホではパネルが画面いっぱい（幅は CSS）/ on phones the panel fills the screen (width from CSS)
    if (!Platform.isPhone) d.style.width = `${this.plugin.settings.detailWidth}px`;

    // 左端の幅リサイズハンドル / left-edge width resize handle
    const resizer = d.createDiv({ cls: "ogantt-detail-resizer" });
    this.attachResize(resizer, d);

    // ヘッダー: タイトル＝ファイル名（編集でリネーム）/ header: title input renames the file
    const header = d.createDiv({ cls: "ogantt-detail-head" });
    const titleInput = header.createEl("input", { cls: "ogantt-detail-title", type: "text", attr: { "aria-label": tr().fieldName } });
    titleInput.value = t.name;
    // 変更できなかったとき（同名がある等）は欄を今の名前に戻す / when the rename didn't happen (name taken, …) the field goes back to the current name
    titleInput.addEventListener("change", () => void this.renameTaskTo(this.selectedPath!, t.name, titleInput.value).then(() => {
      titleInput.value = this.tasks.find((x) => x.path === this.selectedPath)?.name ?? titleInput.value;
    }));
    // 新規作成直後は名前を選択状態にして即リネームできるように / select the name right after creation
    if (focusTitle) window.setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);
    const openBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(openBtn, "external-link");
    openBtn.setAttr("aria-label", tr().openAsNote);
    openBtn.onclick = () => this.openTask(this.selectedPath!, "tab");
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
    const closeBtn = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().close } });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.closeDetail(true);

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
    const statusSel = fieldRow(tr().fieldStatus).createEl("select", { cls: "dropdown", attr: { "aria-label": tr().fieldStatus } });
    statusSel.createEl("option", { text: "—", value: "" });
    for (const s of this.plugin.settings.statuses) {
      const opt = statusSel.createEl("option", { text: s.label, value: s.id });
      if (s.id === t.status) opt.selected = true;
    }
    statusSel.addEventListener("change", () => void this.saveField(k.status, statusSel.value));

    // 担当者・タグ（多値）：チップの × で外し、入力＋Enter で足す（担当者は "[[" でノートも選べる。足すのは D&D でも可）
    // assignees and tags (multi-valued): × on a chip removes, input + Enter adds ("[[" picks a note as an assignee; drag & drop adds too)
    const reopen = () => { if (this.selectedPath) void this.openDetail(this.selectedPath); };
    // 今のパス（タイトル欄でリネームした直後でも、パネルを描き直す前に押された操作が古いパスを使わない）
    // the current path, so an action pressed right after a rename from the title (before the panel is redrawn) doesn't use the old one
    const here = () => this.selectedPath ?? t.path;
    for (const [field, label] of [["assignees", tr().fieldAssignee], ["tags", tr().fieldTags]] as const) {
      const row = fieldRow(label);
      row.addClass("ogantt-tags-field");
      this.chipList(row, here, field, reopen);
      if (field === "assignees") wireLinkHover(this.app, row, this, t.path);
    }

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

    // 依存（このタスクが待つ先行タスク）。× で外し（取り消せる）、「依存を追加…」で種類を選んで先行タスクを選ぶ。バー端のハンドルのドラッグと同じ操作
    // dependencies (the tasks this one waits on): × removes one (undoable), "Add dependency…" picks a type and then the predecessor; the same as dragging a bar's handle
    const depField = fieldRow(tr().fieldDeps);
    depField.addClass("ogantt-tags-field");
    for (const dep of t.deps) {
      const chip = depField.createSpan({ cls: "ogantt-tag-chip ogantt-dep-chip" });
      chip.createSpan({ cls: "ogantt-dep-chip-type", text: dep.type });
      chip.createSpan({ text: this.tasks.find((x) => x.path === dep.path)?.name ?? dep.path });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon", attr: { "aria-label": tr().undoRemoveDep(dep.type) } });
      setIcon(x, "x");
      x.onclick = () => void this.removeDep(here(), dep.path, dep.type).then(reopen);
    }
    const depType = depField.createEl("select", { cls: "dropdown ogantt-dep-type-select", attr: { "aria-label": tr().fieldDeps } });
    for (const ty of ["FS", "SS", "FF"] as DepType[]) depType.createEl("option", { value: ty, text: ty });
    const addDepBtn = depField.createEl("button", { cls: "ogantt-dep-add", text: tr().addDependency });
    addDepBtn.onclick = () => {
      // 自分・すでに先行のもの・自分の後続（選ぶと輪になる）は出さない / leave out itself, its predecessors and its successors (picking one would close a loop)
      const taken = new Set([t.path, ...t.deps.map((x) => x.path), ...successorClosure(this.tasks, t.path, true)]);
      new PickModal(this.app, this.tasks.filter((x) => !taken.has(x.path)), (x) => this.taskLabel(x), tr().addDependency, (pred) =>
        void this.addDep(pred.path, here(), depType.value as DepType).then(reopen)).open();
    };

    // 進捗 / progress（スライダー＋%表示。ドラッグ中は表示のみ更新、離したら保存＝バーに反映）
    // progress slider + % label; updates the label while dragging, saves on release (reflected in the bar)
    const progField = fieldRow(tr().fieldProgress);
    progField.addClass("ogantt-progress-field");
    if (t.cards) {
      // カードのあるカンバンは、チェックしたカードの割合が進捗（ボードでカードをチェックすると進む。ここでは編集しない）
      // a kanban with cards takes its progress from the share of checked cards (checking cards on the board moves it; not edited here)
      paintProgress(progField.createDiv(), t);
      progField.createDiv({ cls: "ogantt-progress-note", text: tr().kanbanProgress(t.cards.done, t.cards.total) });
    } else {
      const progRange = progField.createEl("input", { type: "range", attr: { "aria-label": tr().fieldProgress } });
      progRange.min = "0";
      progRange.max = "100";
      progRange.step = "5";
      progRange.value = String(t.progress ?? 0);
      const progVal = progField.createSpan({ cls: "ogantt-progress-val", text: `${progressPct(t) ?? 0}%` });
      progRange.addEventListener("input", () => progVal.setText(`${progRange.value}%`));
      progRange.addEventListener("change", () => void (async () => {
        const path = this.selectedPath;
        if (!path) return;
        // 0% は未設定として削除、それ以外は数値で保存 / drop at 0% (unset), otherwise store the number
        const n = Number(progRange.value);
        await this.mutate(tr().undoEdit(t.name), [path], () => writeField(this.app, path, k.progress, n > 0 ? n : undefined));
        await this.refresh();
      })());
    }

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

    // 本文 / body（既定は Obsidian と同じレンダリング表示。クリックで編集、フォーカスを外すと保存して表示に戻る）
    // body: rendered like Obsidian's reading view by default; click to edit, blur saves and returns to the rendered view
    // 一度だけ読む（カンバンは本文でなく中身全体から列を数える）/ read once (a kanban counts its lanes from the whole text, not the body)
    const file = this.app.vault.getAbstractFileByPath(t.path);
    const text = file instanceof TFile ? await this.app.vault.cachedRead(file) : "";
    let bodyText = bodyOf(text);
    if (seq !== this.detailSeq) return; // 読んでいる間に別の描画が始まった / a newer build started while reading
    this.panelSig = this.sigOf(t, bodyText);
    if (t.kind === "kanban") {
      // カンバンは列とカードを小さく並べるだけ（編集はクリックか Enter で開くボードで）。列とカードは進捗と同じ決まりで数える
      // a kanban shows its lanes and cards in miniature (a click or Enter opens the board to edit); lanes and cards follow the same rule as its progress
      d.createDiv({ cls: "ogantt-detail-label", text: tr().kindKanban });
      const board = d.createDiv({ cls: "ogantt-kanban", attr: { role: "button", tabindex: "0", "aria-label": tr().openAsNote } });
      if (!(file instanceof TFile)) return;
      for (const lane of kanbanLanes(this.app.metadataCache.getFileCache(file), text)) {
        const col = board.createDiv({ cls: "ogantt-kanban-lane" });
        col.createDiv({ cls: "ogantt-kanban-title", text: `${lane.title} · ${lane.cards.length}` });
        for (const c of lane.cards) col.createDiv({ cls: "ogantt-kanban-card" + (c.done ? " is-done" : ""), text: c.text });
      }
      board.onclick = (e) => this.openTask(here(), Keymap.isModEvent(e));
      board.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.openTask(here(), Keymap.isModEvent(e)); } };
      d.scrollTop = keepScroll;
      return;
    }
    d.createDiv({ cls: "ogantt-detail-label", text: tr().fieldBody });
    const bodyWrap = d.createDiv({ cls: "ogantt-detail-body" });
    const preview = bodyWrap.createDiv({ cls: "ogantt-detail-body-preview markdown-rendered" });
    const bodyArea = bodyWrap.createEl("textarea", { cls: "ogantt-detail-body-edit", attr: { "aria-label": tr().fieldBody } });

    const renderPreview = async (): Promise<void> => {
      if (seq !== this.detailSeq) return; // もう別のタスクを表示している / the panel shows another task by now
      preview.empty();
      // 描画ごとに持ち主を作り直し、前の描画の埋め込みや Dataview などを片付ける / a fresh owner per render unloads the previous render's embeds, Dataview blocks, …
      if (this.bodyOwner) this.removeChild(this.bodyOwner);
      this.bodyOwner = this.addChild(new Component());
      if (bodyText.trim()) await MarkdownRenderer.render(this.app, bodyText, preview, t.path, this.bodyOwner);
      else preview.createSpan({ cls: "ogantt-muted", text: tr().noneLabel });
    };
    await renderPreview();

    const autosize = () => {
      // 高さを一旦リセットしてから内容に合わせる / reset, then fit to content
      bodyArea.setCssStyles({ height: "auto" });
      bodyArea.setCssStyles({ height: `${bodyArea.scrollHeight + 2}px` });
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
        // 編集している間にノートがほかで書き換えられていたら知らせる（取り消せばその版に戻る）/ say so when the note changed elsewhere meanwhile (Undo brings that version back)
        if ((await readBody(this.app, path)) !== bodyText) new Notice(tr().bodyChangedElsewhere);
        bodyText = bodyArea.value;
        await this.mutate(tr().undoEdit(t.name), [path], () => writeBody(this.app, path, bodyText));
      }
      bodyWrap.removeClass("is-editing");
      await renderPreview();
    })());
    if (seq === this.detailSeq) d.scrollTop = keepScroll;
  }

  // タスクのノートを開く。ファイルで開くので、名前に # があっても見出しへのリンクと取り違えない
  // open a task's note by its file, so a "#" in the name isn't read as a link to a heading
  private openTask(path: string, newLeaf: PaneType | boolean): void {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) void this.app.workspace.getLeaf(newLeaf).openFile(f);
  }

  // 確認ダイアログを挟んでタスクを削除（ゴミ箱へ）/ confirm, then delete the task (to trash)
  private confirmDelete(path: string): void {
    const t = this.tasks.find((x) => x.path === path);
    if (!t) return;
    const hasChildren = this.tasks.some((x) => x.parent === path);
    // キャンバス型はリンク先の .canvas も一緒に消す（取り消せば両方戻る）。ほかのノートもリンクしているキャンバスは残す
    // a canvas task takes its .canvas along (undo brings both back), unless another note links to that canvas too
    const shared = !!t.canvas && Object.entries(this.app.metadataCache.resolvedLinks).some(([src, links]) => src !== path && !!links[t.canvas!]);
    const canvas = shared ? undefined : t.canvas;
    const files = canvas ? [path, canvas] : [path];
    const sub = [hasChildren ? tr().confirmDeleteChildren : "", canvas ? tr().confirmDeleteCanvas(canvas.split("/").pop()!) : ""].join(" ").trim();
    new ConfirmModal(this.app, {
      title: tr().confirmDeleteTitle,
      body: tr().confirmDeleteBody(t.name),
      sub: sub || undefined,
      confirmText: tr().menuDelete,
      cancelText: tr().cancel,
      onConfirm: () => void (async () => {
        const ok = await this.mutate(tr().undoDelete(t.name), files, async () => {
          const gone: string[] = [];
          for (const p of files) if (await deleteTask(this.app, p)) gone.push(p);
          return gone.length ? { deleted: gone } : false;
        });
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
      const val = chip.createEl("button", { cls: "ogantt-date-val", attr: { "data-focus": `date-${which}` } });
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
      const btn = wrap.createEl("button", { cls: "clickable-icon ogantt-time-btn", attr: { "data-focus": `time-${which}` } });
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
      state.start = state.start || dayToStr(this.today());
      state.end = dayToStr(endForDuration(dayIndex(state.start), n, cal));
      repaint();
      void save();
    });
    repaint();
  }

  // 時計アイコンのポップアップ：時・分（10分刻み）のドロップダウンで時刻を選ぶ。×で時刻クリア
  // clock-icon popup: pick a time with hour + minute (10-min steps) dropdowns; × clears the time
  private openTimeDropdown(anchor: HTMLElement, current: string, apply: (v: string) => void): void {
    const pad = (n: number): string => String(n).padStart(2, "0");
    openPopover(anchor, "ogantt-timepick", (pop, close) => {
      const set = /^\d{2}:\d{2}$/.test(current);
      const [ch, cm] = set ? current.split(":") : ["", "00"];
      const hourSel = pop.createEl("select", { cls: "dropdown", attr: { "aria-label": tr().fieldTime } });
      // 時刻が無いうちは「--」から始める（09 を選んでも変更として届く）/ with no time yet the hour starts at "--", so picking 09 still counts as a change
      if (!set) hourSel.createEl("option", { value: "", text: "--" });
      for (let h = 0; h < 24; h++) hourSel.createEl("option", { value: pad(h), text: pad(h) });
      hourSel.value = ch;
      pop.createSpan({ text: ":" });
      const minSel = pop.createEl("select", { cls: "dropdown", attr: { "aria-label": tr().fieldTime } });
      for (let m = 0; m < 60; m += 10) minSel.createEl("option", { value: pad(m), text: pad(m) });
      // 10分刻みに乗らない既存値（手動入力等）も選べるように / keep an off-grid minute (manual entry) selectable
      if (!minSel.querySelector(`option[value="${cm}"]`)) minSel.createEl("option", { value: cm, text: cm });
      minSel.value = cm;
      const onPick = () => { if (hourSel.value) apply(`${hourSel.value}:${minSel.value}`); };
      hourSel.addEventListener("change", onPick);
      minSel.addEventListener("change", onPick);
      const clr = pop.createEl("button", { cls: "clickable-icon" });
      setIcon(clr, "x");
      clr.setAttr("aria-label", tr().clearDate);
      clr.onclick = () => { apply(""); close(); };
    });
  }

  // 非 name 列のセルを描き、読み取り専用でなければダブルクリックの編集を付ける
  // paint a non-name cell and, unless it's read-only, attach the double-click editor
  private renderCell(td: HTMLElement, row: Row, col: CellColumn): void {
    if (col.paint(this.board, td, row) === false) return;
    td.dataset.label = col.label(); // セル内の入力欄の名前 / names the in-cell editor
    td.dataset.focus = `${row.task!.path}|${col.id}`; // 描き直した後もポップオーバーからフォーカスが戻れる印 / lets a popover return focus to the cell after a redraw
    this.makeEditableCell(td, col.editAria(), (cell) => col.edit(this.board, cell, row));
  }

  // 列定義などの部品に渡す窓口（GanttView 全体は渡さない）/ the surface handed to parts like column defs (never the whole view)
  private boardCtx: BoardContext | null = null;
  private get board(): BoardContext {
    if (!this.boardCtx) {
      const settings = () => this.plugin.settings;
      const rollup = () => this.rollup;
      const groupBy = () => this.groupBy;
      this.boardCtx = {
        app: this.app,
        get settings() { return settings(); },
        get rollup() { return rollup(); },
        get groupBy() { return groupBy(); },
        mutate: (label, paths, fn) => this.mutate(label, paths, fn),
        reschedule: (path, next, times) => this.reschedule(path, next, times),
        refresh: () => this.refresh(),
        inlineInput: (cell, value, repaint, commit, configure) => this.inlineInput(cell, value, repaint, commit, configure),
        openRangePicker: (anchor, state, active, repaint, save, single) => this.openRangePicker(anchor, state, active, repaint, save, single),
        chipList: (host, path, field, changed) => this.chipList(host, () => path, field, changed),
        paintTagChip: (chip, tag) => this.paintTagChip(chip, tag),
        openTagMenu: (e, tag) => this.openStyleMenu(e, "tag", tag),
        avatar: (parent, who) => this.avatar(parent, who),
      };
    }
    return this.boardCtx;
  }

  // ----- セルの直接編集 / in-cell editing -----
  // 方針：テーブルに表示できる列はすべてダブルクリックで直接編集できる。
  // 列は src/columns.ts の ColumnDef として定義する（paint と edit が必須＝描画とエディタが必ずセットになる）。
  // Policy: every column the table can show is editable in place via double-click.
  // Columns are ColumnDefs in src/columns.ts, where paint and edit are both required, so a renderer never ships without its editor.
  private makeEditableCell(cell: HTMLElement, aria: string, edit: (cell: HTMLElement) => void): void {
    cell.addClass("ogantt-td-editable");
    cell.setAttr("aria-label", aria);
    // シングルクリックは行を選ぶだけで詳細は開かない（編集はダブルクリック）。編集中の入力欄やリンクのクリックはそのまま
    // a single click just selects the row, without opening the panel (double-click edits); clicks in an open editor or on a link pass through
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest("input, select, textarea, button, a")) return;
      const tr = cell.closest<HTMLElement>(".ogantt-tr");
      if (tr) this.focusRow(Number(tr.dataset.index));
    });
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
    const inp = cell.createEl("input", { type: "text", cls: "ogantt-cell-input", attr: { "aria-label": cell.dataset.label ?? tr().fieldName } });
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
      // 書いても何も変わらなかったとき（同じ値など）は描き直されないので、自分で入力欄を閉じる
      // when the write changed nothing (the same value, …) no redraw follows, so the editor closes itself
      void commit(v).finally(() => { if (inp.isConnected) repaint(); });
    };
    inp.addEventListener("keydown", (e) => {
      if (composing(e) || (e.key !== "Enter" && e.key !== "Escape")) return;
      e.preventDefault();
      const row = cell.closest<HTMLElement>(".ogantt-tr");
      if (e.key === "Enter") save();
      else cancel();
      // キーボードで終えたら行へ戻る（矢印キーで続けて動ける）/ finishing from the keyboard returns to the row, so the arrow keys keep working
      if (row?.isConnected && !cell.contains(activeDocument.activeElement)) row.focus({ preventScroll: true });
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
  // Vault 全体を走査するので、欄に初めてフォーカスしたときに集めて次の再読込まで使い回す
  // it scans the whole vault, so the list is gathered on the field's first focus and reused until the next refresh
  private attachSingleTagSuggestions(inp: HTMLInputElement, exclude: string[] = []): void {
    inp.addEventListener("focus", () => {
      const all = (this.tagCache ??= collectAllTags(this.app)).filter((x) => !exclude.includes(x));
      if (all.length) this.attachSuggestions(inp, (list) => all.forEach((tag) => list.createEl("option", { value: tag })));
    }, { once: true });
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
    openPopover(anchor, "ogantt-cal", (cal, close) => {
      const todayStr = dayToStr(this.today());
      const base = state[active] || state.start || state.end || todayStr;
      let y = parseInt(base.slice(0, 4), 10);
      let m = parseInt(base.slice(5, 7), 10); // 1-based
      let act = active; // 次のクリックで設定する端点 / endpoint the next click sets
      // ロケールの曜日略称を、ロケールの週の始まり（日曜・月曜など）から / localized minimal weekday names, from the locale's first day of the week
      const firstDay = moment.localeData().firstDayOfWeek();
      const wk = [...moment.weekdaysMin().slice(firstDay), ...moment.weekdaysMin().slice(0, firstDay)];
      const monthTitle = dateFormat({ year: "numeric", month: "long" }); // 表示言語の「2026年10月」「October 2026」/ the UI language's month title

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
        const prev = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().previous } });
        setIcon(prev, "chevron-left");
        prev.onclick = () => { if (--m < 1) { m = 12; y--; } render(); };
        // タイトルをクリックで年ビューへ / click the title to open the year view
        const title = head.createEl("button", { cls: "ogantt-cal-title", text: monthTitle.format(Date.UTC(y, m - 1, 1)) });
        title.onclick = () => { mode = "year"; render(); };
        const next = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().next } });
        setIcon(next, "chevron-right");
        next.onclick = () => { if (++m > 12) { m = 1; y++; } render(); };

        cal.createDiv({ cls: "ogantt-cal-active", text: `▸ ${single ?? (act === "start" ? tr().fieldStart : tr().fieldDue)}` });

        const wkRow = cal.createDiv({ cls: "ogantt-cal-wk" });
        wk.forEach((w) => wkRow.createSpan({ text: w }));

        const grid = cal.createDiv({ cls: "ogantt-cal-grid" });
        const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() - firstDay + 7) % 7; // 1 日の前の空き / blanks before the 1st
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
        const prev = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().previous } });
        setIcon(prev, "chevron-left");
        prev.onclick = () => { y--; render(); }; // ← → で年移動 / year nav
        head.createSpan({ cls: "ogantt-cal-title", text: `${y}` });
        const next = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tr().next } });
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

      // 描き直してもキーボードの位置を保つ：同じ名前（aria-label か文字）のボタンへ戻す / keep the keyboard's place across a rebuild: back to the button of the same name
      const render = () => {
        const was = cal.ownerDocument.activeElement;
        const name = was && cal.contains(was) ? was.getAttribute("aria-label") ?? was.textContent : null;
        cal.empty();
        if (mode === "year") renderYear();
        else renderDay();
        if (name != null) (Array.from(cal.querySelectorAll<HTMLElement>("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent) === name) ?? cal.querySelector<HTMLElement>("button"))?.focus();
      };
      render();
    });
  }

  // 詳細パネルの幅をドラッグで変更（幅は記憶）/ drag to resize the detail panel (width persisted)
  private attachResize(resizer: HTMLElement, panel: HTMLElement): void {
    resizer.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.preventDefault();
      resizer.setPointerCapture(ev.pointerId);
      const board = this.contentEl.getBoundingClientRect();
      const onMove = (e: PointerEvent) => {
        const w = Math.max(280, Math.min(board.width - 320, board.right - e.clientX)); // ボードに 320px は残す / leave the board 320px
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

  // バーのホバーカード（名前・日付・期間・ステータス・進捗・担当者）。マウスだけで、少し止まってから出す
  // the bar hover card (name, dates, duration, status, progress, assignees); mouse only, shown after a short pause
  private showCard(t: Task, e: PointerEvent): void {
    if (e.pointerType !== "mouse" || this.dragPath) return;
    this.moveCard(e);
    if (this.card.timer != null) window.clearTimeout(this.card.timer);
    this.card.timer = window.setTimeout(() => {
      this.card.timer = null;
      const doc = this.contentEl.ownerDocument;
      if (this.card.el?.ownerDocument !== doc) {
        this.card.el?.remove();
        this.card.el = doc.body.createDiv({ cls: "ogantt-card" });
      }
      const card = this.card.el;
      const s = this.plugin.settings;
      card.empty();
      card.createDiv({ cls: "ogantt-card-title", text: t.name });
      const line = (label: string, value: string) => {
        const r = card.createDiv({ cls: "ogantt-card-row" });
        r.createSpan({ cls: "ogantt-card-label", text: label });
        r.createSpan({ text: value });
      };
      const start = anchorStart(t);
      const end = anchorEnd(t);
      if (start || end) line(tr().fieldDates, start && end && start !== end ? `${formatDate(start, s.dateFormat)} → ${formatDate(end, s.dateFormat)}` : formatDate((start ?? end)!, s.dateFormat));
      const days = t.milestone ? undefined : taskDuration(t, scheduleOptions(s).cal);
      if (days != null) line(tr().colDuration, tr().durationDays(days));
      const st = s.statuses.find((x) => x.id === t.status);
      if (st) line(tr().fieldStatus, st.label);
      const pct = progressPct(t);
      if (t.cards) line(tr().fieldProgress, `${pct ?? 0}% · ${tr().kanbanProgress(t.cards.done, t.cards.total)}`);
      else if (pct != null) line(tr().fieldProgress, `${pct}%`);
      if (t.assignees.length) line(tr().fieldAssignee, t.assignees.map(linkLabel).join(", "));
      if (t.tags.length) line(tr().fieldTags, t.tags.join(", "));
      card.addClass("is-visible");
      this.placeCard();
    }, 300);
  }

  private moveCard(e: PointerEvent): void {
    this.card.x = e.clientX;
    this.card.y = e.clientY;
    if (this.card.el?.hasClass("is-visible")) this.placeCard();
  }

  // カーソルの右下に置き、画面からはみ出すなら左・上へ / place it below-right of the cursor, flipping left or up at the window edge
  private placeCard(): void {
    const card = this.card.el;
    if (!card) return;
    const win = card.ownerDocument.defaultView ?? window;
    const { x, y } = this.card;
    card.style.left = `${x + 14 + card.offsetWidth > win.innerWidth ? x - card.offsetWidth - 10 : x + 14}px`;
    card.style.top = `${y + 18 + card.offsetHeight > win.innerHeight ? y - card.offsetHeight - 10 : y + 18}px`;
  }

  private hideCard(): void {
    if (this.card.timer != null) window.clearTimeout(this.card.timer);
    this.card.timer = null;
    this.card.el?.removeClass("is-visible");
  }

  // ----- PNG に書き出す / export as PNG -----
  // 画面外の行も含めたボード全体（名前の列・日付軸・バー・矢印・色の凡例）を 1 枚の SVG に描き、キャンバスで PNG にして添付ファイルの
  // 置き場所へ保存する。バーや矢印は画面と同じ関数と CSS で描くので、見た目（テーマの色・表示メニューの設定）もそのまま
  // draws the whole board, off-screen rows included (name column, date axis, bars, arrows, colour key), into one SVG, turns it into a PNG on
  // a canvas and saves it where the vault keeps attachments. Bars and arrows use the screen's own drawing code and CSS, so the look
  // (theme colours, the Display menu's switches) carries over
  async exportPng(): Promise<void> {
    // 画面が空の状態（絞り込みで何も出ない・タスクが無い）なら書き出さず、そう伝える / while the board shows its empty state there is nothing to export: say so
    if (!this.boardMain) return void new Notice(this.tasks.length ? tr().noMatches : tr().emptyMessage(this.folder || tr().vaultRoot));
    if (this.exporting) return; // 書き出しは一度に 1 つ / one export at a time
    this.exporting = true;
    // 名前は最初に決める（途中でボードを切り替えても、描いたボードの名前で保存する）/ named up front, so switching boards mid-export can't rename it
    const name = `Gantt ${this.folder.split("/").pop() || tr().vaultRoot} ${dayToStr(this.today())}.png`;
    try {
      const blob = await this.rasterise(this.exportSvg());
      // 添付ファイルの置き場所へ。"/" を渡すと、相対の設定も適当なノートではなく Vault のルートから決まる
      // where the vault keeps attachments; "/" makes a relative setting resolve from the vault root rather than from some note
      const path = await this.app.fileManager.getAvailablePathForAttachment(name, "/");
      const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
      this.buttonNotice(tr().exportDone(file.path), tr().exportOpen, () => void this.app.workspace.getLeaf("tab").openFile(file), 8000);
    } catch (e) {
      console.error(e);
      new Notice(tr().exportFailed);
    } finally {
      this.exporting = false;
    }
  }

  // 書き出す SVG：ボード全体（画面外の行も）・名前の列・日付軸・色の凡例。バーと矢印は画面と同じ関数と CSS で描く。
  // 文字は SVG 画像の中でも使えるシステムフォントにそろえ、幅も同じフォントで測る（ページの Web フォントは画像では使えない）
  // the SVG to export: the whole board (off-screen rows too), name column, date axis and colour key. Bars and arrows use the screen's own
  // drawing code and CSS. Text uses a system font that also exists inside an SVG image, and is measured in it (the page's web fonts don't)
  private exportSvg(): SVGSVGElement {
    const screenFont = this.fontFamily;
    this.fontFamily = EXPORT_FONT;
    this.bare = true;
    // 書き出しはタスクの範囲だけ（スクロールで足した日は含めない）/ the export covers the tasks' range only (not the days added by scrolling)
    const shown = this.range;
    this.range = this.baseRange;
    try {
      const PAD = 16;
      const TITLE_H = 34;
      const NAME_W = Math.max(200, this.colW("name"));
      const width = (this.range.max - this.range.min + 1) * this.ppd;
      const bodyH = this.rows.length * ROW_H;
      const svg = this.svgEl("svg", { "font-family": EXPORT_FONT });
      const bg = svg.appendChild(this.svgEl("rect", { class: "x-bg" }));
      const text = (parent: SVGElement, x: number, y: number, cls: string, value: string) => {
        parent.appendChild(this.svgEl("text", { x, y, class: cls })).textContent = value;
      };
      text(svg, PAD, PAD + 20, "x-title", `${this.folder || tr().vaultRoot} — ${formatDate(dayToStr(this.today()), this.plugin.settings.dateFormat)}`);
      const top = PAD + TITLE_H;
      // 日付軸 / the date axis
      const zoom = this.tickZoom();
      const { ticks, bands } = this.axisMarks(zoom);
      const axis = svg.appendChild(this.svgEl("g", { transform: `translate(${PAD + NAME_W},${top})` }));
      for (const b of bands) text(axis, b.x + 4, 14, "x-band", b.label);
      for (const tk of ticks) {
        axis.appendChild(this.svgEl("line", { x1: tk.x, y1: HEAD_H / 2, x2: tk.x, y2: HEAD_H, class: "x-line" }));
        text(axis, tk.x + 3, HEAD_H - 7, tk.major ? "x-tick is-major" : "x-tick", tk.label);
      }
      // 行：名前の列の見出しの背景・区切り線・名前（名前の列の幅で切る）/ rows: heading backgrounds in the name column, separators, names (clipped to the column)
      const body = svg.appendChild(this.svgEl("g", { transform: `translate(${PAD},${top + HEAD_H})` }));
      this.defs(svg).appendChild(this.svgEl("clipPath", { id: "x-names" })).appendChild(this.svgEl("rect", { width: NAME_W - 8, height: bodyH }));
      const names = this.svgEl("g", { "clip-path": "url(#x-names)" });
      this.rows.forEach((row, i) => {
        const y = i * ROW_H;
        if (row.kind === "group") body.appendChild(this.svgEl("rect", { y, width: NAME_W, height: ROW_H, class: "ogantt-grid-group" }));
        body.appendChild(this.svgEl("line", { x1: 0, y1: y + ROW_H - 0.5, x2: NAME_W + width, y2: y + ROW_H - 0.5, class: "x-line" }));
        // 名前は画面と同じ位置（タスクは開閉の印の枠のぶん右）。バーの後ろに名前を書かないので、完了の ✓ はその枠に、キャンセルは名前に取り消し線
        // names sit where they do on screen (a task after its chevron slot); since no name follows the bar, a completed task's ✓ fills that slot and a cancelled one is struck through here
        const x = this.indentOf(row);
        const cy = y + ROW_H / 2 + 4;
        if (row.kind === "group") text(names, x, cy, "x-name is-group", row.group);
        else {
          const st = statusGroupOf(this.plugin.settings.statuses, row.task!.status);
          if (st === "completed") text(names, x, cy, "x-name", "✓");
          text(names, x + 16, cy, st === "cancelled" ? "x-name is-cancelled" : "x-name", row.task!.name);
        }
      });
      body.appendChild(names);
      // 時間軸：休日の網掛け・見出しの背景・今日の線・バー・矢印（画面と同じ重なり順）/ the timeline: non-working days, heading backgrounds, today, bars, arrows (stacked as on screen)
      const tl = svg.appendChild(this.svgEl("g", { transform: `translate(${PAD + NAME_W},${top + HEAD_H})` }));
      tl.appendChild(this.svgEl("line", { x1: 0, y1: -HEAD_H, x2: 0, y2: bodyH, class: "x-line" }));
      if (zoom !== "Month") {
        const cal = scheduleOptions(this.plugin.settings).cal;
        for (let d = this.range.min; d <= this.range.max; d++) {
          if (!isWorkday(d, cal)) tl.appendChild(this.svgEl("rect", { x: (d - this.range.min) * this.ppd, width: this.ppd, height: bodyH, class: "x-off" }));
        }
      }
      const groupBg = tl.appendChild(this.svgEl("g", {}));
      this.drawToday(tl, width, bodyH);
      this.drawCopyLinks(tl);
      const depLayer = tl.appendChild(this.svgEl("g", {}));
      const barLayer = tl.appendChild(this.svgEl("g", {}));
      if (this.progressLine) this.drawProgressLine(tl, width, bodyH);
      const fill = this.barFill(svg);
      this.rows.forEach((row, i) => {
        if (row.kind === "group") this.drawGroupRow(groupBg, barLayer, row, i, width);
        else this.drawBar(barLayer, svg, row, i, fill, null);
      });
      if (this.showDeps) for (const dep of this.depRows()) this.drawDep(depLayer, dep);
      // ラベルとタグは時間軸の右端より先まで伸びることがあるので、描いたものを測って画像の幅を決める。
      // 測るあいだは埋め込み CSS を入れない（ページには同じ CSS が既にあり、入れるとアプリ全体のスタイルを計算し直させる）
      // labels and tags can run past the timeline's end, so measure what was drawn to size the image. The embedded CSS stays out while
      // measuring (the page already has the same CSS, and inserting it would restyle the whole app)
      const doc = this.contentEl.ownerDocument;
      svg.setAttribute("style", "position: fixed; left: -100000px; top: 0; visibility: hidden");
      doc.body.appendChild(svg);
      const box = tl.getBBox();
      svg.remove();
      svg.removeAttribute("style");
      const W = PAD * 2 + NAME_W + Math.max(width, Math.ceil(box.x + box.width));
      // 色の凡例は画像の幅で折り返す / the colour key wraps to the image's width
      const keyTitle = this.colorBy === "status" ? tr().fieldStatus : tr().fieldAssignee;
      let kx = this.textWidth(keyTitle, KEY_PX, 600) + 14;
      let ky = 0;
      const key = this.colorKey().map(({ color, label }) => {
        const w = 32 + this.textWidth(label, KEY_PX);
        if (kx + w > W - PAD * 2) {
          kx = 0;
          ky += 20;
        }
        const at = { color, label, x: kx, y: ky };
        kx += w;
        return at;
      });
      const H = PAD * 2 + TITLE_H + HEAD_H + bodyH + (key.length ? ky + 40 : 0);
      for (const el of [svg, bg]) {
        el.setAttribute("width", String(W));
        el.setAttribute("height", String(H));
      }
      if (key.length) {
        const g = svg.appendChild(this.svgEl("g", { transform: `translate(${PAD},${top + HEAD_H + bodyH + 24})` }));
        text(g, 0, 4, "x-key is-title", keyTitle);
        for (const k of key) {
          g.appendChild(this.svgEl("rect", { x: k.x, y: k.y - 6, width: 11, height: 11, rx: 3, fill: k.color }));
          text(g, k.x + 16, k.y + 4, "x-key", k.label);
        }
      }
      svg.insertBefore(this.svgEl("style", {}), svg.firstChild).textContent = this.exportCss();
      return svg;
    } finally {
      this.fontFamily = screenFont;
      this.bare = false;
      this.range = shown;
    }
  }

  // SVG を PNG に。キャンバスの上限（一辺・面積。スマホはずっと小さい）に収まるよう縮める
  // turns the SVG into a PNG, scaled to fit the canvas limits (per side and in area; much smaller on phones)
  // ponytail: a very large board comes out below 1x; filter or collapse groups first for a sharper image
  private async rasterise(svg: SVGSVGElement): Promise<Blob> {
    const W = Number(svg.getAttribute("width"));
    const H = Number(svg.getAttribute("height"));
    // XML として不正な制御文字（ファイル名などに紛れ込みうる）は画像の読み込みを壊すので除く / XML-invalid control characters (possible in file names) would break the image, so drop them
    const xml = new XMLSerializer().serializeToString(svg).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    const canvas = createEl("canvas");
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(2, 16384 / W, 16384 / H, Math.sqrt((Platform.isMobile ? 16e6 : 3e7) / (W * H)));
      canvas.width = Math.round(W * scale);
      canvas.height = Math.round(H * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2D canvas");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, W, H);
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
      if (!blob) throw new Error("the canvas gave no PNG");
      return blob;
    } finally {
      URL.revokeObjectURL(url);
      canvas.width = canvas.height = 0; // 大きなキャンバスのメモリをすぐ手放す / release the big canvas right away
    }
  }

  // 書き出す SVG に埋め込む CSS：このプラグインのルールと、そこで使う CSS 変数の今の値（テーマの色）
  // the CSS embedded in the exported SVG: this plugin's rules plus the current values of the CSS variables they use (the theme's colours)
  private exportCss(): string {
    const rules = [
      ".x-bg { fill: var(--background-primary); }",
      ".x-title { font-size: 15px; font-weight: 600; fill: var(--text-normal); }",
      ".x-name { font-size: 12px; fill: var(--text-normal); }",
      ".x-name.is-group, .x-key.is-title, .x-tick.is-major, .x-band { font-weight: 600; fill: var(--text-normal); }",
      ".x-name.is-cancelled { text-decoration: line-through; opacity: 0.55; }",
      ".x-line { stroke: var(--background-modifier-border-hover); }",
      ".x-tick, .x-band { font-size: 10px; }",
      ".x-tick { fill: var(--text-muted); }",
      ".x-off { fill: var(--ogantt-offday); }",
      `.x-key { font-size: ${KEY_PX}px; fill: var(--text-muted); }`,
    ];
    // このビューの文書から（ポップアウトでもその窓の）.ogantt- のルールだけ。窓ごとに型が別なので instanceof では判定しない
    // only the .ogantt- rules, from this view's own document (its own window when popped out); each window has its own types, so no instanceof
    for (const sheet of Array.from(this.contentEl.ownerDocument.styleSheets)) {
      try {
        for (const r of Array.from(sheet.cssRules)) if ((r as Partial<CSSStyleRule>).selectorText?.includes(".ogantt-")) rules.push(r.cssText);
      } catch {
        // 読めない（別オリジンの）シートは飛ばす / skip a sheet that can't be read (another origin)
      }
    }
    const css = rules.join("\n");
    const cs = getComputedStyle(this.contentEl);
    const vars = [...new Set(css.match(/--[\w-]+/g) ?? [])].map((v) => `${v}: ${cs.getPropertyValue(v).trim() || "initial"};`).join(" ");
    return `svg { ${vars} }\n${css}`;
  }

  // SVG 要素生成ヘルパー（Obsidian の createSvg を使用）/ SVG element helper (uses Obsidian's createSvg)
  private svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
    const el = createSvg(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }
}
