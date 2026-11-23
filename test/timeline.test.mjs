// 日付フィルタの解決・判定（resolveDateValue / matchDate）と稲妻線ジオメトリの検証
// Tests for date-filter resolution/matching and progress-line geometry
import { resolveDateValue, matchDate, dayIndex, progressLineX, buildProgressLine, buildTicks, roundedPolyline, headerLevel, isoWeek, buildHeader, offRuns, offscreenSide, jumpScrollLeft, dayAtX, orderedSpan } from "./timeline.mjs";

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

// ── 依存の線の角丸（roundedPolyline）──
{
  const p4 = roundedPolyline([[0, 0], [20, 0], [20, 30], [50, 30]], 6);
  check("roundedPolyline: 角ごとに、手前 r から、頂点を制御点にした曲線", p4 === "M 0 0 L 14 0 Q 20 0 20 6 L 20 24 Q 20 30 26 30 L 50 30");
  check("roundedPolyline: 短い辺では、r を辺の半分に縮める", roundedPolyline([[0, 0], [4, 0], [4, 40]], 6) === "M 0 0 L 2 0 Q 4 0 4 2 L 4 40");
  check("roundedPolyline: 重なった点は捨てる（行が同じで縦の辺が 0 のとき）", roundedPolyline([[0, 10], [20, 10], [20, 10], [50, 10]], 6) === "M 0 10 L 20 10 L 50 10");
  check("roundedPolyline: まっすぐ続く点は、曲げない", roundedPolyline([[0, 0], [10, 0], [30, 0]], 6) === "M 0 0 L 10 0 L 30 0");
  check("roundedPolyline: 点が 2 つなら、直線", roundedPolyline([[0, 0], [5, 5]], 6) === "M 0 0 L 5 5");
  check("roundedPolyline: 点が無ければ空", roundedPolyline([], 6) === "");
  check("roundedPolyline: 戻る向きの折れ線（左へ折れる）も、曲線になる", roundedPolyline([[100, 0], [112, 0], [112, 30], [90, 30]], 6) === "M 100 0 L 106 0 Q 112 0 112 6 L 112 24 Q 112 30 106 30 L 90 30");
}

// ── ClickUp 風の日付軸（buildHeader など）──
{
  const d = (iso) => dayIndex(iso);
  const text = {
    weekdays: ["日", "月", "火", "水", "木", "金", "土"],
    monthName: (m) => `${m}月`,
    yearMonth: (y, m) => `${y}年${m}月`,
  };
  const off = (day) => { const w = new Date(day * 86400000).getUTCDay(); return !(w === 0 || w === 6); }; // 土日が休み / Saturday and Sunday off
  const range = { min: d("2026-11-11"), max: d("2026-11-25") }; // 水 〜 水 / Wed to Wed

  check("isoWeek: 2026-11-15（日）は W46、11-16（月）は W47", isoWeek(d("2026-11-15")) === 46 && isoWeek(d("2026-11-16")) === 47);
  check("isoWeek: 年のはじめと終わり（2026-01-01 は W1、2026-12-31 は W53）", isoWeek(d("2026-01-01")) === 1 && isoWeek(d("2026-12-31")) === 53);

  check("headerLevel: Day=1・Week=2・Month=4", headerLevel("Day", 36) === 1 && headerLevel("Week", 20) === 2 && headerLevel("Month", 4) === 4);
  check("headerLevel: Fit は 1 日の幅で決まる", headerLevel("Fit", 40) === 1 && headerLevel("Fit", 20) === 2 && headerLevel("Fit", 8) === 3 && headerLevel("Fit", 3) === 4);

  const h1 = buildHeader(range, 1, 36, text, off, d("2026-11-15"));
  check("level 1: 上段は週（日曜始まり）。W46 は 11/15-21、範囲の端で切れる", h1.top.length === 3 && h1.top[0].label === "W45" && h1.top[1].label === "W46" && h1.top[1].sub === "11月 15 - 21" && h1.top[2].label === "W47");
  check("level 1: 最初の週は、範囲の左端から始まり、幅は範囲の中の日数ぶん", h1.top[0].x === 0 && h1.top[0].w === 4 * 36 && h1.top[1].x === 4 * 36 && h1.top[1].w === 7 * 36);
  check("level 1: 下段は日。曜日つきの文字、休日と今日に印", h1.bottom.length === 15 && h1.bottom[0].label === "水 11" && h1.bottom[3].label === "土 14" && h1.bottom[3].weekend === true && h1.bottom[4].label === "日 15" && h1.bottom[4].today === true && h1.bottom[1].weekend === false);
  const h2 = buildHeader(range, 2, 20, text, off, d("2026-11-15"));
  check("level 2: 下段は日の数字だけ", h2.bottom[0].label === "11" && h2.bottom[4].label === "15");
  const x = buildHeader({ min: d("2026-11-25"), max: d("2026-12-08") }, 2, 20, text, off, 0);
  check("週が月をまたぐとき、両方の月を出す（11月 22 - 28 / 11月 29 - 12月 5）", x.top[0].sub === "11月 22 - 28" && x.top[1].sub === "11月 29 - 12月 5");

  const h3 = buildHeader({ min: d("2026-10-25"), max: d("2026-12-05") }, 3, 6, text, off, d("2026-11-15"));
  check("level 3: 上段は月（年つき）、下段は週の開始日", h3.top.map((c) => c.label).join() === "2026年10月,2026年11月,2026年12月" && h3.bottom[0].label === "25" && h3.bottom[1].label === "1");
  check("level 3: 月のセルは、月の日数ぶんの幅（11月は 30 日）", h3.top[1].w === 30 * 6);
  check("level 3: 今日を含む週のセルに印", h3.bottom.filter((c) => c.today).length === 1 && h3.bottom.find((c) => c.today).label === "15");

  const h4 = buildHeader({ min: d("2026-10-20"), max: d("2027-02-10") }, 4, 4, text, off, d("2026-11-15"));
  check("level 4: 上段は年、下段は月（Wrike 風）", h4.top.map((c) => c.label).join() === "2026,2027" && h4.bottom.map((c) => c.label).join() === "10月,11月,12月,1月,2月");
  check("level 4: 年のセルの幅は、範囲の中の日数ぶん（2026 は 10/20〜12/31 の 73 日）", h4.top[0].w === 73 * 4 && h4.bottom[1].today === true);

  const runs = offRuns(range, off);
  check("offRuns: 休日が続く区間（土日）", runs.length === 2 && runs[0][0] === d("2026-11-14") && runs[0][1] === d("2026-11-15") && runs[1][0] === d("2026-11-21") && runs[1][1] === d("2026-11-22"));
  check("offRuns: 範囲が休日で終わっても閉じる", offRuns({ min: d("2026-11-13"), max: d("2026-11-15") }, off).length === 1);
}

// ── 画面の外のバーへの目印 ──
{
  check("offscreenSide: 見えている範囲の左の外は left", offscreenSide(0, 100, 100, 600) === "left" && offscreenSide(0, 50, 100, 600) === "left");
  check("offscreenSide: 右の外は right", offscreenSide(600, 700, 100, 600) === "right" && offscreenSide(900, 950, 100, 600) === "right");
  check("offscreenSide: 少しでも見えていれば null（端が 1px でも）", offscreenSide(0, 101, 100, 600) === null && offscreenSide(599, 800, 100, 600) === null && offscreenSide(200, 300, 100, 600) === null);
  check("offscreenSide: 範囲をまたぐ長いバーは null", offscreenSide(0, 1000, 100, 600) === null);
  check("jumpScrollLeft: バーの左端を、左から margin のところへ", jumpScrollLeft(1000, 60) === 940 && jumpScrollLeft(1000.4, 60) === 940);
  check("jumpScrollLeft: 0 未満にはしない", jumpScrollLeft(20, 60) === 0);
}

// ── ドラッグで日程を決める：x → 日、2 点 → 開始と終了 / scheduling by dragging: x to day, two ends to start and due ──
{
  const range = { min: 100, max: 200 };
  check("dayAtX: 左端は、範囲の最初の日", dayAtX(0, range, 16) === 100);
  check("dayAtX: 1 日の幅ごとに 1 日進む", dayAtX(15, range, 16) === 100 && dayAtX(16, range, 16) === 101 && dayAtX(16 * 5 + 3, range, 16) === 105);
  check("dayAtX: 範囲の外は、端の日", dayAtX(-50, range, 16) === 100 && dayAtX(16 * 500, range, 16) === 200);
  check("dayAtX: 幅 0 や不正な値でも、壊れない", dayAtX(40, range, 0) === 100 && dayAtX(NaN, range, 16) === 100);
  check("dayAtX: 小数の幅（Fit のズーム）", dayAtX(10, range, 4.5) === 102);
  check("orderedSpan: 右へのドラッグ", JSON.stringify(orderedSpan(3, 7)) === "[3,7]");
  check("orderedSpan: 左へのドラッグでも、開始が前", JSON.stringify(orderedSpan(7, 3)) === "[3,7]");
  check("orderedSpan: 同じ日は 1 日", JSON.stringify(orderedSpan(5, 5)) === "[5,5]");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
