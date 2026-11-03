import { ZoomMode, Task, DateFormat, DateValue, DateOp } from "./types";

const MS_PER_DAY = 86400000;
// 日付軸のラベル同士の最小間隔(px)。週・月の目盛りは言語によって長い（"9 нояб." など）ので広めに
// the narrowest gap between two axis labels (px); week and month labels run long in some languages ("9 нояб.")
const MIN_TICK_GAP = 36;
const MIN_TICK_GAP_WIDE = 56;

// 'YYYY-MM-DD' を UTC の通日番号へ / parse to a UTC day index
export function dayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / MS_PER_DAY);
}

// 通日番号を 'YYYY-MM-DD' へ / day index back to date string
export function dayToStr(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

// 設定タイムゾーン（"system"＝端末の暦、"+09:00" などの固定オフセット）で今日。UTC で数えると、日本では朝 9 時まで前日になる
// today in the configured timezone ("system" = the device's calendar, or a fixed offset like "+09:00"); counting in UTC would
// give yesterday until 9 am in Japan, and tomorrow on a US evening
export function todayIndex(now = new Date(), tz = "system"): number {
  const offset = fixedOffset(tz);
  if (offset == null) return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY);
  return Math.floor((now.getTime() + offset * 60000) / MS_PER_DAY);
}

// 固定オフセットのタイムゾーン（"+09:00" など）を分へ。"system" は null（端末の時差をその都度使う）
// a fixed-offset timezone ("+09:00", …) in minutes; "system" gives null (the device's offset applies, case by case)
export function fixedOffset(tz: string): number | null {
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
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
export function computeRange(tasks: Task[], today = todayIndex()): DateRange {
  const days: number[] = [];
  // 不正な日付（NaN）は範囲計算から除外して全体崩壊を防ぐ / drop NaN day indices so a bad date can't break the whole range
  // 今日から 20 年より離れた日付（年の打ち間違いなど）は範囲に入れない。タスクは表に残る
  // dates more than 20 years from today (a mistyped year, say) stay out of the range; the task still shows in the table
  const push = (s?: string) => {
    if (!s) return;
    const i = dayIndex(s);
    if (Number.isFinite(i) && Math.abs(i - today) <= 20 * 366) days.push(i);
  };
  for (const t of tasks) {
    push(t.start);
    push(t.end);
  }
  if (days.length === 0) {
    return { min: today - 7, max: today + 30 };
  }
  return { min: Math.min(...days) - 3, max: Math.max(...days) + 7 };
}

// ── 終わりの無いタイムライン：横スクロールが端に近づいたら、タスクの範囲の前後に日を足していく ──
// ── the endless timeline: as the horizontal scroll nears an edge, days are added before or after the tasks' range ──

// タスクの範囲の前後に足した日数 / the days added before and after the tasks' range
export interface RangePad {
  before: number;
  after: number;
}

// 端に近づいたとき 1 回に足す日数（Day は 4 週、Week は 3 か月、Month は 1 年）。Fit はのばさない
// the days added each time an edge comes near (Day: four weeks, Week: three months, Month: a year); Fit doesn't grow
export function extendChunk(zoom: ZoomMode): number {
  return zoom === "Day" ? 28 : zoom === "Week" ? 91 : zoom === "Month" ? 365 : 0;
}

// スクロールで片側に足せる上限（Day は 1 年、Week は 3 年、Month は 10 年）。DOM と描画の大きさを有限に保つ
// the most scrolling can add on one side (Day: a year, Week: three years, Month: ten); keeps the DOM and drawing bounded
export function extendLimit(zoom: ZoomMode): number {
  return zoom === "Day" ? 366 : zoom === "Week" ? 3 * 366 : zoom === "Month" ? 10 * 366 : 0;
}

// 片側を、少なくとも need 日（端の帯から出るのに要る分）を 1 回分ずつ切り上げてのばした余白。上限で止まり、のびなければ null
// the pad grown on one side by at least `need` days (what it takes to leave the edge zone), rounded up to whole chunks; stops at the limit, null when it can't grow
export function growPad(pad: RangePad, side: keyof RangePad, zoom: ZoomMode, need = 0): RangePad | null {
  const chunk = extendChunk(zoom);
  if (!chunk) return null;
  const next = Math.min(extendLimit(zoom), pad[side] + Math.max(1, Math.ceil(need / chunk)) * chunk);
  return next > pad[side] ? { ...pad, [side]: next } : null;
}

// タスクの範囲に余白を足した表示範囲 / the shown range: the tasks' range plus the pad
export function padRange(r: DateRange, pad: RangePad): DateRange {
  return { min: r.min - pad.before, max: r.max + pad.after };
}

// day が表示範囲に（1 回分の余裕をもって）入る余白。今日へ飛ぶ・縮尺を変えるときに使うので、上限より広くてもよい
// a pad that brings `day` into the shown range with a chunk to spare; used for jumps (Today, a zoom change), so it may exceed the limit
export function padToCover(base: DateRange, pad: RangePad, day: number, zoom: ZoomMode): RangePad {
  const chunk = extendChunk(zoom);
  return { before: Math.max(pad.before, Math.ceil(base.min - day) + chunk), after: Math.max(pad.after, Math.ceil(day - base.max) + chunk) };
}

// どちらの端に近いか（残りが margin 以下）。両方なら左から / which edge is within `margin` of the view, if any (the left one first)
export function nearEdge(scrollLeft: number, clientWidth: number, scrollWidth: number, margin: number): keyof RangePad | null {
  if (scrollLeft < margin) return "before";
  if (scrollLeft + clientWidth > scrollWidth - margin) return "after";
  return null;
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

// 上部の日付軸の目盛りを生成（Day＝毎日、Week＝月曜と月初、Month＝月初）。文字列は label が作る（言語ごとの書式は呼び出し側）。
// ラベル同士が詰まりすぎる目盛りは間引き、月初（major）と重なる通常の目盛りは月初を残す
// generate header ticks (Day: every day, Week: Mondays and month starts, Month: month starts); `label` writes the text,
// so the caller owns the locale. A tick too close to the previous one is dropped, except that a month start (major)
// replaces the regular tick it would collide with
export function buildTicks(range: DateRange, zoom: ZoomMode, ppd: number, label: (d: Date, zoom: ZoomMode) => string): Tick[] {
  const ticks: Tick[] = [];
  const gap = zoom === "Day" ? MIN_TICK_GAP : MIN_TICK_GAP_WIDE;
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const x = (day - range.min) * ppd;
    const major = d.getUTCDate() === 1;
    if (!(zoom === "Day" || (zoom === "Week" && (d.getUTCDay() === 1 || major)) || (zoom === "Month" && major))) continue;
    const text = label(d, zoom);
    const prev = ticks[ticks.length - 1];
    if (prev && x - prev.x < gap) {
      if (major && !prev.major) ticks[ticks.length - 1] = { x, label: text, major };
      continue;
    }
    ticks.push({ x, label: text, major });
  }
  return ticks;
}

// 目盛りの上の帯：Day/Week は月、Month は年の区切りに見出し（左端にも今の月・年を出す）
// the band above the ticks: a heading at each month (Day/Week) or year (Month), plus one at the left edge for the current one
export function buildBands(range: DateRange, zoom: ZoomMode, ppd: number, label: (d: Date) => string): Tick[] {
  const out: Tick[] = [];
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const start = d.getUTCDate() === 1 && (zoom !== "Month" || d.getUTCMonth() === 0);
    if (day === range.min || start) out.push({ x: (day - range.min) * ppd, label: label(d), major: start });
  }
  // 左端の見出しのすぐ後に区切りが来るなら左端の分は出さない（重なるため）/ drop the left-edge heading when a boundary follows right after it
  if (out.length > 1 && out[1].x - out[0].x < MIN_TICK_GAP_WIDE * 2) out.shift();
  return out;
}
