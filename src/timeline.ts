import { ZoomMode, Task, DateFormat, DateValue, DateOp } from "./types";

const MS_PER_DAY = 86400000;

// 'YYYY-MM-DD' を UTC の通日番号へ / parse to a UTC day index
export function dayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / MS_PER_DAY);
}

// 通日番号を 'YYYY-MM-DD' へ / day index back to date string
export function dayToStr(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayIndex(): number {
  return Math.floor(Date.now() / MS_PER_DAY);
}

// ISO（YYYY-MM-DD）を表示用フォーマットへ整形 / format an ISO date for display
export function formatDate(iso: string | undefined, fmt: DateFormat): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso; // 解釈できない値はそのまま表示 / pass unparseable values through
  const [, y, mo, d] = m;
  switch (fmt) {
    case "DD/MM/YYYY":
      return `${d}/${mo}/${y}`;
    case "MM/DD/YYYY":
      return `${mo}/${d}/${y}`;
    default:
      return `${y}/${mo}/${d}`;
  }
}

// 表示フォーマットの入力を ISO へ。"" = クリア、null = 不正 / parse a formatted input into ISO. "" = clear, null = invalid
export function parseDate(text: string, fmt: DateFormat): string | null {
  const t = text.trim();
  if (t === "") return "";
  const n = t.split(/[^0-9]+/).filter(Boolean);
  if (n.length !== 3) return null;
  let y: string, mo: string, d: string;
  if (fmt === "DD/MM/YYYY") [d, mo, y] = n;
  else if (fmt === "MM/DD/YYYY") [mo, d, y] = n;
  else [y, mo, d] = n;
  if (y.length !== 4) return null; // 年は4桁必須 / require a 4-digit year
  const mi = +mo, di = +d;
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  const iso = `${y}-${String(mi).padStart(2, "0")}-${String(di).padStart(2, "0")}`;
  // 実在日チェック（例 2026-02-30 を弾く）/ reject impossible dates
  const dt = new Date(`${iso}T00:00:00Z`);
  if (isNaN(dt.getTime()) || dt.getUTCMonth() + 1 !== mi || dt.getUTCDate() !== di) return null;
  return iso;
}

// ── 日付フィルタの解決・判定 / date-filter resolution & matching ──

// DateValue を「今日（today）基準」で通日番号へ解決する。相対値・preset は
// today に依存するため、描画のたびに再評価すれば日付変化に自動追従する。
// resolve a DateValue to day index(es), relative to `today`; recomputing each
// render makes relative/preset values follow the current date automatically.
export function resolveDateValue(v: DateValue, today: number = todayIndex()): { from: number; to?: number } {
  switch (v.kind) {
    case "preset": {
      const off = v.preset === "yesterday" ? -1 : v.preset === "tomorrow" ? 1 : 0;
      return { from: today + off };
    }
    case "specific":
      return { from: dayIndex(v.date) };
    case "relative": {
      const n = (v.dir === "ago" ? -1 : 1) * v.amount;
      if (v.unit === "day") return { from: today + n };
      if (v.unit === "week") return { from: today + n * 7 };
      // month は暦月で加減算（Date.UTC が桁上げを処理）/ month uses calendar arithmetic
      const d = new Date(today * MS_PER_DAY);
      return { from: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()) / MS_PER_DAY) };
    }
    case "range":
      return { from: dayIndex(v.from), to: dayIndex(v.to) };
  }
}

// タスクの日付（通日番号 or 未設定）が 1 件の日付フィルタに合致するか。
// 未設定日は empty 以外の演算子では除外する。値が未完成のフィルタは素通し。
// does a task's date (day index or undefined) satisfy one date filter?
// tasks without the date are excluded for every operator except `empty`;
// an incomplete filter (missing value) is treated as no constraint.
export function matchDate(dayIdx: number | undefined, f: { op: DateOp; value?: DateValue }, today: number = todayIndex()): boolean {
  if (f.op === "empty") return dayIdx === undefined;
  if (f.op === "notEmpty") return dayIdx !== undefined;
  if (!f.value) return true; // 未完成のフィルタは無効 / incomplete filter = no effect
  if (dayIdx === undefined) return false; // 日付なしは除外 / exclude tasks lacking the date
  const r = resolveDateValue(f.value, today);
  if (f.value.kind === "range") return r.to !== undefined && dayIdx >= r.from && dayIdx <= r.to;
  switch (f.op) {
    case "is": return dayIdx === r.from;
    case "before": return dayIdx < r.from;
    case "after": return dayIdx > r.from;
    case "onOrBefore": return dayIdx <= r.from;
    case "onOrAfter": return dayIdx >= r.from;
    default: return true;
  }
}

// ズームごとの 1 日あたりピクセル / pixels per day per zoom
// Fit はコンテナ幅から動的に算出するため、ここでは Week 相当のフォールバック
// Fit is computed from the container width elsewhere; here it falls back to the Week scale
export function pxPerDay(zoom: ZoomMode): number {
  switch (zoom) {
    case "Day":
      return 36;
    case "Week":
      return 16;
    case "Month":
      return 5;
    case "Fit":
      return 16;
  }
}

export interface DateRange {
  min: number; // 開始日（通日）/ first day index
  max: number; // 終了日（通日）/ last day index
}

// タスク群から表示範囲を決める（前後に余白）/ compute the visible range with padding
export function computeRange(tasks: Task[]): DateRange {
  const days: number[] = [];
  // 不正な日付（NaN）は範囲計算から除外して全体崩壊を防ぐ / drop NaN day indices so a bad date can't break the whole range
  const push = (s?: string) => {
    if (!s) return;
    const i = dayIndex(s);
    if (Number.isFinite(i)) days.push(i);
  };
  for (const t of tasks) {
    push(t.start);
    push(t.end);
  }
  if (days.length === 0) {
    const today = todayIndex();
    return { min: today - 7, max: today + 30 };
  }
  return { min: Math.min(...days) - 3, max: Math.max(...days) + 7 };
}

export interface Tick {
  x: number;
  label: string;
  major: boolean; // 月境界など / month boundary
}

// 上部の日付軸の目盛りを生成 / generate header ticks
export function buildTicks(range: DateRange, zoom: ZoomMode, ppd: number): Tick[] {
  const ticks: Tick[] = [];
  const wk = ["日", "月", "火", "水", "木", "金", "土"];
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const x = (day - range.min) * ppd;
    const isMonthStart = d.getUTCDate() === 1;
    if (zoom === "Day") {
      ticks.push({ x, label: `${d.getUTCDate()} ${wk[d.getUTCDay()]}`, major: isMonthStart });
    } else if (zoom === "Week") {
      if (d.getUTCDay() === 1 || isMonthStart) {
        ticks.push({ x, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, major: isMonthStart });
      }
    } else {
      if (isMonthStart) ticks.push({ x, label: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`, major: true });
    }
  }
  return ticks;
}
