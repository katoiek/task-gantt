// 日付フィルタの解決・判定（resolveDateValue / matchDate）と稲妻線ジオメトリの検証
// Tests for date-filter resolution/matching and progress-line geometry
import { resolveDateValue, matchDate, dayIndex, progressLineX, buildProgressLine } from "./timeline.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
