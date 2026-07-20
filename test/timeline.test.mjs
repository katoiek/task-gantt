// 日付フィルタの解決・判定（resolveDateValue / matchDate）の検証
// Tests for date-filter resolution and matching
import { resolveDateValue, matchDate, dayIndex } from "./timeline.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
