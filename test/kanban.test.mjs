// カンバンの振り分け（列の並び・未割当・サブタスク）の検証 / Tests for the Kanban sorting (column order, unassigned, subtasks)
import { buildKanbanColumns, moveStatus, subtasksOf } from "./kanban.mjs";

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

// ── buildKanbanColumns ──
{
  const cols = buildKanbanColumns([T("a", "todo"), T("b", "done"), T("c", "todo"), T("d", undefined), T("e", "ghost")], ST);
  check("列: 先頭が未割当、続いてステータスの順", ids(cols).map((x) => x ?? "-").join() === "-,todo,doing,done");
  check("列: ステータスごとに分け、渡された順を保つ", paths(cols[1]) === "a,c" && paths(cols[3]) === "b" && paths(cols[2]) === "");
  check("列: ステータスなし・設定にない ID は未割当", paths(cols[0]) === "d,e");
}
{
  const reordered = [ST[2], ST[0], ST[1]];
  const cols = buildKanbanColumns([T("a", "todo")], reordered);
  check("列: 設定のステータスの並びがそのまま列の並びになる（先頭は未割当）", cols.map((c) => c.status ?? "-").join() === "-,done,todo,doing");
}
{
  const cols = buildKanbanColumns([T("p", "todo"), T("s1", "doing", "p"), T("s2", "done", "p")], ST);
  check("サブタスク: 親が表示中なら、独立したカードにしない", paths(cols[1]) === "p" && paths(cols[2]) === "" && paths(cols[3]) === "");
}
{
  const cols = buildKanbanColumns([T("s1", "doing", "p")], ST);
  check("サブタスク: 親がフィルタで外れていれば、独立したカード", paths(cols[2]) === "s1");
}
check("列: タスクが無くても全部の列が出る", buildKanbanColumns([], ST).length === 4);

// ── moveStatus ──
{
  const order = (list) => list.map((x) => x.id).join();
  check("moveStatus: 前へ動かす", order(moveStatus(ST, "done", "todo", false)) === "done,todo,doing");
  check("moveStatus: 後ろへ動かす", order(moveStatus(ST, "todo", "doing", true)) === "doing,todo,done");
  check("moveStatus: 末尾へ（最後の列の後ろ）", order(moveStatus(ST, "todo", "done", true)) === "doing,done,todo");
  check("moveStatus: 先頭へ（最初の列の前）", order(moveStatus(ST, "done", "todo", false)).startsWith("done"));
  check("moveStatus: 同じ位置になる動きは null", moveStatus(ST, "todo", "doing", false) === null && moveStatus(ST, "doing", "todo", true) === null);
  check("moveStatus: 自分自身・知らない ID は null", moveStatus(ST, "todo", "todo", true) === null && moveStatus(ST, "ghost", "todo", false) === null && moveStatus(ST, "todo", "ghost", false) === null);
  const before = ST.map((x) => x.id).join();
  moveStatus(ST, "done", "todo", false);
  check("moveStatus: 元の配列は変えない", ST.map((x) => x.id).join() === before);
}

// ── subtasksOf ──
{
  const all = [T("p", "todo"), T("s1", "doing", "p"), T("s2", "done", "p"), T("q", "todo"), T("s3", "todo", "q")];
  check("subtasksOf: 直下のサブタスクを、渡された順に", subtasksOf(all, "p").map((t) => t.path).join() === "s1,s2");
  check("subtasksOf: 子が無ければ空", subtasksOf(all, "s1").length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
