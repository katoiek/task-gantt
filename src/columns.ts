// テーブル列の定義（ラベル・幅・並べ替え・描画・インライン編集を 1 か所に）
// table column definitions: label, width, sorting, painting and inline editing in one place
import type { BoardContext } from "./board";
import type { GanttSettings } from "./settings";
import type { Row, Task, CustomField, CustomValue } from "./types";
import {
  anchorStart,
  anchorEnd,
  writeField,
  customValueText,
  parseCustomInput,
} from "./model";
import { formatDate, dayIndex, dayToStr, todayIndex } from "./timeline";
import { endForDuration, parseDuration, scheduleOptions, taskDuration, workdaysBetween } from "./schedule";
import { linkLabel } from "./links";
import { besideHeading } from "./filter";
import { handleLinkClick, renderLinkValue } from "./linkui";
import { openPopover } from "./popover";
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
    id: "duration",
    label: () => tr().colDuration,
    width: 64,
    optional: true,
    // 未設定（日付なし）は 0 日より前 / unset (no dates) sorts ahead of zero
    sortKey: (t, s) => taskDuration(t, scheduleOptions(s).cal) ?? -1,
    paint: (ctx, td, row) => {
      td.empty();
      td.addClass("ogantt-td-number");
      const cal = scheduleOptions(ctx.settings).cal;
      // ロールアップ ON の親は集約範囲の期間（編集不可）/ a rolled-up parent shows its span's duration (read-only)
      const rolled = ctx.rollup && row.span ? row.span : null;
      if (rolled) {
        td.setText(tr().durationDays(workdaysBetween(dayIndex(rolled.start), dayIndex(rolled.end), cal)));
        return false;
      }
      const t = row.task!;
      // マイルストーンは期間を持たない（期限日だけの点）/ a milestone has no duration (a single due date)
      if (t.milestone) return false;
      paintDuration(ctx, td, t);
    },
    edit: (ctx, cell, row) => {
      const t = row.task!;
      const cal = scheduleOptions(ctx.settings).cal;
      const cur = taskDuration(t, cal);
      ctx.inlineInput(
        cell,
        cur != null ? String(cur) : "",
        () => paintDuration(ctx, cell, t),
        async (raw) => {
          const n = parseDuration(raw);
          if (n == null || n === cur) {
            paintDuration(ctx, cell, t); // 1 以上の整数でなければ書かない / only a whole number ≥ 1 is written
            return;
          }
          // 開始日は保ち期限日を動かす（開始日が無ければ今日から）/ keep the start and move the due date (from today when unset)
          const start = t.start ?? dayToStr(todayIndex(undefined, ctx.settings.tz));
          const end = dayToStr(endForDuration(dayIndex(start), n, cal));
          await ctx.reschedule(t.path, { start, end }, { start: t.startTime, end: t.endTime });
        },
        (inp) => {
          inp.type = "number";
          inp.min = "1";
          inp.step = "1";
        }
      );
    },
    editAria: () => tr().editDuration,
  },
  {
    kind: "cell",
    id: "progress",
    label: () => tr().fieldProgress,
    width: 84,
    optional: true,
    sortKey: (t) => t.progress ?? -1, // 未設定は 0% より前 / unset sorts ahead of 0%
    // 進捗はロールアップ ON でも自分の値を表示・編集する（集約する重みが無いため）。
    // カードのあるカンバンはチェックしたカードから計算するので、ここでは編集しない（ホバーで内訳）
    // progress always shows/edits the task's own value, even when rolled up (there's no weight to aggregate by);
    // a kanban with cards works it out from its checked cards, so it isn't edited here (hover for the count)
    paint: (_ctx, td, row) => {
      const t = row.task!;
      paintProgress(td, t);
      if (!t.cards) return;
      td.setAttr("aria-label", tr().kanbanProgress(t.cards.done, t.cards.total));
      return false;
    },
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
    sortKey: (t) => t.assignees.map(linkLabel).join(",").toLowerCase(),
    paint: (ctx, td, row) => paintAssignee(ctx, td, row.task!, besideHeading(row.task!.assignees, "assignees", ctx.groupBy, row.group)),
    // 担当者は多値なので、タグと同じくチップ＋追加欄をポップオーバーで開く / multi-valued like tags, so it opens chips + an add field
    edit: (ctx, cell, row) => openListEditor(ctx, cell, row.task!, "assignees"),
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
    paint: (ctx, td, row) => paintTags(ctx, td, besideHeading(row.task!.tags, "tags", ctx.groupBy, row.group)),
    // タグは多値なので、セル内入力ではなく詳細パネルと同じチップ＋追加欄をポップオーバーで開く
    // tags are multi-valued, so the cell opens the panel's chips + add field in a popover
    edit: (ctx, cell, row) => openListEditor(ctx, cell, row.task!, "tags"),
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

// 列の並び：name が先頭、任意列は保存した順。順に無い列（以前の保存データ・新しい Custom field）は定義順で後ろへ、知らない id は無視
// the column order: name first, optional columns as saved; columns missing from it (older saved data, a new custom field)
// follow in definition order, and unknown ids are ignored
export function orderedColumns(defs: ColumnDef[], order: string[]): ColumnDef[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const at = (c: ColumnDef): number => (c.optional ? rank.get(c.id) ?? order.length + defs.indexOf(c) : -1);
  return defs.slice().sort((a, b) => at(a) - at(b));
}

// 表示中の列（name は常時、その他は visibleColumns に含まれるもの・保存した順）
// visible columns: name always, the rest when listed in visibleColumns, in the saved order
export function visibleColumns(defs: ColumnDef[], visible: string[], order: string[] = []): ColumnDef[] {
  const vis = new Set(visible);
  return orderedColumns(defs, order).filter((c) => !c.optional || vis.has(c.id));
}

// 列の一覧（表示メニューと設定画面）：表示中の任意列が順に、その下に隠した列。隠した列も並べ替え・再表示・幅の変更ができる
// the column list (Display menu and settings): shown optional columns in order, then the hidden ones, which can still be reordered, re-shown and resized
export function columnList(defs: ColumnDef[], visible: string[], order: string[]): { col: ColumnDef; on: boolean }[] {
  const vis = new Set(visible);
  const opt = orderedColumns(defs, order).filter((c) => c.optional);
  return [...opt.filter((c) => vis.has(c.id)), ...opt.filter((c) => !vis.has(c.id))].map((col) => ({ col, on: vis.has(col.id) }));
}

// 列の表示を切り替える。順は一覧の見たままで保存する（隠した列は隠した列の先頭へ、戻した列は表示中の最後へ）
// show or hide a column; the order is saved as the list shows it (a hidden column goes to the top of the hidden ones, a re-shown one to the end of the shown)
// 返す形は設定のキーと同じ（そのまま Object.assign できる）/ returned under the settings' own keys, ready for Object.assign
export function toggleColumn(defs: ColumnDef[], visible: string[], order: string[], id: string, on: boolean): { visibleColumns: string[]; columnOrder: string[] } {
  const list = columnList(defs, visible, order);
  const vis = new Set(visible);
  if (on) vis.add(id);
  else vis.delete(id);
  return { visibleColumns: list.filter((x) => vis.has(x.col.id)).map((x) => x.col.id), columnOrder: list.map((x) => x.col.id) };
}

// 一覧の中で 1 つ上（dir=-1）か下（+1）へ。表示中と隠した列の境目は越えない（越えられなければ null）
// move a column one up (dir = -1) or down (+1) in the list, never across the shown/hidden boundary (null when it can't move)
export function moveColumn(defs: ColumnDef[], visible: string[], order: string[], id: string, dir: -1 | 1): string[] | null {
  const list = columnList(defs, visible, order);
  const i = list.findIndex((x) => x.col.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length || list[j].on !== list[i].on) return null;
  [list[i], list[j]] = [list[j], list[i]];
  return list.map((x) => x.col.id);
}

// 列の実効幅（ユーザー上書き > 既定）/ effective column width (user override > default)
export function columnWidth(def: ColumnDef, overrides: Record<string, number>): number {
  return overrides[def.id] ?? def.width;
}

// ソート設定からタスク比較関数を作る。未知の列 id は開始日順 / build a task comparator; an unknown column id sorts by start
export function taskComparator(defs: ColumnDef[], settings: GanttSettings): (a: Task, b: Task) => number {
  const def = defs.find((c) => c.id === settings.sortBy) ?? defs.find((c) => c.id === "start")!;
  const dir = settings.sortDir === "desc" ? -1 : 1;
  // 並べ替えの間はタスクごとのキーを覚える（比較のたびに作り直さない）/ keep each task's key for the sort (not rebuilt on every comparison)
  const keys = new Map<Task, ReturnType<ColumnDef["sortKey"]>>();
  const key = (t: Task) => {
    if (!keys.has(t)) keys.set(t, def.sortKey(t, settings));
    return keys.get(t)!;
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    return c * dir;
  };
}

// ----- セルの描画・編集 / cell painting and editing -----

// テーブルのセルから範囲カレンダーを開いて日付を直接編集 / open the range calendar from a table cell
function openCellDatePicker(ctx: BoardContext, anchor: HTMLElement, t: Task, which: "start" | "end"): void {
  const state = { start: t.start ?? "", end: t.end ?? "" };
  const save = async (): Promise<void> => {
    // 「開始のみ・終了なし」は無効ルール → 終了=開始 / "start only" isn't valid: fill end = start
    if (state.start && !state.end) state.end = state.start;
    // 既存の時刻は日付変更後も引き継ぐ（同日で逆転したら終了=開始に補正）
    // keep the existing time of day across the date change (clamp if inverted on the same day)
    const ts = t.startTime;
    let te = t.endTime;
    if (state.start && state.start === state.end && ts && te && te < ts) te = ts;
    await ctx.reschedule(t.path, state, { start: ts, end: te });
  };
  // repaint はテーブル側では不要（save→refresh で再描画される）/ no chip repaint needed here
  ctx.openRangePicker(anchor, state, which, () => {}, save);
}

// 期間セル（稼働日数）。日付が無いときは空欄 / duration cell in workdays; blank when the dates aren't set
function paintDuration(ctx: BoardContext, td: HTMLElement, t: Task): void {
  td.empty();
  const d = taskDuration(t, scheduleOptions(ctx.settings).cal);
  if (d != null) td.createSpan({ cls: "ogantt-td-text", text: tr().durationDays(d) });
}

// 進捗セルの中身（細いメーター＋%）。未設定でも空メーターと「—」を描き、
// 値の有無に関わらずダブルクリックできる場所だと分かるようにする
// paint a progress cell (thin meter + %); unset still draws an empty meter and a dash,
// so the cell reads as double-click editable whether or not it has a value
// 表示する進捗（0〜100 の整数。未設定・数でない値は null）。表・パネル・ホバーカードで同じ値を出す
// the progress to show (a whole number 0–100; unset or not a number is null), the same in the table, the panel and the hover card
export function progressPct(t: Task): number | null {
  return t.progress != null && Number.isFinite(t.progress) ? Math.max(0, Math.min(100, Math.round(t.progress))) : null;
}

export function paintProgress(td: HTMLElement, t: Task): void {
  td.empty();
  td.addClass("ogantt-td-progress");
  const p = progressPct(t);
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

// 担当者セル（アバター＋名前。wikilink ならクリックでノートを開く）。担当者でグループ化しているときは、見出しの人を繰り返さず
// ほかの人だけを「+」付きで出す / assignee cell: avatars + names (a wikilink opens its note on click). When grouped by assignee,
// the heading's person isn't repeated: only the others show, after a "+"
function paintAssignee(ctx: BoardContext, td: HTMLElement, t: Task, people: string[]): void {
  td.empty();
  td.addClass("ogantt-td-people");
  for (const a of people) ctx.avatar(td, a);
  const names = td.createSpan({ cls: "ogantt-td-text" });
  if (people.length < t.assignees.length && people.length) names.appendText("+ ");
  people.forEach((a, i) => {
    if (i) names.appendText(", ");
    renderLinkValue(names, a, "").addEventListener("click", (e) => handleLinkClick(ctx.app, e, t.path));
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
  const sel = cell.createEl("select", { cls: "ogantt-cell-input", attr: { "aria-label": tr().fieldStatus } });
  sel.createEl("option", { text: "—", value: "" }); // 未設定に戻す / clear the status
  // 一覧に無いステータス（消した・打ち間違い）もそのまま選んでおく（閉じただけで消さない）/ keep a status the list doesn't know selected, so closing the editor doesn't erase it
  if (t.status && !ctx.settings.statuses.some((s) => s.id === t.status)) sel.createEl("option", { text: t.status, value: t.status }).selected = true;
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
function paintTags(ctx: BoardContext, td: HTMLElement, tags: string[]): void {
  td.empty();
  td.addClass("ogantt-td-tags");
  for (const tag of tags) {
    const chip = td.createSpan({ cls: "ogantt-tag-chip", text: tag });
    ctx.paintTagChip(chip, tag);
    // タグチップを右クリック＝色を変更 / right-click a tag chip to change its color
    chip.addEventListener("contextmenu", (e) => ctx.openTagMenu(e, tag));
  }
}

// 多値（タグ・担当者）の編集ポップオーバー。1 セルに収まらないので、詳細パネルと同じチップ＋追加欄を開く
// the editor popover of a multi-valued column (tags, assignees): a cell can't hold several values, so it opens the panel's chips + add field
function openListEditor(ctx: BoardContext, anchor: HTMLElement, t: Task, field: "tags" | "assignees"): void {
  openPopover(anchor, "ogantt-tagmenu", (menu) => {
    const build = (): void => {
      menu.empty();
      ctx.chipList(menu, t.path, field, build).focus(); // 追加後も入力欄に留まって続けて足せる / stay in the field to add more
    };
    build();
  });
}
