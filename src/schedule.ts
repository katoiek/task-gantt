// 稼働日カレンダー・Duration（期間）・依存による後続の連動（すべて純粋関数）
// workday calendar, task duration, and dependency cascading (all pure functions)
import type { Task, DepType } from "./types";
import { dayIndex, dayToStr } from "./timeline";

// 稼働日カレンダー。off＝休日の曜日（0=日 … 6=土）/ workday calendar; off = non-working weekdays (0 = Sun … 6 = Sat)
export interface WorkCalendar {
  off: number[];
}

// 通日番号の曜日（1970-01-01 は木曜）/ weekday of a day index (1970-01-01 was a Thursday)
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

// 全曜日が休みの設定は無効として「毎日が稼働日」に倒す（無限ループ防止）
// a calendar with every weekday off is treated as "every day works" (avoids endless loops)
function offSet(cal: WorkCalendar): Set<number> {
  const s = new Set(cal.off);
  return s.size >= 7 ? new Set() : s;
}

export function isWorkday(day: number, cal: WorkCalendar): boolean {
  return !offSet(cal).has(weekday(day));
}

// day 以降で最初の稼働日（day 自身を含む）/ the first workday on or after `day`
export function nextWorkday(day: number, cal: WorkCalendar): number {
  const off = offSet(cal);
  while (off.has(weekday(day))) day++;
  return day;
}

// day 以前で最後の稼働日（day 自身を含む）/ the last workday on or before `day`
export function prevWorkday(day: number, cal: WorkCalendar): number {
  const off = offSet(cal);
  while (off.has(weekday(day))) day--;
  return day;
}

// [start, end] に含まれる稼働日数（両端を含む。end < start は 0）
// workdays within [start, end], both ends included (0 when end < start)
export function workdaysBetween(start: number, end: number, cal: WorkCalendar): number {
  if (end < start) return 0;
  const off = offSet(cal);
  const span = end - start + 1;
  const weeks = Math.floor(span / 7);
  let n = weeks * (7 - off.size);
  for (let d = start + weeks * 7; d <= end; d++) if (!off.has(weekday(d))) n++;
  return n;
}

// day から n 稼働日進めた日（負なら戻る）。day が休日でも数え方は同じ（着地は必ず稼働日）
// the day n workdays after `day` (before it when n < 0); always lands on a workday
export function addWorkdays(day: number, n: number, cal: WorkCalendar): number {
  const off = offSet(cal);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    day += step;
    if (!off.has(weekday(day))) left--;
  }
  return day;
}

// 開始日から n 稼働日かかるときの期限日（開始日が休日なら次の稼働日から数える・n は 1 以上）
// the due date for an n-workday task starting on `start` (counting from the next workday if start is off; n ≥ 1)
export function endForDuration(start: number, n: number, cal: WorkCalendar): number {
  return addWorkdays(nextWorkday(start, cal), Math.max(1, n) - 1, cal);
}

// 期限日から逆算した開始日（endForDuration の逆）/ the start date back from a due date (the inverse of endForDuration)
export function startForDuration(end: number, n: number, cal: WorkCalendar): number {
  return addWorkdays(prevWorkday(end, cal), -(Math.max(1, n) - 1), cal);
}

// タスクの Duration（稼働日数）。マイルストーンは 0、日付が揃っていなければ undefined
// a task's duration in workdays: 0 for a milestone, undefined unless both dates are set
export function taskDuration(t: Pick<Task, "start" | "end" | "milestone">, cal: WorkCalendar): number | undefined {
  if (t.milestone) return 0;
  if (!t.start || !t.end) return undefined;
  return workdaysBetween(dayIndex(t.start), dayIndex(t.end), cal);
}

// 期間 n の入力を解釈する（"4" / "4d" / "4 days" など）。1 以上の整数でなければ null
// parse a duration entry ("4", "4d", "4 days" …); null unless it's a whole number ≥ 1
export function parseDuration(raw: string): number | null {
  const m = raw.trim().match(/^(\d+)\s*[a-z぀-ヿ一-鿿]*$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 ? n : null;
}

// 期間を保って開始日を移したときの期限日（Wrike 流：開始日の変更はバーの平行移動）。
// 期間 0（休日だけに置かれたタスク）はカレンダー上の長さを保つ
// the due date after moving the start while keeping the duration (Wrike: changing the start moves the bar).
// a zero-workday task (sitting only on days off) keeps its calendar length instead
export function shiftEnd(oldStart: string, oldEnd: string, newStart: string, cal: WorkCalendar): string {
  const s0 = dayIndex(oldStart);
  const e0 = dayIndex(oldEnd);
  const s1 = dayIndex(newStart);
  const dur = workdaysBetween(s0, e0, cal);
  return dayToStr(dur > 0 ? endForDuration(s1, dur, cal) : s1 + (e0 - s0));
}

// 日付の編集結果に Wrike 流の規則を当てる：開始日だけを変えたら（期限日は元のまま）期間を保って期限日も動かす。
// 期限日を変えた・どちらかが未設定・マイルストーンのときは入力どおり
// apply Wrike's rule to a date edit: when only the start changed (the due date is untouched), move the due date
// too, keeping the duration. Otherwise (the due date changed, a date is unset, a milestone) keep the input as is
export function keepDurationOnStartChange(
  orig: Pick<Task, "start" | "end" | "milestone">,
  next: { start: string; end: string },
  cal: WorkCalendar
): string {
  if (orig.milestone || !orig.start || !orig.end || !next.start || !next.end) return next.end;
  if (next.start === orig.start) return next.end;
  // 範囲カレンダーは期限日を越えた開始日を選ぶと期限日を開始日へ引きずる。これも「開始日だけの変更」とみなす
  // the range calendar drags the due date along when the new start passes it; treat that as a start-only change too
  const dragged = next.end === next.start && next.start > orig.end;
  if (next.end !== orig.end && !dragged) return next.end;
  return shiftEnd(orig.start, orig.end, next.start, cal);
}

// ----- 依存による後続の連動 / cascading dates along dependencies -----

export interface ScheduleOptions {
  cal: WorkCalendar;
  // FS の後続を押し出すか（先行が遅れて重なったときだけ動かす）/ push FS successors (only when the predecessor now overlaps them)
  fs: boolean;
}

// 設定からスケジュールの条件を作る / build schedule options from the settings
export function scheduleOptions(s: { nonWorkingDays: number[]; autoScheduleFS: boolean }): ScheduleOptions {
  return { cal: { off: s.nonWorkingDays }, fs: s.autoScheduleFS };
}

type Span = { start?: string; end?: string };

// この依存が連動の対象か / whether this dependency type cascades
function cascades(type: DepType, fs: boolean): boolean {
  return type === "SS" || type === "FF" || (type === "FS" && fs);
}

// 連動しうる後続タスク（推移的・自分は含まない）。Undo のスナップショット対象を書き込み前に決めるために使う
// successors that may be moved, transitively (excluding the root); used to pick undo snapshot targets before writing
export function successorClosure(tasks: Task[], rootPath: string, fs = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootPath]);
  const queue = [rootPath];
  while (queue.length) {
    const pred = queue.shift()!;
    for (const t of tasks) {
      if (seen.has(t.path)) continue;
      if (!t.deps.some((d) => d.path === pred && cascades(d.type, fs))) continue;
      seen.add(t.path);
      out.push(t.path);
      queue.push(t.path);
    }
  }
  return out;
}

// 先行 pred に対する後続 target の新しい日付（動かないなら null）
//   FS: 押し出しのみ。先行の期限の翌稼働日より前に始まっていたら、そこへ期間を保って移す
//   SS / FF: 先行の開始 / 期限にぴったり揃える（期間は稼働日で保つ）
// マイルストーンは固定日なので依存では動かさない
// the successor's new dates against predecessor pred (null when it stays put):
//   FS: push only — if it starts before the workday after pred's due date, move it there, keeping its duration
//   SS / FF: snap to pred's start / due date (the duration is kept in workdays)
// milestones are fixed dates and never move through dependencies
function align(target: Span & { milestone: boolean }, pred: Span & { milestone: boolean }, type: DepType, cal: WorkCalendar): { start: string; end: string } | null {
  if (target.milestone || !target.start || !target.end) return null;
  const ps = pred.milestone ? pred.end ?? pred.start : pred.start;
  const pe = pred.milestone ? pred.end ?? pred.start : pred.end ?? pred.start;
  const s0 = dayIndex(target.start);
  const e0 = dayIndex(target.end);
  const dur = workdaysBetween(s0, e0, cal);
  const len = e0 - s0;
  const fromStart = (s: number) => ({ start: s, end: dur > 0 ? endForDuration(s, dur, cal) : s + len });
  const fromEnd = (e: number) => ({ start: dur > 0 ? startForDuration(e, dur, cal) : e - len, end: e });
  let next: { start: number; end: number };
  if (type === "FS") {
    if (!pe) return null;
    const earliest = nextWorkday(dayIndex(pe) + 1, cal);
    if (s0 >= earliest) return null;
    next = fromStart(earliest);
  } else if (type === "SS") {
    if (!ps) return null;
    next = fromStart(dayIndex(ps));
  } else {
    if (!pe) return null;
    next = fromEnd(dayIndex(pe));
  }
  if (next.start === s0 && next.end === e0) return null;
  return { start: dayToStr(next.start), end: dayToStr(next.end) };
}

// roots を起点に依存をたどり、動かすべき後続の新しい日付を求める（循環はガードで打ち切り）。
// tasks は書き換えない。roots 自身の日付は呼び出し側で更新済みのものを使う
// walk dependencies from the roots and work out new dates for successors that must move
// (cycles stop at a guard). `tasks` isn't mutated; the roots' own dates are taken as already updated
export function cascadeDates(tasks: Task[], roots: string[], opts: ScheduleOptions): Map<string, { start: string; end: string }> {
  const cur = new Map<string, Span & { milestone: boolean }>(tasks.map((t) => [t.path, { start: t.start, end: t.end, milestone: t.milestone }]));
  const changes = new Map<string, { start: string; end: string }>();
  const queue = [...roots];
  let guard = 0;
  while (queue.length && guard++ < 1000) {
    const predPath = queue.shift()!;
    const pred = cur.get(predPath);
    if (!pred) continue;
    for (const succ of tasks) {
      if (succ.path === predPath) continue;
      const dep = succ.deps.find((d) => d.path === predPath);
      if (!dep || !cascades(dep.type, opts.fs)) continue;
      const span = cur.get(succ.path)!;
      const next = align(span, pred, dep.type, opts.cal);
      if (!next) continue;
      span.start = next.start;
      span.end = next.end;
      changes.set(succ.path, next);
      queue.push(succ.path);
    }
  }
  return changes;
}
