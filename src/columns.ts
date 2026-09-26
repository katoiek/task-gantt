// テーブル列の定義（ラベル・幅・並べ替え・描画・インライン編集を 1 か所に）
// table column definitions: label, width, sorting, painting and inline editing in one place
import { setIcon } from "obsidian";
import type { BoardContext } from "./board";
import type { GanttSettings } from "./settings";
import type { Row, Task, CustomField, CustomValue } from "./types";
import {
  anchorStart,
  anchorEnd,
  combineDateTime,
  writeField,
  addTag,
  removeTag,
  customValueText,
  parseCustomInput,
} from "./model";
import { formatDate } from "./timeline";
import { t as tr } from "./i18n"; // tr() … ローカル変数 t（Task）との衝突回避 / aliased to avoid clashing with the `t` task var

// 並べ替えのキー（数値同士は差、それ以外は文字列比較）/ a sort key (numbers subtract, anything else compares as text)
export type SortKey = string | number;

interface ColumnBase {
  id: string;
  label: () => string; // ヘッダーの表示名（言語切替に追従）/ header label (follows the UI language)
  width: number; // 既定幅(px)。ユーザー上書きは settings.columnWidths / default width; user overrides live in settings.columnWidths
  optional: boolean; // 歯車で出し分けできるか / toggleable from the gear menu
  sortKey: (t: Task, settings: GanttSettings) => SortKey;
}

// タスク名の列。ツリー（インデント・折りたたみ・右クリック）を描くのでビューが直接扱う。
// 改名は詳細パネルのタイトル欄で行い、セルのクリックは詳細を開く（Inline edit の唯一の例外）
// the task-name column: the view draws it itself (indent, collapse, context menu). Renaming lives in the
// detail panel's title and a click opens the panel — the one exception to "every column is inline-editable"
export interface NameColumn extends ColumnBase {
  kind: "name";
}

// 通常の列。表示できる列はすべて Inline edit に対応する（恒久仕様）ため edit は必須
// a regular column. Every column the table can show is inline-editable (a standing rule), so `edit` is required
export interface CellColumn extends ColumnBase {
  kind: "cell";
  // セルの中身を描く。false を返したセルは読み取り専用（編集を付けない）
  // paint the cell; returning false marks it read-only (no editor attached)
  paint: (ctx: BoardContext, td: HTMLElement, row: Row) => boolean | void;
  // ダブルクリックで開くエディタ / the editor opened by a double-click
  edit: (ctx: BoardContext, cell: HTMLElement, row: Row) => void;
  editAria: () => string; // 編集可能セルの読み上げラベル / aria label of an editable cell
}

export type ColumnDef = NameColumn | CellColumn;

const NO_DATE = "9999-99-99"; // 日付なしは末尾へ / undated tasks sort last

// ----- 組み込み列 / built-in columns -----
export const BUILTIN_COLUMNS: ColumnDef[] = [
  {
    kind: "name",
    id: "name",
    label: () => tr().colTask,
    width: 160,
    optional: false,
    sortKey: (t) => t.name.toLowerCase(),
  },
  {
    kind: "cell",
    id: "start",
    label: () => tr().colStart,
    width: 84,
    optional: true,
    sortKey: (t) => anchorStart(t) ?? NO_DATE,
    paint: (ctx, td, row) => {
      td.empty();
      const t = row.task!;
      const fmt = ctx.settings.dateFormat;
      // ロールアップ ON の親は集約値を表示（バーと一致・編集不可）/ a rolled-up parent shows the aggregated span (read-only)
      const rolled = ctx.rollup && row.span ? row.span : null;
      if (rolled) {
        td.setText(formatDate(rolled.start, fmt));
        return false;
      }
      if (t.milestone) {
        // マイルストーンは開始列に菱形マーカー（開始日を持たない＝編集不可）/ diamond marker; no start to edit
        td.setText("◆");
        td.addClass("ogantt-td-ms");
        return false;
      }
      // 時刻があれば併記。テキストは span に包む（セルが flex なので直下テキストでは省略記号が効かない）
      // append the time of day when set; wrap in a span (a bare text node can't ellipsis inside a flex cell)
      td.createSpan({ cls: "ogantt-td-text", text: formatDate(t.start, fmt) + (t.startTime ? ` ${t.startTime}` : "") });
    },
    edit: (ctx, cell, row) => openCellDatePicker(ctx, cell, row.task!, "start"),
    editAria: () => tr().pickDate,
  },
  {
    kind: "cell",
    id: "end",
    label: () => tr().colDue,
    width: 84,
    optional: true,
    sortKey: (t) => anchorEnd(t) ?? NO_DATE,
    paint: (ctx, td, row) => {
      td.empty();
      const t = row.task!;
      const fmt = ctx.settings.dateFormat;
      const rolled = ctx.rollup && row.span ? row.span : null;
      if (rolled) {
        td.setText(formatDate(rolled.end, fmt));
        return false;
      }
      td.createSpan({ cls: "ogantt-td-text", text: formatDate(t.end, fmt) + (t.endTime ? ` ${t.endTime}` : "") });
    },
    edit: (ctx, cell, row) => openCellDatePicker(ctx, cell, row.task!, "end"),
    editAria: () => tr().pickDate,
  },
  {
    kind: "cell",
    id: "progress",
    label: () => tr().fieldProgress,
    width: 84,
    optional: true,
    sortKey: (t) => t.progress ?? -1, // 未設定は 0% より前 / unset sorts ahead of 0%
    // 進捗はロールアップ ON でも自分の値を表示・編集する（集約する重みが無いため）
    // progress always shows/edits the task's own value, even when rolled up (there's no weight to aggregate by)
    paint: (_ctx, td, row) => paintProgress(td, row.task!),
    edit: (ctx, cell, row) => {
      const t = row.task!;
      ctx.inlineInput(
        cell,
        t.progress != null ? String(t.progress) : "",
        () => paintProgress(cell, t),
        (v) => commitProgress(ctx, t, v),
        (inp) => {
          inp.type = "number";
          inp.min = "0";
          inp.max = "100";
          inp.step = "5";
        }
      );
    },
    editAria: () => tr().editProgress,
  },
  {
    kind: "cell",
    id: "assignee",
    label: () => tr().fieldAssignee,
    width: 96,
    optional: true,
    sortKey: (t) => (t.assignee ?? "").toLowerCase(),
    paint: (_ctx, td, row) => paintAssignee(td, row.task!),
    edit: (ctx, cell, row) => {
      const t = row.task!;
      ctx.inlineInput(
        cell,
        t.assignee ?? "",
        () => paintAssignee(cell, t),
        async (v) => {
          await ctx.mutate(tr().undoEdit(t.name), [t.path], () => writeField(ctx.app, t.path, ctx.settings.keys.assignee, v || undefined));
          await ctx.refresh();
        },
        (inp) => attachAssigneeSuggestions(ctx, inp)
      );
    },
    editAria: () => tr().editAssignee,
  },
  {
    kind: "cell",
    id: "status",
    label: () => tr().fieldStatus,
    width: 96,
    optional: true,
    // ステータスは設定の定義順（アルファベット順ではない）/ status sorts by the configured order, not alphabetically
    sortKey: (t, s) => {
      if (t.status == null) return 999;
      const i = s.statuses.findIndex((x) => x.id === t.status);
      return i < 0 ? 999 : i;
    },
    paint: (ctx, td, row) => paintStatus(ctx, td, row.task!),
    edit: (ctx, cell, row) => editStatus(ctx, cell, row.task!),
    editAria: () => tr().editStatus,
  },
  {
    kind: "cell",
    id: "tags",
    label: () => tr().fieldTags,
    width: 140,
    optional: true,
    sortKey: (t) => t.tags.join(",").toLowerCase(),
    paint: (ctx, td, row) => paintTags(ctx, td, row.task!),
    // タグは多値なので、セル内入力ではなく詳細パネルと同じチップ＋追加欄をポップオーバーで開く
    // tags are multi-valued, so the cell opens the panel's chips + add field in a popover
    edit: (ctx, cell, row) => openTagEditor(ctx, cell, row.task!),
    editAria: () => tr().editTags,
  },
];

// ----- Custom field の列 / custom field columns -----

// Custom field の列 id / the column id of a custom field
export function customColumnId(f: CustomField): string {
  return `cf:${f.id}`;
}

// Custom field 1 件を列にする（組み込み列の後ろに定義順で並ぶ）/ turn one custom field into a column (after the built-ins, in definition order)
export function customColumn(f: CustomField): CellColumn {
  const name = (): string => f.label.trim() || f.key.trim();
  return {
    kind: "cell",
    id: customColumnId(f),
    label: name,
    width: f.type === "text" ? 120 : 96,
    optional: true,
    // text は大文字小文字無視・未設定が先頭、number は未設定が先頭、date は未設定が末尾（開始・期限と同じ）
    // text: case-insensitive, unset first; number: unset first; date: unset last (like start / due)
    sortKey: (t) => {
      const v = t.custom[f.id];
      if (f.type === "number") return typeof v === "number" ? v : -Number.MAX_VALUE; // -Infinity 同士の差は NaN になるため / -Infinity - -Infinity is NaN
      if (f.type === "date") return typeof v === "string" ? v : NO_DATE;
      return customValueText(v).toLowerCase();
    },
    paint: (ctx, td, row) => {
      td.empty();
      const v = row.task!.custom[f.id];
      if (v == null) return;
      const text = f.type === "date" && typeof v === "string" ? formatDate(v, ctx.settings.dateFormat) : customValueText(v);
      td.createSpan({ cls: "ogantt-td-text", text });
      if (f.type === "number") td.addClass("ogantt-td-number");
    },
    edit: (ctx, cell, row) => {
      const t = row.task!;
      const v = t.custom[f.id];
      // 書き込み＋再読込（取り消し可）/ write, then reload (undoable)
      const write = async (next: CustomValue | undefined): Promise<void> => {
        await ctx.mutate(tr().undoEdit(t.name), [t.path], () => writeField(ctx.app, t.path, f.key.trim(), next));
        await ctx.refresh();
      };
      if (f.type === "date") {
        const d = typeof v === "string" ? v : "";
        const state = { start: d, end: d };
        ctx.openRangePicker(cell, state, "start", () => {}, () => (state.start === d ? undefined : write(state.start || undefined)), name());
        return;
      }
      const repaint = (): void => {
        cell.empty();
        const text = customValueText(v);
        if (text) cell.createSpan({ cls: "ogantt-td-text", text });
      };
      ctx.inlineInput(
        cell,
        customValueText(v),
        repaint,
        async (raw) => {
          const next = parseCustomInput(raw, f.type, Array.isArray(v));
          if (next === null) {
            repaint(); // 数値にならない入力は書き込まない / a non-number isn't written
            return;
          }
          await write(next);
        },
        f.type === "number" ? (inp) => { inp.type = "number"; } : undefined
      );
    },
    editAria: () => tr().editCustomField(name()),
  };
}

// ----- 並び・表示・比較（純粋関数）/ order, visibility and comparison (pure) -----

// 表示中の列（name は常時、その他は visibleColumns に含まれるもの・定義順）
// visible columns: name always, the rest when listed in visibleColumns, in definition order
export function visibleColumns(defs: ColumnDef[], visible: string[]): ColumnDef[] {
  const vis = new Set(visible);
  return defs.filter((c) => !c.optional || vis.has(c.id));
}

// 列の実効幅（ユーザー上書き > 既定）/ effective column width (user override > default)
export function columnWidth(def: ColumnDef, overrides: Record<string, number>): number {
  return overrides[def.id] ?? def.width;
}

// ソート設定からタスク比較関数を作る。未知の列 id は開始日順 / build a task comparator; an unknown column id sorts by start
export function taskComparator(defs: ColumnDef[], settings: GanttSettings): (a: Task, b: Task) => number {
  const def = defs.find((c) => c.id === settings.sortBy) ?? defs.find((c) => c.id === "start")!;
  const dir = settings.sortDir === "desc" ? -1 : 1;
  return (a, b) => {
    const ka = def.sortKey(a, settings);
    const kb = def.sortKey(b, settings);
    const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    return c * dir;
  };
}

// ----- セルの描画・編集 / cell painting and editing -----

// テーブルのセルから範囲カレンダーを開いて日付を直接編集 / open the range calendar from a table cell
function openCellDatePicker(ctx: BoardContext, anchor: HTMLElement, t: Task, which: "start" | "end"): void {
  const k = ctx.settings.keys;
  const state = { start: t.start ?? "", end: t.end ?? "" };
  const save = async (): Promise<void> => {
    // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
    if (state.start && !state.end) state.end = state.start;
    // 既存の時刻は日付変更後も引き継ぐ（同日で逆転したら終了=開始に補正）
    // keep the existing time of day across the date change (clamp if inverted on the same day)
    const ts = t.startTime;
    let te = t.endTime;
    if (state.start && state.start === state.end && ts && te && te < ts) te = ts;
    const tz = ctx.settings.tz;
    await ctx.mutate(tr().undoReschedule(t.name), [t.path], async () => {
      await writeField(ctx.app, t.path, k.start, combineDateTime(state.start || undefined, ts, tz));
      await writeField(ctx.app, t.path, k.end, combineDateTime(state.end || undefined, te, tz));
    });
    await ctx.refresh();
  };
  // repaint はテーブル側では不要（save→refresh で再描画される）/ no chip repaint needed here
  ctx.openRangePicker(anchor, state, which, () => {}, save);
}

// 進捗セルの中身（細いメーター＋%）。未設定でも空メーターと「—」を描き、
// 値の有無に関わらずダブルクリックできる場所だと分かるようにする
// paint a progress cell (thin meter + %); unset still draws an empty meter and a dash,
// so the cell reads as double-click editable whether or not it has a value
function paintProgress(td: HTMLElement, t: Task): void {
  td.empty();
  td.addClass("ogantt-td-progress");
  const p = t.progress != null ? Math.max(0, Math.min(100, Math.round(t.progress))) : null;
  td.toggleClass("is-empty", p == null);
  const track = td.createDiv({ cls: "ogantt-meter" });
  if (p != null) track.createDiv({ cls: "ogantt-meter-fill" }).style.width = `${p}%`;
  td.createSpan({ cls: "ogantt-meter-num", text: p != null ? `${p}%` : "—" });
}

// 進捗の保存。0%・空欄は未設定として削除（詳細パネルのスライダーと同じ規則）
// save progress; 0% and blank clear the field (same rule as the panel slider)
async function commitProgress(ctx: BoardContext, t: Task, raw: string): Promise<void> {
  const n = raw === "" ? 0 : Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
  const next = n > 0 ? n : undefined;
  if (next === t.progress) return;
  await ctx.mutate(tr().undoEdit(t.name), [t.path], () => writeField(ctx.app, t.path, ctx.settings.keys.progress, next));
  await ctx.refresh();
}

// 担当者セル / assignee cell
function paintAssignee(td: HTMLElement, t: Task): void {
  td.empty();
  if (t.assignee) td.createSpan({ cls: "ogantt-td-text", text: t.assignee });
}

// 既存の担当者を入力候補に出して表記ゆれを防ぐ / suggest existing assignees to avoid spelling drift
function attachAssigneeSuggestions(ctx: BoardContext, inp: HTMLInputElement): void {
  const names = [...new Set(ctx.tasks.map((x) => x.assignee).filter((a): a is string => !!a))].sort();
  if (names.length === 0) return;
  ctx.attachSuggestions(inp, (list) => {
    for (const n of names) list.createEl("option", { value: n });
  });
}

// ステータスセル（色ドット＋ラベル）/ status cell (color dot + label)
function paintStatus(ctx: BoardContext, td: HTMLElement, t: Task): void {
  td.empty();
  const s = ctx.settings.statuses.find((x) => x.id === t.status);
  if (!s) return;
  const dot = td.createSpan({ cls: "ogantt-status-dot" });
  dot.style.background = s.color;
  td.createSpan({ cls: "ogantt-td-text", text: s.label });
}

// ステータスは選択肢が決まっているのでセレクトで編集する / status has a fixed set, so it edits as a select
function editStatus(ctx: BoardContext, cell: HTMLElement, t: Task): void {
  if (cell.querySelector("input, select")) return;
  cell.empty();
  const sel = cell.createEl("select", { cls: "ogantt-cell-input" });
  sel.createEl("option", { text: "—", value: "" }); // 未設定に戻す / clear the status
  for (const s of ctx.settings.statuses) {
    const o = sel.createEl("option", { text: s.label, value: s.id });
    if (s.id === t.status) o.selected = true;
  }
  sel.focus();
  // ダブルクリックで一覧まで開く（未対応環境ではフォーカスのみで、クリックすれば開く）
  // open the dropdown right away; where showPicker is unavailable, focus is enough and a click opens it
  try {
    sel.showPicker();
  } catch {
    /* フォーカス済みなので何もしない / already focused, nothing to do */
  }
  let settled = false;
  const finish = (save: boolean): void => {
    if (settled) return;
    settled = true;
    if (!save || sel.value === (t.status ?? "")) {
      paintStatus(ctx, cell, t);
      return;
    }
    void (async () => {
      await ctx.mutate(tr().undoEdit(t.name), [t.path], () =>
        writeField(ctx.app, t.path, ctx.settings.keys.status, sel.value || undefined)
      );
      await ctx.refresh();
    })();
  };
  sel.addEventListener("change", () => finish(true));
  sel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } });
  sel.addEventListener("blur", () => finish(true));
}

// タグセル（多値・チップ表示）/ tags cell (multi-valued chips)
function paintTags(ctx: BoardContext, td: HTMLElement, t: Task): void {
  td.empty();
  td.addClass("ogantt-td-tags");
  for (const tag of t.tags) {
    const chip = td.createSpan({ cls: "ogantt-tag-chip", text: tag });
    ctx.paintTagChip(chip, tag);
    // タグチップを右クリック＝色を変更 / right-click a tag chip to change its color
    chip.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); ctx.openColorMenu(e, "tag", tag); });
  }
}

// タグ編集のポップオーバー（詳細パネルと同じ操作：チップの × で削除、入力＋Enter で追加）
// 1 セルに複数タグを収められないので、日付セルと同じくポップオーバーで開く
// tag editor popover, same interaction as the detail panel: × on a chip removes, input + Enter adds.
// a cell can't hold several tags, so it opens a popover just like the date cell does
function openTagEditor(ctx: BoardContext, anchor: HTMLElement, t: Task): void {
  const path = t.path;
  ctx.openPopover(anchor, "ogantt-tagmenu", (menu) => {
    const build = (): void => {
      menu.empty();
      // 背景 refresh が tasks を作り替えるので、毎回パスから最新を引き直す
      // a background refresh may rebuild the tasks, so look the task up by path every time
      const live = ctx.tasks.find((x) => x.path === path) ?? t;
      // 変更をメモリに反映してから盤面とポップオーバーを描き直す / apply in memory, then redraw board + popover
      const apply = (change: (tags: string[]) => string[]): void => {
        const l = ctx.tasks.find((x) => x.path === path);
        if (l) l.tags = change(l.tags);
        ctx.rerender();
        build();
      };
      const chips = menu.createDiv({ cls: "ogantt-tagmenu-chips" });
      for (const tag of live.tags) {
        const chip = chips.createSpan({ cls: "ogantt-tag-chip" });
        ctx.paintTagChip(chip, tag);
        chip.createSpan({ text: tag });
        const x = chip.createEl("button", { cls: "ogantt-date-x clickable-icon" });
        setIcon(x, "x");
        x.setAttr("aria-label", tr().removeTagAria);
        x.addEventListener("click", () => void (async () => {
          await ctx.mutate(tr().undoRemoveTag(t.name, tag), [path], () => removeTag(ctx.app, path, tag));
          apply((tags) => tags.filter((y) => y !== tag));
        })());
      }
      const add = menu.createEl("input", { cls: "ogantt-tag-add", type: "text" });
      add.placeholder = tr().addTagPlaceholder;
      ctx.attachSingleTagSuggestions(add, live.tags);
      add.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add.blur(); } });
      add.addEventListener("change", () => void (async () => {
        const v = add.value.trim().replace(/^#/, "");
        if (!v) return;
        await ctx.mutate(tr().undoAddTag(t.name, v), [path], async () => (await addTag(ctx.app, path, v)) || false);
        apply((tags) => (tags.includes(v) ? tags : [...tags, v]));
      })());
      add.focus(); // 追加後も入力欄に留まって続けて足せる / keep focus so tags can be added back to back
    };
    build();
  });
}
