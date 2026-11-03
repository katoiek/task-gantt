// 稼働日・Duration・依存による連動の検証 / Tests for workdays, durations and dependency cascading
import {
  weekday,
  isWorkday,
  workdaysBetween,
  addWorkdays,
  endForDuration,
  startForDuration,
  taskDuration,
  parseDuration,
  shiftEnd,
  keepDurationOnStartChange,
  successorClosure,
  cascadeDates,
  depViolated,
  wouldLoop,
  offDayGradient,
  autoStatusChanges,
  autoStatusTargets,
} from "./schedule.mjs";
import { dayIndex, dayToStr } from "./timeline.mjs";

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

// 2026-08-14 は金曜、08-17 は月曜 / 2026-08-14 is a Friday, 08-17 a Monday
const d = dayIndex;
const s = dayToStr;
const CAL = { off: [0, 6] };
const NONE = { off: [] };

// ── 曜日・稼働日 / weekdays and workdays ──
check("weekday(月)=1", weekday(d("2026-08-17")) === 1);
check("weekday(1970-01-01)=木", weekday(0) === 4);
check("weekday(負の通日)", weekday(-1) === 3);
check("isWorkday(土)=false", !isWorkday(d("2026-08-15"), CAL));
check("全曜日休みは無効＝毎日稼働", isWorkday(d("2026-08-15"), { off: [0, 1, 2, 3, 4, 5, 6] }));

check("workdaysBetween(月〜金)=5", workdaysBetween(d("2026-08-17"), d("2026-08-21"), CAL) === 5);
check("workdaysBetween(金〜月)=2", workdaysBetween(d("2026-08-14"), d("2026-08-17"), CAL) === 2);
check("workdaysBetween(土〜日)=0", workdaysBetween(d("2026-08-15"), d("2026-08-16"), CAL) === 0);
check("workdaysBetween(逆転)=0", workdaysBetween(d("2026-08-17"), d("2026-08-14"), CAL) === 0);
check("workdaysBetween(3週間)=15", workdaysBetween(d("2026-08-17"), d("2026-09-06"), CAL) === 15);
check("workdaysBetween(休日なし)=暦日", workdaysBetween(d("2026-08-14"), d("2026-08-17"), NONE) === 4);
check("workdaysBetween(年またぎ)", workdaysBetween(d("2026-12-31"), d("2027-01-04"), CAL) === 3);

check("addWorkdays(金+1)=月", s(addWorkdays(d("2026-08-14"), 1, CAL)) === "2026-08-17");
check("addWorkdays(月-1)=金", s(addWorkdays(d("2026-08-17"), -1, CAL)) === "2026-08-14");
check("addWorkdays(0)=そのまま", s(addWorkdays(d("2026-08-17"), 0, CAL)) === "2026-08-17");

// ── 期間から日付 / dates from a duration ──
check("endForDuration(月,4)=木", s(endForDuration(d("2026-08-17"), 4, CAL)) === "2026-08-20");
check("endForDuration(金,4)=水（週末を飛ばす）", s(endForDuration(d("2026-08-14"), 4, CAL)) === "2026-08-19");
check("endForDuration(土,1)=月（休日開始は次の稼働日から）", s(endForDuration(d("2026-08-15"), 1, CAL)) === "2026-08-17");
check("startForDuration(水,4)=金", s(startForDuration(d("2026-08-19"), 4, CAL)) === "2026-08-14");

check("taskDuration(月〜木)=4", taskDuration({ start: "2026-08-17", end: "2026-08-20", milestone: false }, CAL) === 4);
check("taskDuration(マイルストーン)=0", taskDuration({ end: "2026-08-20", milestone: true }, CAL) === 0);
check("taskDuration(日付なし)=undefined", taskDuration({ milestone: false }, CAL) === undefined);

check("parseDuration: 4", parseDuration("4") === 4);
check("parseDuration: 4d", parseDuration("4d") === 4);
check("parseDuration: 3 日", parseDuration(" 3 日") === 3);
check("parseDuration: 0 は null", parseDuration("0") === null);
check("parseDuration: -1 は null", parseDuration("-1") === null);
check("parseDuration: 1.5 は null", parseDuration("1.5") === null);
check("parseDuration: abc は null", parseDuration("abc") === null);

// ── 開始日の変更で期間を保つ（Wrike 流）/ keeping the duration when the start moves (Wrike) ──
check("shiftEnd(月〜木 → 金開始)=水", shiftEnd("2026-08-17", "2026-08-20", "2026-08-21", CAL) === "2026-08-26");
check("shiftEnd(土日だけのタスクは暦日の長さを保つ)", shiftEnd("2026-08-15", "2026-08-16", "2026-08-22", CAL) === "2026-08-23");
{
  const orig = { start: "2026-08-17", end: "2026-08-20", milestone: false };
  check("開始日だけ変更 → 期限日も動く", keepDurationOnStartChange(orig, { start: "2026-08-21", end: "2026-08-20" }, CAL) === "2026-08-26");
  check("期限日も変更 → 入力どおり", keepDurationOnStartChange(orig, { start: "2026-08-18", end: "2026-08-19" }, CAL) === "2026-08-19");
  check("期限日を越えて引きずられた → 期間を保つ", keepDurationOnStartChange(orig, { start: "2026-08-24", end: "2026-08-24" }, CAL) === "2026-08-27");
  check("開始日そのまま → 入力どおり", keepDurationOnStartChange(orig, { start: "2026-08-17", end: "2026-08-25" }, CAL) === "2026-08-25");
  check("開始日を消した → 入力どおり", keepDurationOnStartChange(orig, { start: "", end: "2026-08-20" }, CAL) === "2026-08-20");
  check("マイルストーン → 入力どおり", keepDurationOnStartChange({ end: "2026-08-20", milestone: true }, { start: "2026-08-21", end: "2026-08-20" }, CAL) === "2026-08-20");
  check("元の開始日なし → 入力どおり", keepDurationOnStartChange({ end: "2026-08-20", milestone: false }, { start: "2026-08-10", end: "2026-08-20" }, CAL) === "2026-08-20");
}

// ── successorClosure ──
const mk = (path, o = {}) => ({ path, name: path, groups: [], deps: [], milestone: false, tags: [], custom: {}, ...o });
{
  const g = [
    mk("A"),
    mk("B", { deps: [{ path: "A", type: "SS" }] }),
    mk("C", { deps: [{ path: "B", type: "FF" }] }),
    mk("D", { deps: [{ path: "A", type: "FS" }] }),
    mk("E", { deps: [{ path: "D", type: "SS" }] }),
    mk("F", { deps: [{ path: "C", type: "SS" }, { path: "A", type: "FF" }] }), // 2 経路でも 1 回 / reached twice, listed once
  ];
  g[0].deps.push({ path: "C", type: "SS" }); // 循環 A→B→C→A / a cycle
  const sorted = (xs) => JSON.stringify(xs.sort());
  check("successorClosure(FS 無効): SS/FF だけ", sorted(successorClosure(g, "A")) === sorted(["B", "C", "F"]));
  check("successorClosure(FS 有効): FS の先も", sorted(successorClosure(g, "A", true)) === sorted(["B", "C", "D", "E", "F"]));
  check("successorClosure: 後続なしは空", successorClosure(g, "F", true).length === 0);
}

// ── cascadeDates ──
const OPTS = { cal: CAL, fs: true };
{
  // Issue #4 の例：先行が金曜に終わり、後続は 4 日間 / the issue #4 example: the predecessor ends on a Friday, a 4-day successor
  const pred = mk("P", { start: "2026-08-10", end: "2026-08-14" });
  const succ = mk("S", { start: "2026-08-17", end: "2026-08-20", deps: [{ path: "P", type: "FS" }] });
  const next = mk("N", { start: "2026-08-21", end: "2026-08-21", deps: [{ path: "S", type: "FS" }] });
  const all = [pred, succ, next];
  check("FS: 重なっていなければ動かない", cascadeDates(all, ["P"], OPTS).size === 0);

  pred.end = "2026-08-18"; // 先行が火曜まで遅れる / the predecessor slips to Tuesday
  const ch = cascadeDates(all, ["P"], OPTS);
  check("FS: 後続を翌稼働日へ押し出し、期間 4 日を保つ", ch.get("S")?.start === "2026-08-19" && ch.get("S")?.end === "2026-08-24");
  check("FS: 連鎖して次の後続も押し出す", ch.get("N")?.start === "2026-08-25" && ch.get("N")?.end === "2026-08-25");
  check("cascadeDates は tasks を書き換えない", succ.start === "2026-08-17");
  check("FS 無効なら動かさない", cascadeDates(all, ["P"], { cal: CAL, fs: false }).size === 0);

  pred.end = "2026-08-11"; // 先行が早まっても後続は引き戻さない / an earlier predecessor doesn't pull successors back
  check("FS: 押し出しのみ（引き戻さない）", cascadeDates(all, ["P"], OPTS).size === 0);
}
{
  // 先行がマイルストーン（木曜）→ 後続は金曜開始 / a milestone predecessor on Thursday → the successor starts Friday
  const m = mk("M", { end: "2026-08-20", milestone: true });
  const succ = mk("S", { start: "2026-08-17", end: "2026-08-18", deps: [{ path: "M", type: "FS" }] });
  const ch = cascadeDates([m, succ], ["M"], OPTS);
  check("FS: マイルストーンの先行", ch.get("S")?.start === "2026-08-21" && ch.get("S")?.end === "2026-08-24");
}
{
  const pred = mk("P", { start: "2026-08-19", end: "2026-08-21" });
  const ss = mk("SS", { start: "2026-08-10", end: "2026-08-12", deps: [{ path: "P", type: "SS" }] }); // 3 日 / 3 days
  const ff = mk("FF", { start: "2026-08-10", end: "2026-08-11", deps: [{ path: "P", type: "FF" }] }); // 2 日 / 2 days
  const ms = mk("MS", { end: "2026-08-10", milestone: true, deps: [{ path: "P", type: "FS" }] });
  const ch = cascadeDates([pred, ss, ff, ms], ["P"], OPTS);
  check("SS: 開始を揃え、期間を稼働日で保つ", ch.get("SS")?.start === "2026-08-19" && ch.get("SS")?.end === "2026-08-21");
  check("FF: 期限を揃え、期間を稼働日で保つ", ch.get("FF")?.start === "2026-08-20" && ch.get("FF")?.end === "2026-08-21");
  check("マイルストーンは依存で動かさない", !ch.has("MS"));
}
{
  // 依存が輪になっていると日付が決まらないので、何も動かさない（以前は 1000 回押し出して数十年先へ）
  // dependencies in a loop have no answer, so nothing moves (this used to push them 1000 times, decades ahead)
  const a = mk("A", { start: "2026-08-17", end: "2026-08-18", deps: [{ path: "B", type: "FS" }] });
  const b = mk("B", { start: "2026-08-17", end: "2026-08-18", deps: [{ path: "A", type: "FS" }] });
  check("循環なら null（何も動かさない）", cascadeDates([a, b], ["A"], OPTS) === null);
  const c = mk("C", { start: "2026-08-10", end: "2026-08-11" });
  check("wouldLoop: 後続から先行へたどれるなら輪", wouldLoop([a, b, c], "B", "A") && wouldLoop([a, b, c], "A", "A"));
  check("wouldLoop: 無関係なら輪にならない", !wouldLoop([a, b, c], "C", "A"));
}
{
  // 違反の判定は連動と同じ決まり：FS は先行の期限の翌稼働日から / violations follow the cascade's rule: FS from the workday after the due date
  const p = mk("P", { start: "2026-08-10", end: "2026-08-14" }); // 金曜に終わる / ends on a Friday
  const sat = mk("S", { start: "2026-08-15", end: "2026-08-17" });
  const mon = mk("M", { start: "2026-08-17", end: "2026-08-18" });
  check("depViolated FS: 土曜開始は違反（連動なら月曜へ押す）", depViolated(sat, p, "FS", CAL) && !depViolated(mon, p, "FS", CAL));
  check("depViolated SS/FF", depViolated(mk("X", { start: "2026-08-09", end: "2026-08-20" }), p, "SS", CAL) && depViolated(mk("Y", { start: "2026-08-10", end: "2026-08-13" }), p, "FF", CAL));
}

// 休日の帯：左端が水曜（2026-10-21）なら土日は 4・5 日目 / non-working days: from a Wednesday, Sat and Sun are the 4th and 5th days
const g = offDayGradient(dayIndex("2026-10-21"), { off: [0, 6] }, 10, "red");
check("休日の帯: 土(30-40px)と日(40-50px)が 70px 周期（0px 始まり）", g === "repeating-linear-gradient(to right, transparent 0px, transparent 30px, red 30px, red 40px, transparent 40px, transparent 40px, red 40px, red 50px, transparent 50px, transparent 70px)");
check("休日の帯: 休日なしは none", offDayGradient(0, { off: [] }, 10, "red") === "none");

// ── 日付による自動ステータス / automatic status by date ──
{
  const ST = [
    { id: "todo", label: "To do", color: "", group: "active" },
    { id: "in-progress", label: "In progress", color: "", group: "active" },
    { id: "review", label: "Review", color: "", group: "active" },
    { id: "blocked", label: "Blocked", color: "", group: "deferred" },
    { id: "done", label: "Done", color: "", group: "completed" },
    { id: "dropped", label: "Dropped", color: "", group: "cancelled" },
  ];
  const DEF = { started: "", finished: "", notStarted: [] };
  const today = dayIndex("2026-11-03");
  const T = (path, status, start, end) => ({ path, status, start, end, deps: [] });
  const run = (tasks, cfg = DEF, st = ST) => Object.fromEntries(autoStatusChanges(tasks, st, cfg, today));
  const t = autoStatusTargets(ST, DEF);
  check("自動: 既定は in-progress / done / 最初の active", t.started === "in-progress" && t.finished === "done" && t.notStarted.join() === "todo");
  check("自動: 開始日になった未着手は開始後へ（当日を含む）", JSON.stringify(run([T("a", "todo", "2026-11-03", "2026-11-10"), T("b", "todo", "2026-11-04", "2026-11-10")])) === '{"a":"in-progress"}');
  check("自動: 期限日を過ぎた未完了は完了後へ（当日は含まない）", JSON.stringify(run([T("a", "in-progress", "2026-10-01", "2026-11-02"), T("b", "todo", undefined, "2026-11-01"), T("c", "review", "2026-10-01", "2026-11-03")])) === '{"a":"done","b":"done"}');
  check("自動: 延期・完了・中止・未設定・不明には触れない", JSON.stringify(run([T("a", "blocked", "2026-10-01", "2026-10-02"), T("b", "done", "2026-10-01", "2026-10-02"), T("c", "dropped", "2026-10-01", "2026-10-02"), T("d", undefined, "2026-10-01", "2026-10-02"), T("e", "ghost", "2026-10-01", "2026-10-02")])) === "{}");
  check("自動: 日付が無ければ触れない", JSON.stringify(run([T("a", "todo", undefined, undefined), T("b", "in-progress", "2026-10-01", undefined)])) === "{}");
  check("自動: 後戻りしない（開始後や未着手以外の active は開始後へ戻さない）", JSON.stringify(run([T("a", "review", "2026-11-01", "2026-11-20"), T("b", "in-progress", "2026-11-01", "2026-11-20")])) === "{}");
  check("自動: 未着手の一覧と行き先を選べる", JSON.stringify(run([T("a", "review", "2026-11-01", "2026-11-20"), T("b", "todo", "2026-11-01", "2026-11-20")], { started: "in-progress", finished: "done", notStarted: ["review"] })) === '{"a":"in-progress"}');
  check("自動: 行き先がグループ違い・存在しないなら動かさない", JSON.stringify(run([T("a", "todo", "2026-10-01", "2026-10-02"), T("b", "todo", "2026-11-01", "2026-11-20")], { started: "blocked", finished: "todo", notStarted: [] })) === "{}");
  check("自動: 組み込みが無ければ既定の行き先も無い", JSON.stringify(run([T("a", "open", "2026-10-01", "2026-10-02")], DEF, [{ id: "open", label: "Open", color: "", group: "active" }, { id: "closed", label: "Closed", color: "", group: "completed" }])) === "{}");
  check("自動: 開始後は未着手に数えない", autoStatusTargets(ST, { started: "in-progress", finished: "", notStarted: ["in-progress", "todo"] }).notStarted.join() === "todo");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
