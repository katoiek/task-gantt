// カンバンの振り分け（列の並び・未割当・サブタスク）の検証 / Tests for the Kanban sorting (column order, unassigned, subtasks)
import { orderStatusIds, buildKanbanColumns, moveId, subtasksOf, columnKey, toggleCollapsed, collapseColumns, UNASSIGNED_KEY } from "./kanban.mjs";

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
{
  // 設定の順序を取り込んだあとは、設定の順序が変わっても、ビューの並びは変わらない
  const saved = orderStatusIds(ST, []); // 取り込み（初期値）/ the snapshot (the starting order)
  const settingsReordered = [ST[2], ST[1], ST[0]];
  check("orderStatusIds: 取り込んだ後は、設定の順序を変えても、ビューの並びは変わらない", orderStatusIds(settingsReordered, saved).join() === "todo,doing,done");
}
check("orderStatusIds: 保存が無ければ設定の順（初期値）", orderStatusIds(ST, []).join() === "todo,doing,done");
check("orderStatusIds: 保存した並びを使う", orderStatusIds(ST, ["done", "todo", "doing"]).join() === "done,todo,doing");
check("orderStatusIds: 知らない ID は捨てる", orderStatusIds(ST, ["ghost", "done"]).join() === "done,todo,doing");
check("orderStatusIds: 足りないステータスは設定の順で後ろに", orderStatusIds(ST, ["doing"]).join() === "doing,todo,done");
check("orderStatusIds: 重複は 1 回", orderStatusIds(ST, ["done", "done", "todo"]).join() === "done,todo,doing");
check("orderStatusIds: 設定でステータスを足すと、保存した並びの末尾に列が増える", orderStatusIds([...ST, { id: "hold", label: "Hold", color: "#c90", group: "deferred" }], ["done", "todo", "doing"]).join() === "done,todo,doing,hold");
check("orderStatusIds: 設定でステータスを消すと、その列も消える", orderStatusIds(ST.slice(0, 2), ["done", "doing", "todo"]).join() === "doing,todo");

// ── buildKanbanColumns ──
{
  const cols = buildKanbanColumns([T("a", "todo"), T("b", "done"), T("c", "todo"), T("d", undefined), T("e", "ghost")], ST, []);
  check("列: 先頭が未割当、続いてステータスの順", ids(cols).map((x) => x ?? "-").join() === "-,todo,doing,done");
  check("列: ステータスごとに分け、渡された順を保つ", paths(cols[1]) === "a,c" && paths(cols[3]) === "b" && paths(cols[2]) === "");
  check("列: ステータスなし・設定にない ID は未割当", paths(cols[0]) === "d,e");
}
{
  const cols = buildKanbanColumns([T("a", "todo")], ST, ["done", "doing", "todo"]);
  check("列: ビューに保存した並びが列の並びになる（先頭は未割当）", cols.map((c) => c.status ?? "-").join() === "-,done,doing,todo");
  check("列: 保存が無ければ設定の順", buildKanbanColumns([T("a", "todo")], ST, []).map((c) => c.status ?? "-").join() === "-,todo,doing,done");
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

// ── moveId ──
{
  const ids = ["todo", "doing", "done"];
  check("moveId: 前へ動かす", moveId(ids, "done", "todo", false).join() === "done,todo,doing");
  check("moveId: 後ろへ動かす", moveId(ids, "todo", "doing", true).join() === "doing,todo,done");
  check("moveId: 末尾へ", moveId(ids, "todo", "done", true).join() === "doing,done,todo");
  check("moveId: 同じ位置になる動きは null", moveId(ids, "todo", "doing", false) === null && moveId(ids, "doing", "todo", true) === null);
  check("moveId: 自分自身・知らない ID は null", moveId(ids, "todo", "todo", true) === null && moveId(ids, "ghost", "todo", false) === null && moveId(ids, "todo", "ghost", false) === null);
  moveId(ids, "done", "todo", false);
  check("moveId: 元の配列は変えない", ids.join() === "todo,doing,done");
}

// ── subtasksOf ──
{
  const all = [T("p", "todo"), T("s1", "doing", "p"), T("s2", "done", "p"), T("q", "todo"), T("s3", "todo", "q")];
  check("subtasksOf: 直下のサブタスクを、渡された順に", subtasksOf(all, "p").map((t) => t.path).join() === "s1,s2");
  check("subtasksOf: 子が無ければ空", subtasksOf(all, "s1").length === 0);
}

// ── 折りたたみ ──
{
  check("columnKey: ステータスは ID、未割当は決まった文字列", columnKey("todo") === "todo" && columnKey(null) === UNASSIGNED_KEY);
  check("toggleCollapsed: 足す", toggleCollapsed(["a"], "b").join() === "a,b");
  check("toggleCollapsed: 外す", toggleCollapsed(["a", "b"], "a").join() === "b");
  const a = ["a"];
  toggleCollapsed(a, "b");
  check("toggleCollapsed: 元の配列は変えない", a.join() === "a");
  const cols = buildKanbanColumns([T("x", "todo"), T("y", undefined)], ST, []);
  check("collapseColumns all: 今出ている列すべて", collapseColumns(cols, [], "all").join() === `${UNASSIGNED_KEY},todo,doing,done`);
  check("collapseColumns empty: カードの無い列を足す", collapseColumns(cols, [], "empty").join() === "doing,done");
  check("collapseColumns empty: 今の折りたたみは保つ", collapseColumns(cols, ["todo"], "empty").join() === "todo,doing,done");
  check("collapseColumns empty: 出ていない列のキーは捨てる", collapseColumns(cols, ["ghost"], "empty").join() === "doing,done");
  check("collapseColumns none: すべて開く", collapseColumns(cols, ["todo", "done"], "none").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
