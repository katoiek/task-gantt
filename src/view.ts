import { App, ItemView, Menu, Modal, WorkspaceLeaf, setIcon, Notice, TFile, ViewStateResult, moment } from "obsidian";
import type GanttPlugin from "./main";
import { Task, Row, ZoomMode, DepType, GanttViewState, VIEW_TYPE_GANTT } from "./types";
import {
  collectTasks,
  collectFolders,
  buildRows,
  createTask,
  reparentTask,
  subtreePaths,
  writeDates,
  writeField,
  writeBody,
  renameTask,
  deleteTask,
  addTag,
  removeTag,
  addDependency,
  removeDependency,
  readBody,
  anchorStart,
  anchorEnd,
} from "./model";
import {
  DateRange,
  computeRange,
  dayIndex,
  dayToStr,
  pxPerDay,
  buildTicks,
  todayIndex,
  formatDate,
} from "./timeline";
import { t as tr } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var

const ROW_H = 30; // 行の高さ（表とタイムラインで共通）/ shared row height
const HEAD_H = 40; // ヘッダー高さ / header height
const BAR_PAD = 5; // バーの上下余白 / vertical padding inside a row
const RESIZE_EDGE = 8; // バー端リサイズの当たり幅 / edge-resize hit width
const MIN_PPD = 2; // Fit 時の最小 1 日幅（これ未満は横スクロール）/ minimum px/day in Fit mode
const FIT_SCROLLBAR_PAD = 16; // 縦スクロールバー分の余白 / room for the vertical scrollbar
const FALLBACK_BAR = "#7c8db5"; // ステータス/担当者が未設定のときのバー色 / bar color when status/assignee is unset

// テーブル列の定義 / table column definitions
// name は常時表示・可変幅(flex)、その他は表示/非表示を切替え・固定幅
// `name` is always shown and flexes; the rest are toggleable with a fixed width
type ColumnId = "name" | "start" | "end" | "assignee" | "status" | "tags";
const COLUMN_ORDER: ColumnId[] = ["name", "start", "end", "assignee", "status", "tags"];
const OPTIONAL_COLUMNS: ColumnId[] = ["start", "end", "assignee", "status", "tags"]; // 歯車で出し分けできる列 / toggleable columns
const COLUMN_WIDTHS: Record<ColumnId, number> = { name: 160, start: 84, end: 84, assignee: 96, status: 96, tags: 140 };
const MAX_INDENT_DEPTH = 8; // インデントの段数上限（論理ツリーは無制限）/ visual indent cap (the tree itself is unlimited)

// HSL → #rrggbb（カラーピッカーの初期値に hex が要るため）/ HSL → hex (color inputs need hex)
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// 名前から安定した色を生成（担当者/タグ/フォルダ共通・同じ名前は常に同じ色）/ deterministic color from any name (assignee/tag/folder)
function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return hslToHex(h, 55, 55);
}

export class GanttView extends ItemView {
  plugin: GanttPlugin;
  private zoom: ZoomMode;
  private tasks: Task[] = [];
  private rows: Row[] = [];
  private range: DateRange = { min: 0, max: 0 };
  private ppd = 16;
  private selectedPath: string | null = null;
  private folder = ""; // 表示対象フォルダ / scoped folder path
  private collapsed = new Set<string>(); // 折りたたみ中フォルダのキー / collapsed folder keys

  // 表示オプション（ビューを開いている間だけ保持）/ view options (kept while the view is open)
  private colorBy: "status" | "assignee" = "status";
  private groupBy: "folder" | "status" | "assignee" | "tag" = "folder";
  private filterStatus = ""; // "" = すべて / all
  private filterAssignee = ""; // "" = すべて / all
  private filterTag = ""; // "" = すべて / all
  private showEmptyFolders = true; // 空フォルダも行として表示（既定ON）/ show empty folders as rows (default on)
  private flat = false; // フラット表示（フォルダ/親子を無視し全タスク一覧）/ flat list ignoring folders & nesting
  private rollup = false; // 親タスクのバーを子孫の集約で描く（既定OFF）/ draw parent bars as a rollup of descendants (default off)
  private allFolders: string[][] = []; // スコープ配下の全フォルダ（相対セグメント）/ all folders under scope
  private optionsHost!: HTMLElement; // フィルタ/グループ/凡例の差し替え先 / options + legend container

  // 取り消し履歴：操作前のファイル内容スナップショットと/またはファイル移動(from→to の配列)
  // undo history: a pre-op content snapshot and/or file moves (array of from → to)
  private undoStack: { label: string; files?: Map<string, string>; moves?: { from: string; to: string }[] }[] = [];
  private static readonly UNDO_LIMIT = 50;

  // バーがドラッグされたか（ドラッグ直後のクリック抑止用）/ whether a bar was dragged (to suppress the trailing click)
  private dragged = new WeakMap<SVGGElement, boolean>();

  // Fit モードでペイン幅に追従するための再描画タイマー / debounce timer to re-fit in Fit mode
  private fitTimer: number | null = null;

  // DOM 参照 / DOM refs
  private tbodyEl!: HTMLElement;
  private gridHost!: HTMLElement;
  private detailEl!: HTMLElement;
  private undoBtn: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GanttPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.zoom = plugin.settings.defaultZoom;
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
    if (state && typeof state.folder === "string") this.folder = state.folder;
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
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh()));
    // Ctrl/Cmd+Z で取り消し（入力欄にフォーカス中はネイティブ undo を優先）
    // Ctrl/Cmd+Z to undo (defer to native undo while an input is focused)
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return;
      const ae = activeDocument.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;
      e.preventDefault();
      void this.undo();
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
    this.renderToolbar(root);
    this.optionsHost = root.createDiv({ cls: "ogantt-options" }); // 中身は rerender で差し替え / repopulated on rerender
    this.gridHost = root.createDiv({ cls: "ogantt-host" });
    this.detailEl = root.createDiv({ cls: "ogantt-detail" });
  }

  private refreshTimer: number | null = null;
  private scheduleRefresh(): void {
    if (this.refreshTimer != null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refresh(), 300);
  }

  // ビューを閉じたら保留中のタイマーを止める（破棄後の再描画を防ぐ）/ stop the pending timer on close
  async onClose(): Promise<void> {
    if (this.refreshTimer != null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.fitTimer != null) {
      window.clearTimeout(this.fitTimer);
      this.fitTimer = null;
    }
    activeDocument.querySelectorAll(".ogantt-cal, .ogantt-colmenu").forEach((e) => e.remove()); // 開いたままのポップオーバーを掃除 / drop any open popover
  }

  // ディスクから集計し直して再描画 / re-collect from disk, then render
  async refresh(): Promise<void> {
    if (!this.gridHost) this.buildSkeleton();
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.allFolders = collectFolders(this.app, this.plugin.settings, this.folder);
    this.rerender();
  }

  // メモリ上の this.tasks から描画（ディスクは読まない）/ render from in-memory tasks (no disk read)
  // ドラッグや整列の直後、metadataCache 更新前に正しい位置を即表示するため / shows correct positions before metadataCache updates
  rerender(): void {
    if (!this.gridHost) this.buildSkeleton();
    this.renderOptions(); // フィルタ/グループ/凡例を最新データで更新 / refresh options + legend
    const view = this.processTasks(); // フィルタ＋グループ適用後 / after filter + group remap
    const compare = this.taskComparator();
    if (this.flat) {
      // フラット：フォルダも親子も無視して全タスクを1本のソート済みリストに / flat: one sorted list, no grouping/nesting
      this.rows = view.slice().sort(compare).map((task) => ({ kind: "task", group: "", depth: 0, task } as Row));
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

  // ----- テーブル列 / table columns -----
  // 表示中の列（name は常時、その他は設定の visibleColumns に従う）/ visible columns (name always; rest per settings)
  private visibleColumns(): ColumnId[] {
    const vis = new Set(this.plugin.settings.visibleColumns ?? []);
    return COLUMN_ORDER.filter((id) => id === "name" || vis.has(id));
  }
  // 表全体の幅（表示中の列幅の合計）/ total table width (sum of visible column widths)
  private tableWidth(): number {
    return this.visibleColumns().reduce((w, id) => w + COLUMN_WIDTHS[id], 0);
  }
  // 列ヘッダのラベル / column header label
  private colLabel(id: ColumnId): string {
    switch (id) {
      case "name": return tr().colTask;
      case "start": return tr().colStart;
      case "end": return tr().colDue;
      case "assignee": return tr().fieldAssignee;
      case "status": return tr().fieldStatus;
      case "tags": return tr().fieldTags;
    }
  }
  // 現在のソート設定からタスク比較関数を作る / build a task comparator from the current sort settings
  private taskComparator(): (a: Task, b: Task) => number {
    const by = this.plugin.settings.sortBy as ColumnId;
    const dir = this.plugin.settings.sortDir === "desc" ? -1 : 1;
    // ステータスは設定の定義順（アルファベット順ではない）/ status sorts by the configured order, not alphabetically
    const statusOrder = new Map(this.plugin.settings.statuses.map((s, i) => [s.id, i]));
    const key = (t: Task): string | number => {
      switch (by) {
        case "name": return t.name.toLowerCase();
        case "start": return anchorStart(t) ?? "9999-99-99";
        case "end": return anchorEnd(t) ?? "9999-99-99";
        case "assignee": return (t.assignee ?? "").toLowerCase();
        case "status": return t.status != null ? statusOrder.get(t.status) ?? 999 : 999;
        case "tags": return t.tags.join(",").toLowerCase();
        default: return anchorStart(t) ?? "9999-99-99";
      }
    };
    return (a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      return c * dir;
    };
  }

  // 列ヘッダクリックでソート列/方向を切替えて永続化 / clicking a header toggles sort column/direction (persisted)
  private toggleSort(id: ColumnId): void {
    const s = this.plugin.settings;
    if (s.sortBy === id) s.sortDir = s.sortDir === "asc" ? "desc" : "asc";
    else {
      s.sortBy = id;
      s.sortDir = "asc";
    }
    void this.plugin.saveData(s);
    this.rerender();
  }

  // 列の表示/非表示を切替えて永続化 / toggle a column's visibility and persist
  private setColumnVisible(id: ColumnId, on: boolean): void {
    const set = new Set(this.plugin.settings.visibleColumns ?? []);
    if (on) set.add(id);
    else set.delete(id);
    this.plugin.settings.visibleColumns = OPTIONAL_COLUMNS.filter((c) => set.has(c)); // マスター順を維持 / keep master order
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 列の出し分けポップオーバー（チェックボックス）/ column-visibility popover (checkboxes)
  private openColumnMenu(anchor: HTMLElement): void {
    activeDocument.querySelectorAll(".ogantt-colmenu").forEach((e) => e.remove());
    const menu = activeDocument.body.createDiv({ cls: "ogantt-colmenu" });
    for (const id of OPTIONAL_COLUMNS) {
      const item = menu.createEl("label", { cls: "ogantt-colmenu-item" });
      const cb = item.createEl("input", { type: "checkbox" });
      cb.checked = (this.plugin.settings.visibleColumns ?? []).includes(id);
      item.createSpan({ text: this.colLabel(id) });
      cb.addEventListener("change", () => this.setColumnVisible(id, cb.checked));
    }
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
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
    activeDocument.addEventListener("pointerdown", onOutside, true);
    activeDocument.addEventListener("keydown", onKey, true);
  }

  // ----- ツールバー / toolbar -----
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ogantt-toolbar" });
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
    const todayBtn = bar.createEl("button", { cls: "ogantt-today-btn", text: tr().today });
    todayBtn.onclick = () => this.scrollToToday();
    (["Day", "Week", "Month", "Fit"] as ZoomMode[]).forEach((z) => {
      const btn = bar.createEl("button", { text: z });
      if (z === this.zoom) btn.addClass("is-active");
      btn.onclick = () => {
        this.zoom = z; // ppd は rerender 内の computePpd() が決める / ppd is set by computePpd() in rerender
        bar.querySelectorAll("button.is-active").forEach((b) => b.removeClass("is-active"));
        btn.addClass("is-active");
        void this.refresh();
      };
    });
    // 取り消しボタン / undo button
    const undo = bar.createEl("button");
    setIcon(undo, "undo-2");
    undo.setAttr("aria-label", tr().undoAria);
    undo.onclick = () => void this.undo();
    this.undoBtn = undo;
    this.updateUndoButton();

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
    const statuses = this.plugin.settings.statuses;
    const none = tr().noneLabel;
    // 現在のフォルダ内に実在する担当者一覧 / assignees actually present in the current folder
    const assignees = [...new Set(this.tasks.map((t) => t.assignee).filter((a): a is string => !!a))].sort();
    // 現在のフォルダ内に実在するタグ一覧 / tags actually present in the current folder
    const tags = [...new Set(this.tasks.flatMap((t) => t.tags))].sort();

    const makeSelect = (icon: string, label: string, value: string, opts: [string, string][], on: (v: string) => void): void => {
      const wrap = host.createDiv({ cls: "ogantt-opt" });
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      ic.setAttr("aria-label", label); // アイコンの意味をツールチップで補助 / tooltip explains the icon
      const sel = wrap.createEl("select");
      for (const [val, text] of opts) {
        const o = sel.createEl("option", { text, value: val });
        if (val === value) o.selected = true;
      }
      sel.addEventListener("change", () => on(sel.value));
    };

    // チェックボックス（ラベル全体クリックで切替）/ checkbox (the whole label toggles it)
    const makeCheckbox = (icon: string, label: string, checked: boolean, on: (v: boolean) => void): void => {
      const wrap = host.createEl("label", { cls: "ogantt-opt ogantt-opt-check" });
      const cb = wrap.createEl("input", { type: "checkbox" });
      cb.checked = checked;
      const ic = wrap.createSpan({ cls: "ogantt-opt-ico" });
      setIcon(ic, icon);
      wrap.createSpan({ text: label });
      cb.addEventListener("change", () => on(cb.checked));
    };

    // 列の表示/非表示（歯車）＝オプション行の一番左 / column visibility (gear) — leftmost of the options row
    const colBtn = host.createEl("button", { cls: "ogantt-opt-gear clickable-icon" });
    setIcon(colBtn, "settings");
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
    // 色分け / color by
    makeSelect(
      "palette",
      tr().optColorLabel,
      this.colorBy,
      [["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
      (v) => { this.colorBy = v as typeof this.colorBy; this.rerender(); }
    );

    // ── 絞り込み（フィルタ）と視覚的に分ける区切り / divider before filters ──
    host.createDiv({ cls: "ogantt-opt-divider" });

    // ステータスで絞り込み / filter by status
    makeSelect(
      "filter",
      tr().fieldStatus,
      this.filterStatus,
      [["", tr().filterAll], ...statuses.map((s) => [s.id, s.label] as [string, string])],
      (v) => { this.filterStatus = v; this.rerender(); }
    );
    // 担当者で絞り込み / filter by assignee
    makeSelect(
      "user",
      tr().fieldAssignee,
      this.filterAssignee,
      [["", tr().filterAll], ...assignees.map((a) => [a, a] as [string, string])],
      (v) => { this.filterAssignee = v; this.rerender(); }
    );
    // タグで絞り込み（タグが1つも無ければ非表示）/ filter by tag (hidden when no tags exist)
    if (tags.length > 0) {
      makeSelect(
        "tag",
        tr().fieldTags,
        this.filterTag,
        [["", tr().filterAll], ...tags.map((tg) => [tg, tg] as [string, string])],
        (v) => { this.filterTag = v; this.rerender(); }
      );
    }
    // 空フォルダ表示の切替（フォルダグループ化時のみ・フラットでは無効）/ show-empty-folders (folder grouping only; off in flat)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("folder", tr().optShowEmpty, this.showEmptyFolders, (v) => {
        this.showEmptyFolders = v;
        this.rerender();
      });
    }
    // ロールアップの切替（親タスクのバーを子孫の集約で描く・フォルダグループ化時のみ）/ rollup (folder grouping only)
    if (this.groupBy === "folder" && !this.flat) {
      makeCheckbox("git-merge", tr().optRollup, this.rollup, (v) => {
        this.rollup = v;
        this.rerender();
      });
    }
    // フラット表示の切替（フォルダ/親子を無視した全タスク一覧）/ flat view (all tasks, no grouping/nesting)
    makeCheckbox("list", tr().optFlat, this.flat, (v) => {
      this.flat = v;
      this.rerender();
    });

    // 凡例（色分けの基準を説明）/ legend explaining the current color basis
    const legend = host.createDiv({ cls: "ogantt-legend" });
    if (this.colorBy === "status") {
      for (const s of statuses) this.legendChip(legend, s.color, s.label);
    } else {
      for (const a of assignees) this.legendChip(legend, hashColor(a), a);
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
    return this.plugin.settings.tagColors.find((c) => c.name === tag)?.color || hashColor(tag);
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
    if (color == null) {
      if (i >= 0) arr.splice(i, 1); // リセット＝上書きを削除 / reset = drop the override
    } else if (i >= 0) {
      arr[i].color = color;
    } else {
      arr.push({ name, color });
    }
    void this.plugin.saveData(this.plugin.settings);
    this.rerender();
  }

  // 右クリックの色メニュー（変更＝ネイティブピッカー／リセット＝自動）/ right-click color menu (change → native picker; reset → auto)
  private openColorMenu(e: MouseEvent, kind: "tag" | "folder", name: string): void {
    const current = kind === "tag" ? this.tagColor(name) : this.folderColor(name);
    const m = new Menu();
    m.addItem((i) => i.setTitle(tr().menuChangeColor).setIcon("palette").onClick(() => {
      // 隠し input[type=color] を生成してネイティブピッカーを開く / spawn a hidden color input to open the native picker
      const picker = activeDocument.body.createEl("input", { type: "color" });
      picker.value = /^#[0-9a-fA-F]{6}$/.test(current) ? current : "#888888";
      picker.style.position = "fixed";
      picker.style.left = "-9999px";
      picker.addEventListener("change", () => {
        this.setColorOverride(kind, name, picker.value);
        picker.remove();
      });
      picker.click();
    }));
    m.addItem((i) => i.setTitle(tr().menuResetColor).setIcon("rotate-ccw").onClick(() => this.setColorOverride(kind, name, null)));
    m.showAtMouseEvent(e);
  }

  // フィルタ→グループ再マッピングを適用したタスク列を返す / tasks after filter + group remap
  private processTasks(): Task[] {
    let list = this.tasks;
    if (this.filterStatus) list = list.filter((t) => (t.status ?? "") === this.filterStatus);
    if (this.filterAssignee) list = list.filter((t) => (t.assignee ?? "") === this.filterAssignee);
    if (this.filterTag) list = list.filter((t) => t.tags.includes(this.filterTag));
    // フラットはグループを無視＝再マッピング不要（タグ複製で重複行が出るのも防ぐ）/ flat ignores groups: skip remap (also avoids tag-duplicated rows)
    if (this.groupBy === "folder" || this.flat) return list;
    const none = tr().noneLabel;
    // タグは多値＝1タスクを各タグのグループへ複製（タグ無しは (なし)）/ tags are multi-valued: duplicate a task into each tag's group
    if (this.groupBy === "tag") {
      const out: Task[] = [];
      for (const t of list) {
        if (t.tags.length === 0) out.push({ ...t, groups: [none] });
        else for (const tag of t.tags) out.push({ ...t, groups: [tag] });
      }
      return out;
    }
    // groups を単一の合成グループへ差し替えて既存の buildRows を再利用 / remap groups to reuse buildRows
    const statusLabel = new Map(this.plugin.settings.statuses.map((s) => [s.id, s.label]));
    return list.map((t) => {
      const key =
        this.groupBy === "status"
          ? t.status ? statusLabel.get(t.status) ?? t.status : none
          : t.assignee || none;
      return { ...t, groups: [key] };
    });
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

  // ----- 取り消し（Undo）-----
  // 操作前に現在のタスクファイル内容を控える / snapshot current task files before an op
  private async pushUndo(label: string): Promise<void> {
    const files = new Map<string, string>();
    for (const t of this.tasks) {
      const f = this.app.vault.getAbstractFileByPath(t.path);
      if (f instanceof TFile) files.set(t.path, await this.app.vault.read(f));
    }
    this.undoStack.push({ label, files });
    if (this.undoStack.length > GanttView.UNDO_LIMIT) this.undoStack.shift();
    this.updateUndoButton();
  }

  // 親変更/移動を取り消し履歴へ（戻すとき：移動を逆再生→src の旧内容を復元）/ record a reparent/move
  private pushUndoReparent(label: string, moves: { from: string; to: string }[], srcOrigPath: string, oldContent: string): void {
    this.undoStack.push({ label, moves, files: new Map([[srcOrigPath, oldContent]]) });
    if (this.undoStack.length > GanttView.UNDO_LIMIT) this.undoStack.shift();
    this.updateUndoButton();
  }

  // 直近の操作を取り消す（移動の巻き戻し→内容スナップショット復元）/ revert the most recent op (undo moves, then restore content)
  private async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToUndo);
      return;
    }
    // 1) 移動を逆順に巻き戻す（to→from へリネーム）/ undo moves in reverse (rename to → from)
    if (entry.moves) {
      for (const m of [...entry.moves].reverse()) {
        const f = this.app.vault.getAbstractFileByPath(m.to);
        if (f instanceof TFile) {
          await this.app.fileManager.renameFile(f, m.from);
          if (this.selectedPath === m.to) this.selectedPath = m.from;
        }
      }
    }
    // 2) 内容スナップショットを書き戻す（パスが元に戻った後）/ restore content snapshots (after paths are back)
    if (entry.files) {
      for (const [path, content] of entry.files) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.app.vault.modify(f, content);
      }
    }
    new Notice(tr().undone(entry.label));
    await this.refresh();
    this.updateUndoButton();
  }

  // 取り消しボタンの有効/無効を更新 / enable or disable the undo button
  private updateUndoButton(): void {
    if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length === 0;
  }

  // ----- 表＋タイムラインを 1 つの CSS グリッドで（sticky で行を揃える）-----
  // ----- table + timeline in one CSS grid; sticky heads/left column keep rows aligned -----
  private renderGrid(main: HTMLElement): void {
    const totalDays = this.range.max - this.range.min + 1;
    const width = totalDays * this.ppd;
    const bodyH = this.rows.length * ROW_H;

    const cols = this.visibleColumns();
    const grid = main.createDiv({ cls: "ogantt-grid" });
    grid.style.gridTemplateColumns = `${this.tableWidth()}px ${width}px`;
    grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;

    // 行ループ内ではローカル変数 tr（行要素）が i18n の tr() を隠すため、先に文言を退避
    // the row var `tr` shadows the i18n tr() inside the loop, so grab strings up front
    const strings = tr();

    // (1) 左上の角＝表ヘッダー（表示中の列を並べる・クリックでソート）/ top-left corner = header (click to sort)
    const corner = grid.createDiv({ cls: "ogantt-corner" });
    for (const id of cols) {
      const th = corner.createDiv({ cls: "ogantt-th ogantt-th-sortable" + (id === "name" ? " ogantt-th-name" : "") });
      if (id !== "name") th.style.width = `${COLUMN_WIDTHS[id]}px`;
      th.createSpan({ text: this.colLabel(id) });
      // アクティブなソート列に ↑/↓ を表示 / show ↑/↓ on the active sort column
      if (this.plugin.settings.sortBy === id) {
        th.createSpan({ cls: "ogantt-sort-arrow", text: this.plugin.settings.sortDir === "asc" ? "↑" : "↓" });
      }
      th.onclick = () => this.toggleSort(id);
    }

    // (2) 日付軸 / date axis
    // Fit は算出した ppd から目盛り粒度を選ぶ / in Fit, pick tick granularity from the computed ppd
    const tickZoom: ZoomMode =
      this.zoom !== "Fit" ? this.zoom : this.ppd >= 24 ? "Day" : this.ppd >= 10 ? "Week" : "Month";
    const axis = grid.createDiv({ cls: "ogantt-axis" });
    for (const tick of buildTicks(this.range, tickZoom, this.ppd)) {
      const t = axis.createDiv({ cls: "ogantt-tick" + (tick.major ? " is-major" : "") });
      t.style.left = `${tick.x}px`;
      t.setText(tick.label);
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
        for (const id of cols) {
          if (id === "name") {
            const nameTd = tr.createDiv({ cls: "ogantt-td ogantt-td-name" });
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
            nameTd.createSpan({ text: t.name });
            // タイトル右クリック＝削除メニュー / right-click the title = delete menu
            nameTd.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              const m = new Menu();
              m.addItem((i) => i.setTitle(strings.menuDelete).setIcon("trash-2").onClick(() => this.confirmDelete(t.path)));
              m.showAtMouseEvent(e);
            });
          } else {
            const td = tr.createDiv({ cls: "ogantt-td" });
            td.style.width = `${COLUMN_WIDTHS[id]}px`;
            this.renderCell(td, row, id);
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

    // (4) タイムライン SVG / timeline SVG
    const svgWrap = grid.createDiv({ cls: "ogantt-svgwrap" });
    const svg = svgWrap.createSvg("svg", { cls: "ogantt-svg" });
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(bodyH));
    this.drawGrid(svg, width, bodyH);
    this.drawBars(svg);
    this.drawDependencies(svg); // バーの上に描いて矢印を隠さない / on top of bars so arrows stay visible
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

  private drawBars(svg: SVGElement): void {
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
        const rg = this.svgEl("g", { class: "ogantt-bar-g ogantt-rollup-g", "data-path": t.path }) as SVGGElement;
        rg.appendChild(this.svgEl("rect", { x: sx, y: yy, width: sw, height: hh, rx: 4, class: "ogantt-bar ogantt-rollup-bar", fill: c }));
        const lbl = this.svgEl("text", { x: sx + sw + 6, y: i * ROW_H + ROW_H / 2 + 4, class: "ogantt-bar-label" });
        lbl.textContent = t.name;
        rg.appendChild(lbl);
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

      const g = this.svgEl("g", { class: "ogantt-bar-g", "data-path": t.path }) as SVGGElement;
      const cyMid = i * ROW_H + ROW_H / 2;
      let lx = x; // 左端ハンドル位置 / left handle x
      let rx = x; // 右端ハンドル位置 / right handle x

      if (t.milestone) {
        const cx = x;
        const cy = cyMid;
        const r = h / 2;
        const dia = this.svgEl("path", {
          d: `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`,
          class: "ogantt-milestone",
          fill: color,
        });
        g.appendChild(dia);
        this.attachDrag(g, dia, t);
        lx = cx - r;
        rx = cx + r;
      } else {
        const endStr = anchorEnd(t) ?? aStart;
        const w = Math.max((dayIndex(endStr) - dayIndex(aStart) + 1) * this.ppd, 6);
        const rect = this.svgEl("rect", { x, y, width: w, height: h, rx: 4, class: "ogantt-bar", fill: color });
        g.appendChild(rect);
        if (t.progress != null && t.progress > 0) {
          const pw = (w * Math.min(100, t.progress)) / 100;
          g.appendChild(this.svgEl("rect", { x, y, width: pw, height: h, rx: 4, class: "ogantt-bar-progress" }));
        }
        // ラベル（タスク名＋担当）/ label
        const label = this.svgEl("text", { x: x + w + 6, y: cyText(i), class: "ogantt-bar-label" });
        label.textContent = t.assignee ? `${t.name} · @${t.assignee}` : t.name;
        g.appendChild(label);
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
      const HGAP = 11; // バー端からの距離 / gap from the bar edge
      const handleDefs: [number, "start" | "finish"][] = [[lx - HGAP, "start"], [rx + HGAP, "finish"]];
      for (const [hx, end] of handleDefs) {
        const handle = this.svgEl("circle", { cx: hx, cy: cyMid, r: 5, class: "ogantt-handle" });
        handle.addEventListener("pointerdown", (e: PointerEvent) => this.startLink(g, svg, t, end, e));
        g.appendChild(handle);
      }

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
        } else {
          await this.pushUndo(tr().undoAddDep(type));
          await addDependency(this.app, this.plugin.settings, target.path, source.path, type);
          // メモリにも依存を反映（metadataCache 更新前でも整列できるように）/ reflect dep in-memory
          target.deps = target.deps.filter((dd) => dd.path !== source.path);
          target.deps.push({ path: source.path, type });
          // SS/FF は後続の日付を先行に揃える（連鎖も）/ snap SS/FF successors to the predecessor
          await this.realignSuccessors(source.path);
          this.rerender();
        }
      }
    })();
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  // SS/FF 依存に従って後続の日付を先行に揃える（期間は維持＝バーが移動）
  // align a successor to its predecessor per SS/FF (duration kept → the bar moves)
  private async applyAlign(target: Task, pred: Task, type: DepType): Promise<boolean> {
    // マイルストーンは固定日なので依存で動かさない / milestones are fixed dates: never auto-moved
    if (target.milestone) return false;
    const ps = anchorStart(pred);
    const pe = anchorEnd(pred);
    let ns: string | undefined;
    let ne: string | undefined;
    if (type === "FS") {
      // 先行の終了の翌日に後続の開始を合わせる / successor starts the day after predecessor's end
      if (!pe) return false;
      const startDay = dayIndex(pe) + 1;
      if (target.milestone) ns = ne = dayToStr(startDay);
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ns = dayToStr(startDay);
        ne = dayToStr(startDay + dur);
      }
    } else if (type === "SS") {
      if (!ps) return false;
      if (target.milestone) ns = ne = ps;
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ns = ps;
        ne = dayToStr(dayIndex(ps) + dur);
      }
    } else if (type === "FF") {
      if (!pe) return false;
      if (target.milestone) ns = ne = pe;
      else {
        if (!target.start || !target.end) return false;
        const dur = dayIndex(target.end) - dayIndex(target.start);
        ne = pe;
        ns = dayToStr(dayIndex(pe) - dur);
      }
    } else {
      return false;
    }

    // 変化が無ければ何もしない / skip if unchanged
    if (target.milestone) {
      if (target.end === ne) return false;
    } else if (target.start === ns && target.end === ne) {
      return false;
    }
    await writeDates(this.app, this.plugin.settings, target.path, ns, ne, target.milestone);
    // メモリ上も更新して連鎖整列に備える / update in-memory for cascading
    if (target.milestone) target.end = ne;
    else {
      target.start = ns;
      target.end = ne;
    }
    return true;
  }

  // 指定タスクの SS/FF 後続を整列し、連鎖的に伝播（循環は seen で打ち切り）
  // realign SS/FF successors of a task, propagating along chains (cycles stopped via `seen`)
  private async realignSuccessors(rootPath: string): Promise<boolean> {
    const queue = [rootPath];
    const seen = new Set<string>();
    let any = false;
    let guard = 0;
    while (queue.length && guard++ < 1000) {
      const predPath = queue.shift()!;
      const pred = this.tasks.find((t) => t.path === predPath);
      if (!pred) continue;
      for (const succ of this.tasks) {
        if (succ.path === predPath) continue;
        const dep = succ.deps.find((dd) => dd.path === predPath);
        if (!dep) continue;
        if (await this.applyAlign(succ, pred, dep.type)) {
          any = true;
          if (!seen.has(succ.path)) {
            seen.add(succ.path);
            queue.push(succ.path);
          }
        }
      }
    }
    return any;
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
        const depG = this.svgEl("g", { class: "ogantt-dep-g" }) as SVGGElement;

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
        const xg = this.svgEl("g", { class: "ogantt-dep-x" }) as SVGGElement;
        xg.appendChild(this.svgEl("circle", { cx: mxX, cy: mxY, r: 8, class: "ogantt-dep-x-bg" }));
        xg.appendChild(this.svgEl("path", {
          d: `M ${mxX - 3} ${mxY - 3} L ${mxX + 3} ${mxY + 3} M ${mxX + 3} ${mxY - 3} L ${mxX - 3} ${mxY + 3}`,
          class: "ogantt-dep-x-mark",
        }));
        depG.appendChild(xg);

        // クリック → 確認なしで即切断（Ctrl+Z で取り消し可）/ click → remove immediately (undo with Ctrl+Z)
        depG.addEventListener("click", (ev: MouseEvent) => void (async () => {
          ev.stopPropagation();
          await this.pushUndo(tr().undoRemoveDep(depType));
          await removeDependency(this.app, this.plugin.settings, succPath, predPath);
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
          await this.pushUndo(tr().undoReschedule(task.name));
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
          // SS/FF 後続を連動（メモリ更新＋ディスク書き込み）/ cascade to SS/FF successors
          await this.realignSuccessors(task.path);
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
  // 今のフォルダに 1 日タスク（開始=終了=今日）を作り、詳細パネルを開いて命名を促す
  // create a 1-day task (start = end = today) in the current folder, then open the panel to name it
  private async createNewTask(): Promise<void> {
    const file = await createTask(this.app, this.folder, tr().newTaskName);
    if (!file) return;
    const k = this.plugin.settings.keys;
    const today = dayToStr(todayIndex());
    await writeField(this.app, file.path, k.start, today);
    await writeField(this.app, file.path, k.end, today);
    await this.refresh();
    await this.openDetail(file.path, true);
  }

  // ----- ドラッグ＆ドロップ（フォルダへ＝親解除して移動／タスクへ＝サブタスク化）-----
  // ----- drag & drop (onto a folder = detach + move; onto a task = make subtask) -----
  // タスク行をドラッグ可能にする / make a task row draggable
  private makeDraggableTask(row: HTMLElement, path: string): void {
    row.setAttr("draggable", "true");
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
    const res = await reparentTask(this.app, this.plugin.settings, this.tasks, srcPath, destFolder, parentFile);
    if (!res) return;
    const label = parentTaskPath ? tr().undoSubtask(name) : tr().undoDetach(name);
    this.pushUndoReparent(label, res.moves, srcPath, res.oldContent);
    const srcMove = res.moves.find((m) => m.from === srcPath);
    if (srcMove && this.selectedPath === srcPath) this.selectedPath = srcMove.to;
    await this.refresh();
  }

  // タググループへのドロップでタグを付与（取り消し可・既に付いていれば何もしない）/ add a tag via drop (undoable; no-op if already tagged)
  private async addTagTo(srcPath: string, tag: string): Promise<void> {
    const pre = this.tasks.find((x) => x.path === srcPath);
    if (!pre || pre.tags.includes(tag)) return;
    await this.pushUndo(tr().undoAddTag(pre.name, tag));
    await addTag(this.app, srcPath, tag);
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
    titleInput.addEventListener("change", () => void (async () => {
      const np = await renameTask(this.app, this.selectedPath!, titleInput.value);
      if (np) this.selectedPath = np;
      await this.refresh();
    })());
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

    // 担当 / assignee
    const asgIn = fieldRow(tr().fieldAssignee).createEl("input", { type: "text" });
    asgIn.value = t.assignee ?? "";
    asgIn.addEventListener("change", () => void this.saveField(k.assignee, asgIn.value));

    // タグ（多値・チップ＋×で削除、入力＋Enterで追加。付与は D&D も可）/ tags: chips with × to remove, input+Enter to add (also via drag)
    const tagField = fieldRow(tr().fieldTags);
    tagField.addClass("ogantt-tags-field");
    for (const tag of t.tags) {
      const chip = tagField.createSpan({ cls: "ogantt-tag-chip" });
      this.paintTagChip(chip, tag);
      chip.createSpan({ text: tag });
      const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
      setIcon(x, "x");
      x.setAttr("aria-label", tr().clearDate);
      x.addEventListener("click", () => void (async () => {
        const path = this.selectedPath;
        if (!path) return;
        await removeTag(this.app, path, tag);
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
    tagAdd.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); tagAdd.blur(); } });
    tagAdd.addEventListener("change", () => void (async () => {
      const v = tagAdd.value.trim().replace(/^#/, "");
      const path = this.selectedPath;
      if (!v || !path) return;
      await addTag(this.app, path, v);
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
      if (!this.selectedPath) return;
      // 0% は未設定として削除、それ以外は数値で保存 / drop at 0% (unset), otherwise store the number
      const n = Number(progRange.value);
      await writeField(this.app, this.selectedPath, k.progress, n > 0 ? n : undefined);
      await this.refresh();
    })());

    // 本文 / body（テキストエリア、フォーカスを外したら保存）/ body textarea, saved on blur
    d.createEl("div", { cls: "ogantt-detail-label", text: tr().fieldBody });
    const bodyArea = d.createEl("textarea", { cls: "ogantt-detail-body-edit" });
    bodyArea.value = await readBody(this.app, t.path);
    const autosize = () => {
      // 高さを一旦リセットしてから内容に合わせる / reset, then fit to content
      bodyArea.setCssStyles({ height: "auto" });
      bodyArea.setCssStyles({ height: `${bodyArea.scrollHeight + 2}px` });
    };
    bodyArea.addEventListener("input", autosize);
    bodyArea.addEventListener("blur", () => void (async () => {
      await writeBody(this.app, this.selectedPath!, bodyArea.value);
    })());
    window.setTimeout(autosize, 0);
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
        const ok = await deleteTask(this.app, path);
        if (!ok) return;
        // 削除したタスクの詳細が開いていたら閉じる / close the detail panel if it showed the deleted task
        if (this.selectedPath === path) {
          this.selectedPath = null;
          this.detailEl?.removeClass("is-open");
        }
        new Notice(tr().deletedNotice(t.name));
        await this.refresh();
      })(),
    }).open();
  }

  // フィールド保存（空なら削除）/ save a frontmatter field (delete if empty)
  private async saveField(key: string, value: string): Promise<void> {
    if (!this.selectedPath) return;
    await writeField(this.app, this.selectedPath, key, value === "" ? undefined : value);
    await this.refresh();
  }

  // 日付エリア：開始・終了を横並びチップで表示、各×でクリア、クリックで範囲カレンダーを開く
  // dates area: start & end chips side by side, each clearable with ×, click opens the range calendar
  private buildDates(meta: HTMLElement, t: Task): void {
    const fmt = this.plugin.settings.dateFormat;
    const k = this.plugin.settings.keys;
    const state = { start: t.start ?? "", end: t.end ?? "" };

    const row = meta.createDiv({ cls: "ogantt-detail-row" });
    row.createSpan({ cls: "ogantt-detail-label", text: tr().fieldDates });
    const chips = row.createDiv({ cls: "ogantt-detail-field ogantt-date-chips" });

    const painters: (() => void)[] = [];
    const repaint = () => painters.forEach((p) => p());

    // 開始・終了を両方フロントマターへ（空は削除）/ persist both ends (delete when empty)
    const save = async (): Promise<void> => {
      if (!this.selectedPath) return;
      // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
      if (state.start && !state.end) {
        state.end = state.start;
        repaint(); // 補正を即時反映 / reflect the fill right away
      }
      await writeField(this.app, this.selectedPath, k.start, state.start || undefined);
      await writeField(this.app, this.selectedPath, k.end, state.end || undefined);
      await this.refresh();
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
          val.setText(formatDate(iso, fmt));
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
    repaint();
  }

  // 非 name 列のセル内容を描画 / fill a non-name cell by column id
  private renderCell(td: HTMLElement, row: Row, id: ColumnId): void {
    const t = row.task!;
    const fmt = this.plugin.settings.dateFormat;
    // ロールアップ ON の親は、開始/終了セルも集約値を表示（バーと一致・編集不可）
    // when rolled up, a parent's Start/Due cells show the aggregated span too (matches the bar; not editable)
    const rolled = this.rollup && row.span ? row.span : null;
    switch (id) {
      case "start":
        if (rolled) {
          td.setText(formatDate(rolled.start, fmt));
        } else if (t.milestone) {
          // マイルストーンは開始列に菱形マーカー（開始日を持たない＝編集不可）/ diamond marker; no start to edit
          td.setText("◆");
          td.addClass("ogantt-td-ms");
        } else {
          td.setText(formatDate(t.start, fmt));
          this.makeDateCell(td, t, "start");
        }
        break;
      case "end":
        if (rolled) {
          td.setText(formatDate(rolled.end, fmt));
        } else {
          td.setText(formatDate(t.end, fmt));
          this.makeDateCell(td, t, "end");
        }
        break;
      case "assignee":
        td.setText(t.assignee ?? "");
        break;
      case "status": {
        const s = this.plugin.settings.statuses.find((x) => x.id === t.status);
        if (s) {
          const dot = td.createSpan({ cls: "ogantt-status-dot" });
          dot.style.background = s.color;
          td.createSpan({ text: s.label });
        }
        break;
      }
      case "tags": {
        // タグをチップで表示（多値）/ tags as chips (multi-valued)
        td.addClass("ogantt-td-tags");
        for (const tag of t.tags) {
          const chip = td.createSpan({ cls: "ogantt-tag-chip", text: tag });
          this.paintTagChip(chip, tag);
          // タグチップを右クリック＝色を変更 / right-click a tag chip to change its color
          chip.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); this.openColorMenu(e, "tag", tag); });
        }
        break;
      }
      case "name":
        break; // name は呼び出し側で処理 / handled by the caller
    }
  }

  // テーブルの日付セルをダブルクリックで直接編集可能にする / make a table date cell editable via double-click
  private makeDateCell(cell: HTMLElement, t: Task, which: "start" | "end"): void {
    cell.addClass("ogantt-td-editable");
    cell.setAttr("aria-label", tr().pickDate);
    // セルのシングルクリックは詳細を開かない（日付編集に専念）/ a single click here edits dates, not opens detail
    cell.addEventListener("click", (e) => e.stopPropagation());
    cell.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.openCellDatePicker(cell, t, which);
    });
  }

  // テーブルのセルから範囲カレンダーを開いて日付を直接編集 / open the range calendar from a table cell
  private openCellDatePicker(anchor: HTMLElement, t: Task, which: "start" | "end"): void {
    const k = this.plugin.settings.keys;
    const state = { start: t.start ?? "", end: t.end ?? "" };
    const save = async (): Promise<void> => {
      // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
      if (state.start && !state.end) state.end = state.start;
      await writeField(this.app, t.path, k.start, state.start || undefined);
      await writeField(this.app, t.path, k.end, state.end || undefined);
      await this.refresh();
    };
    // repaint はテーブル側では不要（save→refresh で再描画される）/ no chip repaint needed here
    this.openRangePicker(anchor, state, which, () => {}, save);
  }

  // 範囲カレンダー（開始・終了を1つで指定。月移動は ←→・テーマ追従）
  // range calendar: pick start & end in one popup; month nav ← →, theme-aware
  private openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>
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

    // 端点を1つ設定して交互に切り替え（逆転は補正）/ set one endpoint, then alternate (order kept valid)
    const pick = (ds: string) => {
      if (act === "start") {
        state.start = ds;
        if (state.end && ds > state.end) state.end = ds;
        act = "end";
      } else {
        state.end = ds;
        if (state.start && ds < state.start) state.start = ds;
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

      cal.createDiv({ cls: "ogantt-cal-active", text: `▸ ${act === "start" ? tr().fieldStart : tr().fieldDue}` });

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
      clearBtn.onclick = () => { state[act] = ""; repaint(); void save(); render(); };
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

  // SVG 要素生成ヘルパー / SVG element helper
  private svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
    const el = activeDocument.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }
}

// 削除などの確認ダイアログ（破壊的操作の前に確認）/ a small confirm dialog for destructive actions
interface ConfirmOpts {
  title: string;
  body: string;
  sub?: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
}
class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmOpts) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    if (this.opts.sub) this.contentEl.createEl("p", { cls: "ogantt-confirm-sub", text: this.opts.sub });
    const btns = this.contentEl.createDiv({ cls: "ogantt-confirm-btns" });
    const cancel = btns.createEl("button", { text: this.opts.cancelText });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { cls: "mod-warning", text: this.opts.confirmText });
    ok.onclick = () => {
      this.close();
      this.opts.onConfirm();
    };
    window.setTimeout(() => ok.focus(), 0); // Enter で即確定 / Enter confirms
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
