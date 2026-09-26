// buildRows / マイルストーン判定 / span 集約 の検証
// Tests for buildRows, milestone detection, and group span rollup
import { buildRows, anchorStart, anchorEnd, subtreePaths, parseStored, combineDateTime, toInstant, inferStatusGroup, statusGroupOf, successorClosure, customFieldIssues, validCustomFields, readCustomValue, customValueText, parseCustomInput } from "./model.mjs";

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

// ── ステータスグループ / status groups ──
// 移行時の推測：id かラベルのどちらかが当たれば分類される / the migration guess matches id or label
check("推測: done → completed", inferStatusGroup("done", "Done") === "completed");
check("推測: 完了 → completed", inferStatusGroup("kanryo", "完了") === "completed");
check("推測: cancelled → cancelled", inferStatusGroup("cancelled", "Cancelled") === "cancelled");
check("推測: 中止 → cancelled", inferStatusGroup("chushi", "中止") === "cancelled");
check("推測: on hold → deferred", inferStatusGroup("on-hold", "On hold") === "deferred");
check("推測: blocked → deferred", inferStatusGroup("blocked", "Blocked") === "deferred");
check("推測: 保留 → deferred", inferStatusGroup("horyu", "保留") === "deferred");
check("推測: in progress → active", inferStatusGroup("in-progress", "In progress") === "active");
check("推測: 未知の語は active", inferStatusGroup("review", "レビュー中") === "active");
// completed を先に見るので "完了待ち" のような複合語は completed 側 / completed wins on the first hit
check("推測: 大文字小文字を無視", inferStatusGroup("DONE", "DONE") === "completed");

const statusDefs = [
  { id: "todo", label: "To do", color: "#000", group: "active" },
  { id: "done", label: "Done", color: "#000", group: "completed" },
];
check("statusGroupOf: 定義済み id", statusGroupOf(statusDefs, "done") === "completed");
check("statusGroupOf: ステータス未設定は undefined", statusGroupOf(statusDefs, undefined) === undefined);
check("statusGroupOf: 空文字は undefined", statusGroupOf(statusDefs, "") === undefined);
// 設定に無い id は「分類不能」。完了に寄せると完了フィルタが嘘をつく / unknown ids stay unclassified
check("statusGroupOf: 未定義 id は undefined", statusGroupOf(statusDefs, "ghost") === undefined);

// successorClosure：SS/FF を推移的にたどり、FS・自分・循環は除く / follows SS/FF transitively; skips FS, self and cycles
{
  const mk = (path, deps = []) => ({ path, name: path, groups: [], deps, milestone: false, tags: [] });
  const g = [
    mk("A"),
    mk("B", [{ path: "A", type: "SS" }]),
    mk("C", [{ path: "B", type: "FF" }]),
    mk("D", [{ path: "A", type: "FS" }]), // FS は連動しない / FS doesn't cascade
    mk("E", [{ path: "D", type: "SS" }]), // FS の先なので到達しない / behind an FS edge, unreachable
    mk("F", [{ path: "C", type: "SS" }, { path: "A", type: "FF" }]), // 2 経路でも 1 回 / reached twice, listed once
  ];
  g[0].deps.push({ path: "C", type: "SS" }); // 循環 A→B→C→A / a cycle
  check("successorClosure: SS/FF を推移的に", JSON.stringify(successorClosure(g, "A").sort()) === JSON.stringify(["B", "C", "F"]));
  check("successorClosure: 後続なしは空", successorClosure(g, "F").length === 0);
}

// ── Custom field ──
{
  const keys = { start: "start", end: "due", status: "status", assignee: "owner", after: "after", progress: "progress", milestone: "milestone", parent: "parent", gcalId: "gcalId", gcal: "gcal" };
  const cf = (id, key, type = "text") => ({ id, key, label: "", type });
  const settings = { keys, customFields: [cf("a", "client"), cf("b", " "), cf("c", "due"), cf("d", "tags"), cf("e", "client"), cf("f", "budget", "number")] };
  const issues = customFieldIssues(settings);
  check("cf: 空キーは empty", issues.get("b") === "empty");
  check("cf: 設定済みの組み込みキー（期限＝due）は reserved", issues.get("c") === "reserved");
  check("cf: tags は reserved", issues.get("d") === "reserved");
  check("cf: 2 つ目の同じキーは duplicate", issues.get("e") === "duplicate" && !issues.has("a"));
  check("cf: 有効なものだけ定義順に", validCustomFields(settings).map((f) => f.id).join(",") === "a,f");

  check("cf read: text", readCustomValue("ACME", "text", "system") === "ACME");
  check("cf read: text の数値は文字列に", readCustomValue(42, "text", "system") === "42");
  check("cf read: text のリストは配列のまま", JSON.stringify(readCustomValue(["a", "", "b"], "text", "system")) === JSON.stringify(["a", "b"]));
  check("cf read: 空・null は undefined", readCustomValue("", "text", "system") === undefined && readCustomValue(null, "number", "system") === undefined);
  check("cf read: number", readCustomValue("12.5", "number", "system") === 12.5 && readCustomValue(3, "number", "system") === 3);
  check("cf read: 数値にならないものは undefined", readCustomValue("abc", "number", "system") === undefined);
  check("cf read: date は日付部分のみ", readCustomValue("2024-05-06T10:30", "date", "system") === "2024-05-06");
  check("cf read: 日付にならないものは undefined", readCustomValue("someday", "date", "system") === undefined);

  check("cf text: リストはカンマ区切り", customValueText(["a", "b"]) === "a, b" && customValueText(undefined) === "");
  check("cf input: 空は削除", parseCustomInput("  ", "text", false) === undefined);
  check("cf input: number", parseCustomInput(" 7 ", "number", false) === 7);
  check("cf input: 数値にならない number は書かない(null)", parseCustomInput("x", "number", false) === null);
  check("cf input: 元がリストの text はリストに戻す", JSON.stringify(parseCustomInput("a, b ,", "text", true)) === JSON.stringify(["a", "b"]));
  check("cf input: 元が単一値の text はそのまま", parseCustomInput("a, b", "text", false) === "a, b");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
