// buildRows / マイルストーン判定 / span 集約 の検証
// Tests for buildRows, milestone detection, and group span rollup
import { buildRows, anchorStart, anchorEnd } from "./model.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
