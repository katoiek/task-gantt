import { ItemView, WorkspaceLeaf, setIcon, Notice, TFile } from "obsidian";
import type GanttPlugin from "./main";
import { Task, Row, ZoomMode, DepType, GanttViewState, VIEW_TYPE_GANTT } from "./types";
import {
  collectTasks,
  buildRows,
  createTask,
  writeDates,
  writeField,
  writeBody,
  renameTask,
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
import { t as tr, lang } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var

const ROW_H = 30; // 行の高さ（表とタイムラインで共通）/ shared row height
const HEAD_H = 40; // ヘッダー高さ / header height
const TABLE_W = 360; // 左の表の幅 / left table width
const BAR_PAD = 5; // バーの上下余白 / vertical padding inside a row
const RESIZE_EDGE = 8; // バー端リサイズの当たり幅 / edge-resize hit width
const MIN_PPD = 2; // Fit 時の最小 1 日幅（これ未満は横スクロール）/ minimum px/day in Fit mode
const FIT_SCROLLBAR_PAD = 16; // 縦スクロールバー分の余白 / room for the vertical scrollbar
const FALLBACK_BAR = "#7c8db5"; // ステータス/担当者が未設定のときのバー色 / bar color when status/assignee is unset

// 担当者名から安定した色を生成（同じ名前は常に同じ色）/ deterministic color from an assignee name
function assigneeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 55%)`;
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
  private groupBy: "folder" | "status" | "assignee" = "folder";
  private filterStatus = ""; // "" = すべて / all
  private filterAssignee = ""; // "" = すべて / all
  private optionsHost!: HTMLElement; // フィルタ/グループ/凡例の差し替え先 / options + legend container

  // 取り消し履歴（操作前のファイル内容スナップショット）/ undo history (pre-op file snapshots)
  private undoStack: { label: string; files: Map<string, string> }[] = [];
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
  async setState(state: GanttViewState, result: unknown): Promise<void> {
    if (state && typeof state.folder === "string") this.folder = state.folder;
    await super.setState(state, result as any);
    if (this.gridHost) await this.refresh();
  }

  async onOpen(): Promise<void> {
    this.buildSkeleton();
    await this.refresh();
    // メタデータ更新で自動再描画（ガント部のみ）/ re-render the grid when frontmatter changes
    this.registerEvent(this.app.metadataCache.on("changed", () => this.scheduleRefresh()));
    // Ctrl/Cmd+Z で取り消し（入力欄にフォーカス中はネイティブ undo を優先）
    // Ctrl/Cmd+Z to undo (defer to native undo while an input is focused)
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (!(e.key === "z" || e.key === "Z") || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (this.app.workspace.getActiveViewOfType(GanttView) !== this) return;
      const ae = document.activeElement as HTMLElement | null;
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
    document.querySelectorAll(".ogantt-cal").forEach((e) => e.remove()); // 開いたままのカレンダーを掃除 / drop any open calendar
  }

  // ディスクから集計し直して再描画 / re-collect from disk, then render
  async refresh(): Promise<void> {
    if (!this.gridHost) this.buildSkeleton();
    this.tasks = collectTasks(this.app, this.plugin.settings, this.folder);
    this.rerender();
  }

  // メモリ上の this.tasks から描画（ディスクは読まない）/ render from in-memory tasks (no disk read)
  // ドラッグや整列の直後、metadataCache 更新前に正しい位置を即表示するため / shows correct positions before metadataCache updates
  rerender(): void {
    if (!this.gridHost) this.buildSkeleton();
    this.renderOptions(); // フィルタ/グループ/凡例を最新データで更新 / refresh options + legend
    const view = this.processTasks(); // フィルタ＋グループ適用後 / after filter + group remap
    this.rows = buildRows(view, this.collapsed);
    this.range = computeRange(view);
    this.ppd = this.computePpd();
    const titleEl = this.contentEl.querySelector(".ogantt-title");
    if (titleEl) titleEl.setText(this.folder || "(vault root)");

    this.gridHost.empty();
    if (view.length === 0) {
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
    const avail = (this.gridHost?.clientWidth ?? 0) - TABLE_W - FIT_SCROLLBAR_PAD;
    if (avail <= 0) return pxPerDay("Week"); // まだレイアウト前 / not laid out yet
    return Math.max(MIN_PPD, Math.floor(avail / totalDays));
  }

  // ----- ツールバー / toolbar -----
  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "ogantt-toolbar" });
    bar.createSpan({ cls: "ogantt-title", text: this.plugin.settings.rootFolder || "(vault root)" });
    // 新規タスク追加 / add a new task
    const add = bar.createEl("button", { cls: "ogantt-add" });
    setIcon(add, "plus");
    add.setAttr("aria-label", tr().newTaskAria);
    add.onclick = () => void this.createNewTask();
    bar.createDiv({ cls: "ogantt-spacer" });
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

    // ── 表示の組み立て（グループ化・色分け）/ layout (group + color) ──
    // グループ化 / group by
    makeSelect(
      "layers",
      tr().optGroupLabel,
      this.groupBy,
      [["folder", tr().optGroupFolder], ["status", tr().fieldStatus], ["assignee", tr().fieldAssignee]],
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

    // 凡例（色分けの基準を説明）/ legend explaining the current color basis
    const legend = host.createDiv({ cls: "ogantt-legend" });
    if (this.colorBy === "status") {
      for (const s of statuses) this.legendChip(legend, s.color, s.label);
    } else {
      for (const a of assignees) this.legendChip(legend, assigneeColor(a), a);
      if (this.tasks.some((t) => !t.assignee)) this.legendChip(legend, FALLBACK_BAR, none);
    }
  }

  private legendChip(parent: HTMLElement, color: string, label: string): void {
    const chip = parent.createDiv({ cls: "ogantt-legend-chip" });
    const sw = chip.createSpan({ cls: "ogantt-legend-swatch" });
    sw.style.background = color;
    chip.createSpan({ text: label });
  }

  // フィルタ→グループ再マッピングを適用したタスク列を返す / tasks after filter + group remap
  private processTasks(): Task[] {
    let list = this.tasks;
    if (this.filterStatus) list = list.filter((t) => (t.status ?? "") === this.filterStatus);
    if (this.filterAssignee) list = list.filter((t) => (t.assignee ?? "") === this.filterAssignee);
    if (this.groupBy === "folder") return list;
    // groups を単一の合成グループへ差し替えて既存の buildRows を再利用 / remap groups to reuse buildRows
    const statusLabel = new Map(this.plugin.settings.statuses.map((s) => [s.id, s.label]));
    const none = tr().noneLabel;
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
    const main = this.gridHost.querySelector(".ogantt-main") as HTMLElement | null;
    const todayLine = main?.querySelector(".ogantt-today") as SVGElement | null;
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

  // 直近の操作を取り消す（控えた内容を書き戻す）/ revert the most recent op by restoring its snapshot
  private async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) {
      new Notice(tr().nothingToUndo);
      return;
    }
    for (const [path, content] of entry.files) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) await this.app.vault.modify(f, content);
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

    const grid = main.createDiv({ cls: "ogantt-grid" });
    grid.style.gridTemplateColumns = `${TABLE_W}px ${width}px`;
    grid.style.gridTemplateRows = `${HEAD_H}px ${bodyH}px`;

    // (1) 左上の角＝表ヘッダー / top-left corner = table header
    const corner = grid.createDiv({ cls: "ogantt-corner" });
    corner.createDiv({ cls: "ogantt-th ogantt-th-name", text: tr().colTask });
    corner.createDiv({ cls: "ogantt-th", text: tr().colStart });
    corner.createDiv({ cls: "ogantt-th", text: tr().colDue });

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
      const indent = 8 + row.depth * 16; // 入れ子インデント / nesting indent
      if (row.kind === "group") {
        tr.addClass("is-group");
        const isCollapsed = row.key != null && this.collapsed.has(row.key);
        const g = tr.createDiv({ cls: "ogantt-td-group" });
        g.style.paddingLeft = `${indent}px`;
        const chev = g.createSpan({ cls: "ogantt-chevron" });
        setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
        const ic = g.createSpan({ cls: "ogantt-folder-icon" });
        setIcon(ic, isCollapsed ? "folder" : "folder-open");
        g.createSpan({ text: row.group });
        tr.onclick = () => {
          if (row.key == null) return;
          if (this.collapsed.has(row.key)) this.collapsed.delete(row.key);
          else this.collapsed.add(row.key);
          void this.refresh();
        };
      } else {
        const t = row.task!;
        tr.setAttr("data-path", t.path);
        if (t.path === this.selectedPath) tr.addClass("is-selected");
        const nameTd = tr.createDiv({ cls: "ogantt-td ogantt-td-name", text: t.name });
        nameTd.style.paddingLeft = `${indent}px`;
        // マイルストーンは開始列に菱形マーカー、期限列は日付のみ（列をはみ出さない）
        // milestone: diamond marker in the start cell, date alone in the due cell (no overflow)
        const fmt = this.plugin.settings.dateFormat;
        const startTd = tr.createDiv({ cls: "ogantt-td", text: t.milestone ? "◆" : formatDate(t.start, fmt) });
        if (t.milestone) startTd.addClass("ogantt-td-ms");
        tr.createDiv({ cls: "ogantt-td", text: formatDate(t.end, fmt) });
        tr.onclick = () => void this.openDetail(t.path);
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
      const aStart = anchorStart(t);
      if (!aStart) return;
      const y = i * ROW_H + BAR_PAD;
      const h = ROW_H - BAR_PAD * 2;
      const x = this.xOf(aStart);
      const color =
        this.colorBy === "assignee"
          ? t.assignee ? assigneeColor(t.assignee) : FALLBACK_BAR
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
    const onUp = async (e: PointerEvent) => {
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
    };
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
    await writeDates(this.app, this.plugin.settings, target.path, ns!, ne!, target.milestone);
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
        depG.addEventListener("click", async (ev: MouseEvent) => {
          ev.stopPropagation();
          await this.pushUndo(tr().undoRemoveDep(depType));
          await removeDependency(this.app, this.plugin.settings, succPath, predPath);
          await this.refresh();
        });
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
      const onUp = async (e: PointerEvent) => {
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
      };
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
    titleInput.addEventListener("change", async () => {
      const np = await renameTask(this.app, this.selectedPath!, titleInput.value);
      if (np) this.selectedPath = np;
      await this.refresh();
    });
    // 新規作成直後は名前を選択状態にして即リネームできるように / select the name right after creation
    if (focusTitle) window.setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);
    const openBtn = header.createEl("button", { cls: "clickable-icon" });
    setIcon(openBtn, "external-link");
    openBtn.setAttr("aria-label", tr().openAsNote);
    openBtn.onclick = () => void this.app.workspace.openLinkText(this.selectedPath!, "", true);
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
    progRange.addEventListener("change", async () => {
      if (!this.selectedPath) return;
      // 0% は未設定として削除、それ以外は数値で保存 / drop at 0% (unset), otherwise store the number
      const n = Number(progRange.value);
      await writeField(this.app, this.selectedPath, k.progress, n > 0 ? n : undefined);
      await this.refresh();
    });

    // 本文 / body（テキストエリア、フォーカスを外したら保存）/ body textarea, saved on blur
    d.createEl("div", { cls: "ogantt-detail-label", text: tr().fieldBody });
    const bodyArea = d.createEl("textarea", { cls: "ogantt-detail-body-edit" });
    bodyArea.value = await readBody(this.app, t.path);
    const autosize = () => {
      bodyArea.style.height = "auto";
      bodyArea.style.height = `${bodyArea.scrollHeight + 2}px`;
    };
    bodyArea.addEventListener("input", autosize);
    bodyArea.addEventListener("blur", async () => {
      await writeBody(this.app, this.selectedPath!, bodyArea.value);
    });
    window.setTimeout(autosize, 0);
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
        if (iso) {
          val.setText(formatDate(iso, fmt));
          chip.removeClass("is-empty");
          x.style.display = "";
        } else {
          val.setText(which === "start" ? tr().fieldStart : t.milestone ? tr().fieldDue : tr().fieldEnd);
          chip.addClass("is-empty");
          x.style.display = "none"; // 空のときは×を隠す / hide × when empty
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

  // 範囲カレンダー（開始・終了を1つで指定。月移動は ←→・テーマ追従）
  // range calendar: pick start & end in one popup; month nav ← →, theme-aware
  private openRangePicker(
    anchor: HTMLElement,
    state: { start: string; end: string },
    active: "start" | "end",
    repaint: () => void,
    save: () => void | Promise<void>
  ): void {
    document.querySelectorAll(".ogantt-cal").forEach((e) => e.remove());
    const todayStr = dayToStr(todayIndex());
    const base = state[active] || state.start || state.end || todayStr;
    let y = parseInt(base.slice(0, 4), 10);
    let m = parseInt(base.slice(5, 7), 10); // 1-based
    let act = active; // 次のクリックで設定する端点 / endpoint the next click sets
    const wk = lang === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    const cal = document.body.createDiv({ cls: "ogantt-cal" });
    const close = () => {
      cal.remove();
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: PointerEvent) => {
      const tg = e.target as Node;
      if (!cal.contains(tg) && !anchor.contains(tg)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };

    let mode: "day" | "year" = "day"; // 日ビュー / 年（12ヶ月）ビュー / day view or year (12-month) view
    const months = lang === "ja"
      ? ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]
      : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

      cal.createDiv({ cls: "ogantt-cal-active", text: `▸ ${act === "start" ? tr().fieldStart : tr().fieldEnd}` });

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
      const todayBtn = foot.createEl("button", { text: lang === "ja" ? "今日" : "Today" });
      todayBtn.onclick = () => {
        y = parseInt(todayStr.slice(0, 4), 10);
        m = parseInt(todayStr.slice(5, 7), 10); // 表示も今日の月へ / move the view to today
        pick(todayStr);
      };
      const clearBtn = foot.createEl("button", { text: lang === "ja" ? "クリア" : "Clear" });
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

    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
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
      const onUp = async (e: PointerEvent) => {
        resizer.releasePointerCapture(ev.pointerId);
        resizer.removeEventListener("pointermove", onMove);
        resizer.removeEventListener("pointerup", onUp);
        this.plugin.settings.detailWidth = parseInt(panel.style.width, 10) || 380;
        await this.plugin.saveData(this.plugin.settings);
      };
      resizer.addEventListener("pointermove", onMove);
      resizer.addEventListener("pointerup", onUp);
    });
  }

  // SVG 要素生成ヘルパー / SVG element helper
  private svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    return el;
  }
}
