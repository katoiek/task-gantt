// 日付フィルタの解決・判定（resolveDateValue / matchDate）と稲妻線ジオメトリの検証
// Tests for date-filter resolution/matching and progress-line geometry
import { resolveDateValue, matchDate, dayIndex, dayToStr, todayIndex, progressLineX, buildProgressLine, buildTicks, buildBands } from "./timeline.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok  -", name);
  } else {
    fail++;
    console.error("FAIL  -", name);
  }
}

// 固定の「今日」を通日番号で用意（2026-07-19）/ a fixed `today` day index
const TODAY = dayIndex("2026-07-19");
const idx = (iso) => dayIndex(iso);

// ── resolveDateValue ──
check("preset today", resolveDateValue({ kind: "preset", preset: "today" }, TODAY).from === TODAY);
check("preset yesterday", resolveDateValue({ kind: "preset", preset: "yesterday" }, TODAY).from === TODAY - 1);
check("preset tomorrow", resolveDateValue({ kind: "preset", preset: "tomorrow" }, TODAY).from === TODAY + 1);
check("specific", resolveDateValue({ kind: "specific", date: "2026-08-01" }, TODAY).from === idx("2026-08-01"));
check("relative 3 day fromNow", resolveDateValue({ kind: "relative", amount: 3, unit: "day", dir: "fromNow" }, TODAY).from === TODAY + 3);
check("relative 2 week ago", resolveDateValue({ kind: "relative", amount: 2, unit: "week", dir: "ago" }, TODAY).from === TODAY - 14);
// 暦月：2026-07-19 + 1 month = 2026-08-19 / calendar month
check("relative 1 month fromNow = 8/19", resolveDateValue({ kind: "relative", amount: 1, unit: "month", dir: "fromNow" }, TODAY).from === idx("2026-08-19"));
check("relative 1 month ago = 6/19", resolveDateValue({ kind: "relative", amount: 1, unit: "month", dir: "ago" }, TODAY).from === idx("2026-06-19"));
// 暦月の桁上げ：2026-07-19 + 12 month = 2027-07-19 / month carries into next year
check("relative 12 month fromNow = 2027-07-19", resolveDateValue({ kind: "relative", amount: 12, unit: "month", dir: "fromNow" }, TODAY).from === idx("2027-07-19"));
const range = resolveDateValue({ kind: "range", from: "2026-07-01", to: "2026-07-31" }, TODAY);
check("range 両端", range.from === idx("2026-07-01") && range.to === idx("2026-07-31"));

// ── matchDate ──
const day = (iso) => idx(iso);
const F = (op, value) => ({ field: "start", op, value });

// is / before / after / onOrBefore / onOrAfter（value = tomorrow 基準）/ operator boundaries
const tom = { kind: "preset", preset: "tomorrow" }; // = TODAY+1
check("is 一致", matchDate(TODAY + 1, F("is", tom), TODAY) === true);
check("is 不一致", matchDate(TODAY, F("is", tom), TODAY) === false);
check("before 真", matchDate(TODAY, F("before", tom), TODAY) === true);
check("before 境界は偽", matchDate(TODAY + 1, F("before", tom), TODAY) === false);
check("after 真", matchDate(TODAY + 2, F("after", tom), TODAY) === true);
check("after 境界は偽", matchDate(TODAY + 1, F("after", tom), TODAY) === false);
check("onOrBefore 境界は真", matchDate(TODAY + 1, F("onOrBefore", tom), TODAY) === true);
check("onOrBefore 真", matchDate(TODAY, F("onOrBefore", tom), TODAY) === true);
check("onOrBefore 偽", matchDate(TODAY + 2, F("onOrBefore", tom), TODAY) === false);
check("onOrAfter 境界は真", matchDate(TODAY + 1, F("onOrAfter", tom), TODAY) === true);
check("onOrAfter 偽", matchDate(TODAY, F("onOrAfter", tom), TODAY) === false);

// range（op="is"）/ range membership
const rangeF = F("is", { kind: "range", from: "2026-07-01", to: "2026-07-31" });
check("range 内は真", matchDate(day("2026-07-15"), rangeF, TODAY) === true);
check("range 端(from)は真", matchDate(day("2026-07-01"), rangeF, TODAY) === true);
check("range 端(to)は真", matchDate(day("2026-07-31"), rangeF, TODAY) === true);
check("range 外は偽", matchDate(day("2026-08-01"), rangeF, TODAY) === false);

// empty / notEmpty と 空日付の除外 / empty handling
check("empty: 未設定は真", matchDate(undefined, F("empty"), TODAY) === true);
check("empty: 設定ありは偽", matchDate(TODAY, F("empty"), TODAY) === false);
check("notEmpty: 設定ありは真", matchDate(TODAY, F("notEmpty"), TODAY) === true);
check("notEmpty: 未設定は偽", matchDate(undefined, F("notEmpty"), TODAY) === false);
check("空日付は before で除外", matchDate(undefined, F("before", tom), TODAY) === false);
check("空日付は onOrAfter で除外", matchDate(undefined, F("onOrAfter", tom), TODAY) === false);

// 値未完成のフィルタは素通し / incomplete filter = no effect
check("value なしは素通し", matchDate(TODAY, { field: "start", op: "is" }, TODAY) === true);

// ── 稲妻線 / progress line ──
// 基準日 x=100 とし、幅 100 のバーを基準日の左右に置いて判定する
// basis at x=100, with 100px-wide bars placed around it
const BASIS = 100;
const px = (row) => progressLineX(row, BASIS);

// 完了は逸脱なし（バー位置に関係なく基準日）/ done never deviates
check("完了(100%)は基準日", px({ startX: 0, width: 100, progress: 100 }) === BASIS);
check("完了(超過値)も基準日", px({ startX: 0, width: 100, progress: 120 }) === BASIS);

// 進捗ありは「バー上の到達点」/ in-progress lands on the bar
check("進捗50%はバー中央", px({ startX: 0, width: 100, progress: 50 }) === 50);
check("進捗50%が基準日より右なら進み", px({ startX: 80, width: 100, progress: 50 }) === 130);
check("進捗25%は遅れ側", px({ startX: 50, width: 100, progress: 25 }) === 75);

// 未着手：開始日を過ぎていれば開始日まで遅れ、未来なら逸脱なし
// not started: behind to the start date if past, no deviation if future
check("未着手(未設定)で開始日が過去なら開始日", px({ startX: 40, width: 100 }) === 40);
check("未着手(0%)で開始日が過去なら開始日", px({ startX: 40, width: 100, progress: 0 }) === 40);
check("未着手で開始日が未来なら基準日", px({ startX: 160, width: 100 }) === BASIS);

// バーを持たない行（グループ行・日付なし）は素通し / rows without a bar pass through
check("バーなしは素通し", px({}) === BASIS);
check("バーなし(進捗つき)も素通し", px({ progress: 50 }) === BASIS);

// マイルストーン（幅 0）は 0%＝菱形位置 / 100%＝基準日
// milestones (width 0): 0% sits on the diamond, 100% on the basis
check("マイルストーン未達は菱形位置", px({ startX: 30, width: 0 }) === 30);
check("マイルストーン達成は基準日", px({ startX: 30, width: 0, progress: 100 }) === BASIS);

// 折れ線の組み立て：両端は基準日、各行は行中央 / polyline ends pinned to basis, points at row centers
const line = buildProgressLine(
  [{ startX: 0, width: 100, progress: 50 }, {}, { startX: 40, width: 100 }],
  BASIS,
  30,
  90
);
check("折れ線の点数 = 行数+2", line.length === 5);
check("折れ線の先頭は基準日の上端", line[0].x === BASIS && line[0].y === 0);
check("折れ線の末尾は基準日の下端", line[4].x === BASIS && line[4].y === 90);
check("1行目は行中央(y=15)で x=50", line[1].x === 50 && line[1].y === 15);
check("2行目(バーなし)は基準日で y=45", line[2].x === BASIS && line[2].y === 45);
check("3行目は開始日 x=40 で y=75", line[3].x === 40 && line[3].y === 75);
check("行が空でも両端だけ返す", buildProgressLine([], BASIS, 30, 0).length === 2);

// 日付軸：月初の目盛りが近くの月曜と重なるときは月初を残す（2026-11-01 は日曜、11-02 は月曜）
// date axis: a month start that collides with a nearby Monday wins (2026-11-01 is a Sunday, 11-02 a Monday)
const WD = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const lbl = (d, z) => (z === "Day" ? `${d.getUTCDate()} ${WD[d.getUTCDay()]}` : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`);
const wk = buildTicks({ min: dayIndex("2026-10-26"), max: dayIndex("2026-11-10") }, "Week", 16, lbl);
check("週目盛り: 10/26, 11/1, 11/9（11/2 は 11/1 と重なるので省く）", wk.map((t) => t.label).join(" ") === "10/26 11/1 11/9");
check("週目盛り: 月初は major", wk[1].major && !wk[0].major);
const dayTicks = buildTicks({ min: dayIndex("2026-10-01"), max: dayIndex("2026-10-04") }, "Day", 20, lbl);
check("日目盛り: 詰まりすぎる日は間引く", dayTicks.map((t) => t.label).join(" ") === "1 Th 3 Sa");
// 目盛りの書式は呼び出し側（言語ごと）。日-月の順の言語でも月初の扱いは同じ / the caller owns the format; day-month locales behave the same
const fr = new Intl.DateTimeFormat("fr", { day: "numeric", month: "short", timeZone: "UTC" });
check("週目盛り: 書式は label 次第（fr）", buildTicks({ min: dayIndex("2026-11-01"), max: dayIndex("2026-11-02") }, "Week", 16, (d) => fr.format(d))[0].label === "1 nov.");

// 目盛りの上の帯：左端に今の月、月の区切りごとに見出し / the band: the current month at the left edge, then one per month
const band = buildBands({ min: dayIndex("2026-10-10"), max: dayIndex("2026-12-05") }, "Week", 16, (d) => `${d.getUTCMonth() + 1}`);
check("帯: 10 月（左端）・11 月・12 月", band.map((b) => b.label).join(" ") === "10 11 12" && band[0].x === 0 && band[1].major);
const yearBand = buildBands({ min: dayIndex("2026-11-10"), max: dayIndex("2027-02-01") }, "Month", 5, (d) => `${d.getUTCFullYear()}`);
check("帯(Month): 年の区切りだけ", yearBand.map((b) => b.label).join(" ") === "2026 2027");
const tight = buildBands({ min: dayIndex("2026-10-30"), max: dayIndex("2026-11-20") }, "Week", 16, (d) => `${d.getUTCMonth() + 1}`);
check("帯: すぐ月が替わるなら左端の見出しは省く", tight.map((b) => b.label).join(" ") === "11");

// 今日は端末の暦で数える（UTC だと時差のぶん前後にずれる）/ today follows the device calendar, not UTC
check("todayIndex はローカルの日付", [0, 30, 23 * 60 + 30].every((min) => dayToStr(todayIndex(new Date(2026, 9, 23, 0, min))) === "2026-10-23"));

// 設定タイムゾーンの今日：固定オフセットなら端末に関係なくその地域の日付 / with a fixed offset, today is that zone's date whatever the device says
const instant = new Date(Date.UTC(2026, 10, 3, 20, 30)); // 2026-11-03 20:30 UTC
check("todayIndex: +09:00 は翌日", dayToStr(todayIndex(instant, "+09:00")) === "2026-11-04");
check("todayIndex: -05:00 は同日", dayToStr(todayIndex(instant, "-05:00")) === "2026-11-03");
check("todayIndex: -09:30 の朝", dayToStr(todayIndex(new Date(Date.UTC(2026, 10, 4, 5, 0)), "-09:30")) === "2026-11-03");
check("todayIndex: system は端末の暦", todayIndex(new Date(2026, 9, 23, 23, 30), "system") === todayIndex(new Date(2026, 9, 23, 23, 30)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
