// buildRows / マイルストーン判定 / span 集約 の検証
// Tests for buildRows, milestone detection, and group span rollup
import { buildRows, anchorStart, anchorEnd, subtreePaths, parseStored, combineDateTime, toInstant } from "./model.mjs";

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

// マイルストーンは end のみ → anchor は end / milestone collapses to its due date
const ms = { milestone: true, end: "2026-02-10" };
check("anchorStart(milestone)=end", anchorStart(ms) === "2026-02-10");
check("anchorEnd(milestone)=end", anchorEnd(ms) === "2026-02-10");

// 時刻のパース・タイムゾーン換算・結合 / time parsing, timezone conversion, combining
const eq = (p, date, time) => p != null && p.date === date && p.time === time;
check("parseStored(日付のみ)", eq(parseStored("2026-06-12", "+09:00"), "2026-06-12", undefined));
check("parseStored(naive はそのまま)", eq(parseStored("2026-06-12T09:30", "+00:00"), "2026-06-12", "09:30"));
check("parseStored(1桁時)=07:00", eq(parseStored("2026-06-12T7:00", "+09:00"), "2026-06-12", "07:00"));
check("parseStored(不正な時刻)=日付のみ", eq(parseStored("2026-06-12T25:00", "+09:00"), "2026-06-12", undefined));
check("parseStored(不正値)=undefined", parseStored("未定", "+09:00") === undefined);
check("parseStored(null)=undefined", parseStored(null, "+09:00") === undefined);
check("parseStored(同一TZ)", eq(parseStored("2026-06-12T09:00+09:00", "+09:00"), "2026-06-12", "09:00"));
check("parseStored(+09:00→GMT)", eq(parseStored("2026-06-12T09:00+09:00", "+00:00"), "2026-06-12", "00:00"));
check("parseStored(Z→+09:00)", eq(parseStored("2026-06-12T09:00Z", "+09:00"), "2026-06-12", "18:00"));
check("parseStored(日付またぎ)", eq(parseStored("2026-06-12T01:00+09:00", "-05:00"), "2026-06-11", "11:00"));
check("parseStored(30分TZ)", eq(parseStored("2026-06-12T09:00+09:00", "+05:30"), "2026-06-12", "05:30"));
check("combineDateTime(オフセット付与)", combineDateTime("2026-06-12", "09:30", "+09:00") === "2026-06-12T09:30+09:00");
check("combineDateTime(負オフセット)", combineDateTime("2026-06-12", "09:30", "-05:00") === "2026-06-12T09:30-05:00");
check("combineDateTime(日付のみ)", combineDateTime("2026-06-12", "", "+09:00") === "2026-06-12");
check("combineDateTime(日付なし)=undefined", combineDateTime(undefined, "09:30", "+09:00") === undefined);
// 往復: 書いた値を読み戻すと同じ表示になる / round-trip: write then read back yields the same display
check("往復(書き→読み)", eq(parseStored(combineDateTime("2026-06-12", "09:30", "+09:00"), "+09:00"), "2026-06-12", "09:30"));

// 絶対時刻への変換（通知トリガー用）/ wall clock → absolute instant (for notification triggers)
check("toInstant(+09:00)", toInstant("2026-06-12", "09:00", "+09:00") === Date.UTC(2026, 5, 12, 0, 0));
check("toInstant(GMT)", toInstant("2026-06-12", "09:00", "+00:00") === Date.UTC(2026, 5, 12, 9, 0));
check("toInstant(-05:00)", toInstant("2026-06-12", "09:00", "-05:00") === Date.UTC(2026, 5, 12, 14, 0));

// 多階層: お掃除 > 床掃除 / お風呂掃除 / multi-level nesting
const tasks = [
  { path: "p/お掃除/床掃除/掃き掃除.md", name: "掃き掃除", groups: ["お掃除", "床掃除"], start: "2026-02-01", end: "2026-02-03", after: [], milestone: false },
  { path: "p/お掃除/床掃除/拭き掃除.md", name: "拭き掃除", groups: ["お掃除", "床掃除"], start: "2026-02-04", end: "2026-02-07", after: [], milestone: false },
  { path: "p/お掃除/お風呂掃除/排水溝清掃.md", name: "排水溝清掃", groups: ["お掃除", "お風呂掃除"], start: "2026-02-08", end: "2026-02-10", after: [], milestone: false },
  { path: "p/お掃除/お風呂掃除/完了報告.md", name: "完了報告", groups: ["お掃除", "お風呂掃除"], end: "2026-02-10", after: [], milestone: true },
];

const rows = buildRows(tasks);
const groupRows = rows.filter((r) => r.kind === "group");
const taskRows = rows.filter((r) => r.kind === "task");
check("グループ行が 3 つ（お掃除/床掃除/お風呂掃除）", groupRows.length === 3);
check("タスク行が 4 つ", taskRows.length === 4);

const top = rows[0];
check("先頭は お掃除（depth 0）", top.kind === "group" && top.group === "お掃除" && top.depth === 0);
check("お掃除 span = 2/1..2/10", top.span?.start === "2026-02-01" && top.span?.end === "2026-02-10");

const floor = groupRows.find((r) => r.group === "床掃除");
check("床掃除 は depth 1", floor.depth === 1);
check("床掃除 span = 2/1..2/7", floor.span?.start === "2026-02-01" && floor.span?.end === "2026-02-07");

const bath = groupRows.find((r) => r.group === "お風呂掃除");
check("お風呂掃除 span = 2/8..2/10", bath.span?.start === "2026-02-08" && bath.span?.end === "2026-02-10");

// 床掃除フォルダ直後にその配下タスクが depth 2 で並ぶ / its tasks at depth 2
const floorIdx = rows.indexOf(floor);
check("床掃除の次行はタスク(depth 2)", rows[floorIdx + 1].kind === "task" && rows[floorIdx + 1].depth === 2);

// 折りたたみ: お掃除 を畳むと子が消える / collapse hides children
const collapsedRows = buildRows(tasks, new Set(["お掃除"]));
check("お掃除を畳むと行は1つ（お掃除のみ）", collapsedRows.length === 1 && collapsedRows[0].group === "お掃除");

// 床掃除だけ畳む / collapse only 床掃除
const c2 = buildRows(tasks, new Set(["お掃除/床掃除"]));
check("床掃除を畳むと掃き掃除/拭き掃除が消える", !c2.some((r) => r.task?.name === "掃き掃除"));
check("床掃除を畳んでもお風呂掃除のタスクは残る", c2.some((r) => r.task?.name === "排水溝清掃"));

// ----- サブタスク（parent ネスト）/ subtask nesting -----
const sub = [
  { path: "p/F/Parent.md", name: "Parent", groups: ["F"], start: "2026-03-01", end: "2026-03-02", after: [], milestone: false },
  { path: "p/F/Child.md", name: "Child", groups: ["F"], start: "2026-03-05", end: "2026-03-08", after: [], milestone: false, parent: "p/F/Parent.md" },
];
// nest=true で親子ツリー / nest by parent
const nestRows = buildRows(sub, new Set(), [], undefined, true);
const pRow = nestRows.find((r) => r.task?.name === "Parent");
const cRow = nestRows.find((r) => r.task?.name === "Child");
check("親行は hasChildren", pRow.hasChildren === true);
check("子は親より1段深い", cRow.depth === pRow.depth + 1);
check("親のロールアップ span = 3/1..3/8", pRow.span?.start === "2026-03-01" && pRow.span?.end === "2026-03-08");

// 親を畳むと子が消える（キー＝親パス）/ collapsing the parent hides the child
const nestCollapsed = buildRows(sub, new Set(["p/F/Parent.md"]), [], undefined, true);
check("親を畳むと子が消える", !nestCollapsed.some((r) => r.task?.name === "Child"));

// nest=false（既定）では親子は同じ深さのフラット / without nesting, siblings stay flat
const flatRows = buildRows(sub);
check("nest無効なら親子は同じ depth", flatRows.find((r) => r.task?.name === "Parent").depth === flatRows.find((r) => r.task?.name === "Child").depth);

// subtreePaths は自分＋子孫 / subtree includes self + descendants
check("subtreePaths は親＋子", JSON.stringify(subtreePaths(sub, "p/F/Parent.md").sort()) === JSON.stringify(["p/F/Child.md", "p/F/Parent.md"]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
