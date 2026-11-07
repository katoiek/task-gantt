// カンバンの振り分け（列の並び・未割当・サブタスク）の検証 / Tests for the Kanban sorting (column order, unassigned, subtasks)
import { orderStatusIds, buildKanbanColumns, subtasksOf } from "./kanban.mjs";

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

const ST = [
  { id: "todo", label: "To do", color: "#999", group: "active" },
  { id: "doing", label: "Doing", color: "#39f", group: "active" },
  { id: "done", label: "Done", color: "#3c6", group: "completed" },
];
const T = (path, status, parent) => ({ path, name: path, status, parent, groups: [], deps: [], milestone: false, tags: [], custom: {} });
const ids = (cols) => cols.map((c) => c.status);
const paths = (col) => col.cards.map((t) => t.path).join();

// ── orderStatusIds ──
check("orderStatusIds: 保存が無ければ設定の順", orderStatusIds(ST, []).join() === "todo,doing,done");
check("orderStatusIds: 保存した並びを使う", orderStatusIds(ST, ["done", "todo", "doing"]).join() === "done,todo,doing");
check("orderStatusIds: 知らない ID は捨てる", orderStatusIds(ST, ["ghost", "done"]).join() === "done,todo,doing");
check("orderStatusIds: 足りないステータスは設定の順で後ろに", orderStatusIds(ST, ["doing"]).join() === "doing,todo,done");
check("orderStatusIds: 重複は 1 回", orderStatusIds(ST, ["done", "done", "todo"]).join() === "done,todo,doing");
check("orderStatusIds: ステータスを足すと自動で末尾の列が増える", orderStatusIds([...ST, { id: "hold", label: "Hold", color: "#c90", group: "deferred" }], ["done", "todo", "doing"]).join() === "done,todo,doing,hold");

// ── buildKanbanColumns ──
{
  const cols = buildKanbanColumns([T("a", "todo"), T("b", "done"), T("c", "todo"), T("d", undefined), T("e", "ghost")], ST, []);
  check("列: 先頭が未割当、続いてステータスの順", ids(cols).map((x) => x ?? "-").join() === "-,todo,doing,done");
  check("列: ステータスごとに分け、渡された順を保つ", paths(cols[1]) === "a,c" && paths(cols[3]) === "b" && paths(cols[2]) === "");
  check("列: ステータスなし・設定にない ID は未割当", paths(cols[0]) === "d,e");
}
{
  const cols = buildKanbanColumns([T("a", "todo")], ST, ["done", "doing", "todo"]);
  check("列: 保存した並びが列の並びになる", cols.map((c) => c.status ?? "-").join() === "-,done,doing,todo");
}
{
  const cols = buildKanbanColumns([T("p", "todo"), T("s1", "doing", "p"), T("s2", "done", "p")], ST, []);
  check("サブタスク: 親が表示中なら、独立したカードにしない", paths(cols[1]) === "p" && paths(cols[2]) === "" && paths(cols[3]) === "");
}
{
  const cols = buildKanbanColumns([T("s1", "doing", "p")], ST, []);
  check("サブタスク: 親がフィルタで外れていれば、独立したカード", paths(cols[2]) === "s1");
}
check("列: タスクが無くても全部の列が出る", buildKanbanColumns([], ST, []).length === 4);

// ── subtasksOf ──
{
  const all = [T("p", "todo"), T("s1", "doing", "p"), T("s2", "done", "p"), T("q", "todo"), T("s3", "todo", "q")];
  check("subtasksOf: 直下のサブタスクを、渡された順に", subtasksOf(all, "p").map((t) => t.path).join() === "s1,s2");
  check("subtasksOf: 子が無ければ空", subtasksOf(all, "s1").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
