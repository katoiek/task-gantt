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
      return 20;
    case "Month":
      return 4;
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

// ── 稲妻線 / progress line ──

// 稲妻線の 1 行分の入力。バーを持たない行（グループ行・日付なし）は startX を省略する
// one row's input for the progress line; rows without a bar (group rows, no dates) omit startX
export interface ProgressLineRow {
  startX?: number; // バー左端の x / bar's left edge
  width?: number; // バー幅（マイルストーンは 0）/ bar width (0 for a milestone)
  progress?: number; // 0-100（未設定＝未着手）/ 0-100 (unset = not started)
}

export interface Point {
  x: number;
  y: number;
}

// 1 行分の稲妻線の x を決める。basisX（基準日）から左へ折れる＝遅れ / 右＝進み
// x for one row: bending left of basisX means behind schedule, right means ahead
export function progressLineX(row: ProgressLineRow, basisX: number): number {
  if (row.startX === undefined) return basisX; // バーなし＝素通し / no bar, pass through
  const p = row.progress ?? 0;
  if (p >= 100) return basisX; // 完了は逸脱なし / done = no deviation
  // 未着手：開始日を過ぎていれば開始日まで遅れ、未来なら逸脱なし
  // not started: behind as far as the start date if it has passed, otherwise no deviation
  if (p <= 0) return Math.min(basisX, row.startX);
  return row.startX + ((row.width ?? 0) * p) / 100;
}

// 稲妻線の折れ線を組む。上端・下端は基準日に戻し、各行は行中央に点を置く
// build the polyline: pinned to basisX at both ends, one point at each row's center
export function buildProgressLine(rows: ProgressLineRow[], basisX: number, rowH: number, height: number): Point[] {
  const pts: Point[] = [{ x: basisX, y: 0 }];
  rows.forEach((row, i) => pts.push({ x: progressLineX(row, basisX), y: i * rowH + rowH / 2 }));
  pts.push({ x: basisX, y: height });
  return pts;
}

export interface Tick {
  x: number;
  label: string;
  major: boolean; // 月境界など / month boundary
}

// 上部の日付軸の目盛りを生成。weekdays は日曜始まりの曜日ラベル / generate header ticks; weekdays = labels, Sunday first
export function buildTicks(range: DateRange, zoom: ZoomMode, ppd: number, weekdays: string[]): Tick[] {
  const ticks: Tick[] = [];
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const x = (day - range.min) * ppd;
    const isMonthStart = d.getUTCDate() === 1;
    if (zoom === "Day") {
      ticks.push({ x, label: `${d.getUTCDate()} ${weekdays[d.getUTCDay()]}`, major: isMonthStart });
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

// 折れ線の角を丸めた SVG のパス（ClickUp のような、なめらかな依存の線）。points を直線でつなぎ、内側の頂点では、頂点の手前 r から、頂点を制御点に、頂点の先 r まで、曲線にする。
// 短い辺では、辺の半分までに r を縮める。同じ点の重なりは捨てる
// an SVG path through the points with rounded corners (smooth dependency lines, like ClickUp's): straight lines, and at each inner vertex a curve from r before it to r after it, with the vertex as the control point.
// On a short segment r shrinks to half of it; repeated points are dropped
export function roundedPolyline(points: [number, number][], r: number): string {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (pts.length === 0) return "";
  const f = (n: number): string => String(Math.round(n * 100) / 100);
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const len1 = Math.hypot(x1 - x0, y1 - y0);
    const len2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, len1 / 2, len2 / 2);
    // まっすぐ続く点（同じ向き）は、曲げずに通す / a point where the line carries straight on isn't bent
    const straight = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1) === 0;
    if (rr <= 0 || straight) {
      d += ` L ${f(x1)} ${f(y1)}`;
      continue;
    }
    const ax = x1 - ((x1 - x0) / len1) * rr;
    const ay = y1 - ((y1 - y0) / len1) * rr;
    const bx = x1 + ((x2 - x1) / len2) * rr;
    const by = y1 + ((y2 - y1) / len2) * rr;
    d += ` L ${f(ax)} ${f(ay)} Q ${f(x1)} ${f(y1)} ${f(bx)} ${f(by)}`;
  }
  if (pts.length > 1) d += ` L ${f(pts[pts.length - 1][0])} ${f(pts[pts.length - 1][1])}`;
  return d;
}

// ── ClickUp 風の 2 段の日付軸（Month だけ Wrike 風）/ the two-row date axis, like ClickUp's (Month alone follows Wrike) ──

// 軸の段階。1＝日（曜日つき）、2＝日、3＝月＋週、4＝年＋月（Wrike 風）。Fit は、1 日の幅から決める
// the axis level: 1 = days with weekdays, 2 = days, 3 = months + weeks, 4 = years + months (Wrike style). Fit picks one from the day width
export type HeaderLevel = 1 | 2 | 3 | 4;
export function headerLevel(zoom: ZoomMode, ppd: number): HeaderLevel {
  if (zoom === "Day") return 1;
  if (zoom === "Week") return 2;
  if (zoom === "Month") return 4;
  return ppd >= 32 ? 1 : ppd >= 12 ? 2 : ppd >= 5 ? 3 : 4;
}

export interface HeaderText {
  weekdays: string[]; // 日曜始まり / Sunday first
  monthName: (m: number) => string; // 1〜12 → 「11月」「Nov」/ 1–12 → "11月", "Nov"
  yearMonth: (y: number, m: number) => string; // 「2026年11月」「Nov 2026」/ "2026年11月", "Nov 2026"
}

export interface HeaderCell {
  x: number; // 左端（軸の左から）/ left edge from the axis start
  w: number;
  label: string;
  sub?: string; // 週の日付の範囲など、ラベルの横に添える文字 / a range text beside the label (the dates of a week)
  strong?: boolean;
  weekend?: boolean; // 休日（非稼働日）/ a non-working day
  today?: boolean;
}

export interface HeaderModel {
  level: HeaderLevel;
  top: HeaderCell[];
  bottom: HeaderCell[];
}

// ISO 週番号（その日を含む週の、木曜の属する年の週）。日曜始まりの週は、日曜の ISO 週番号を、その週の番号にする（ClickUp の W46 と同じ）
// the ISO week number (the week holding that day's Thursday); a Sunday-start week takes the ISO number of its Sunday (the same as ClickUp's W46)
export function isoWeek(day: number): number {
  const d = new Date(day * MS_PER_DAY);
  const dow = (d.getUTCDay() + 6) % 7; // 月曜 = 0 / Monday = 0
  const thursday = new Date(d.getTime() + (3 - dow) * MS_PER_DAY);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / MS_PER_DAY / 7) + 1;
}

// 範囲全体の軸のセルを作る。週は日曜始まり。isWorkday で休日の列に印を付け、today に印を付ける
// build the axis cells for the whole range; weeks start on Sunday; isWorkday marks the non-working days and `today` is marked
export function buildHeader(range: DateRange, level: HeaderLevel, ppd: number, text: HeaderText, isWorkday: (day: number) => boolean, today: number): HeaderModel {
  const top: HeaderCell[] = [];
  const bottom: HeaderCell[] = [];
  const xOf = (day: number): number => (day - range.min) * ppd;
  const ymd = (day: number): { y: number; m: number; d: number; dow: number } => {
    const dt = new Date(day * MS_PER_DAY);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() };
  };
  const clip = (a: number, b: number): [number, number] => [Math.max(a, range.min), Math.min(b, range.max)]; // [a, b]（両端を含む通日）/ inclusive day indexes

  if (level <= 2) {
    // 上段：週（日曜〜土曜）。「W46 11月 15 - 21」/ top row: weeks (Sunday to Saturday), "W46 11月 15 - 21"
    const first = range.min - ymd(range.min).dow;
    for (let ws = first; ws <= range.max; ws += 7) {
      const [a, b] = clip(ws, ws + 6);
      const s = ymd(ws);
      const e = ymd(ws + 6);
      const sub = s.m === e.m ? `${text.monthName(s.m)} ${s.d} - ${e.d}` : `${text.monthName(s.m)} ${s.d} - ${text.monthName(e.m)} ${e.d}`;
      top.push({ x: xOf(a), w: (b - a + 1) * ppd, label: `W${isoWeek(ws)}`, sub, strong: true });
    }
    // 下段：日。幅があれば曜日も / bottom row: days, with the weekday when wide
    for (let day = range.min; day <= range.max; day++) {
      const v = ymd(day);
      bottom.push({ x: xOf(day), w: ppd, label: level === 1 ? `${text.weekdays[v.dow]} ${v.d}` : String(v.d), weekend: !isWorkday(day), today: day === today });
    }
  } else if (level === 3) {
    // 上段：月、下段：週の開始日 / top row: months; bottom row: the first day of each week
    for (let day = range.min; day <= range.max; ) {
      const v = ymd(day);
      const end = Math.min(range.max, day + (new Date(Date.UTC(v.y, v.m, 0)).getUTCDate() - v.d));
      top.push({ x: xOf(day), w: (end - day + 1) * ppd, label: text.yearMonth(v.y, v.m), strong: true });
      day = end + 1;
    }
    const first = range.min - ymd(range.min).dow;
    for (let ws = first; ws <= range.max; ws += 7) {
      const [a, b] = clip(ws, ws + 6);
      bottom.push({ x: xOf(a), w: (b - a + 1) * ppd, label: String(ymd(ws).d), today: today >= a && today <= b });
    }
  } else {
    // 上段：年、下段：月（Wrike 風）/ top row: years; bottom row: months (Wrike style)
    for (let day = range.min; day <= range.max; ) {
      const v = ymd(day);
      const endOfYear = Math.floor(Date.UTC(v.y + 1, 0, 1) / MS_PER_DAY) - 1;
      const end = Math.min(range.max, endOfYear);
      top.push({ x: xOf(day), w: (end - day + 1) * ppd, label: String(v.y), strong: true });
      day = end + 1;
    }
    for (let day = range.min; day <= range.max; ) {
      const v = ymd(day);
      const end = Math.min(range.max, day + (new Date(Date.UTC(v.y, v.m, 0)).getUTCDate() - v.d));
      bottom.push({ x: xOf(day), w: (end - day + 1) * ppd, label: text.monthName(v.m), today: today >= day && today <= end });
      day = end + 1;
    }
  }
  return { level, top, bottom };
}

// 休日（非稼働日）が続く区間 [from, to]（通日・両端を含む）を、範囲の中から集める。斜線の塗りに使う
// the runs [from, to] (inclusive day indexes) of non-working days inside the range, for the hatched fill
export function offRuns(range: DateRange, isWorkday: (day: number) => boolean): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let day = range.min; day <= range.max; day++) {
    if (!isWorkday(day)) {
      if (start === null) start = day;
    } else if (start !== null) {
      runs.push([start, day - 1]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, range.max]);
  return runs;
}
