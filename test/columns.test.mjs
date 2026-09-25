// 列定義の並び・表示・並べ替え（visibleColumns / columnWidth / taskComparator）の検証
// Tests for column order, visibility, widths and sorting (visibleColumns / columnWidth / taskComparator)
import { BUILTIN_COLUMNS, visibleColumns, columnWidth, taskComparator } from "./columns.mjs";

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

const ids = (cols) => cols.map((c) => c.id).join(",");
const byId = (id) => BUILTIN_COLUMNS.find((c) => c.id === id);

// ── 定義 / definitions ──
check("built-in order", ids(BUILTIN_COLUMNS) === "name,start,end,progress,assignee,status,tags");
check("only name is non-optional", ids(BUILTIN_COLUMNS.filter((c) => !c.optional)) === "name");
// 表示できる列はすべて Inline edit に対応（name 以外は edit を持つ）/ every non-name column has an editor
check("every cell column has paint + edit + editAria", BUILTIN_COLUMNS.filter((c) => c.kind === "cell").every((c) =>
  typeof c.paint === "function" && typeof c.edit === "function" && typeof c.editAria === "function"));
check("name column is the only name kind", ids(BUILTIN_COLUMNS.filter((c) => c.kind === "name")) === "name");

// ── visibleColumns ──
check("name always visible", ids(visibleColumns(BUILTIN_COLUMNS, [])) === "name");
check("definition order, not settings order", ids(visibleColumns(BUILTIN_COLUMNS, ["tags", "start"])) === "name,start,tags");
check("unknown ids are ignored", ids(visibleColumns(BUILTIN_COLUMNS, ["ghost", "end"])) === "name,end");

// ── columnWidth ──
check("default width", columnWidth(byId("start"), {}) === 84);
check("user override wins", columnWidth(byId("start"), { start: 120 }) === 120);

// ── taskComparator ──
const task = (o) => ({ path: `${o.name}.md`, groups: [], deps: [], milestone: false, tags: [], ...o });
const STATUSES = [
  { id: "todo", label: "To do", color: "#888", group: "active" },
  { id: "doing", label: "Doing", color: "#08f", group: "active" },
  { id: "done", label: "Done", color: "#0a0", group: "completed" },
];
const settings = (sortBy, sortDir = "asc") => ({ sortBy, sortDir, statuses: STATUSES });
const sorted = (list, s) => list.slice().sort(taskComparator(BUILTIN_COLUMNS, s)).map((t) => t.name).join(",");

const A = task({ name: "b-task", start: "2024-03-02", end: "2024-03-09", progress: 50, assignee: "Zed", status: "done", tags: ["x"] });
const B = task({ name: "A-task", start: "2024-03-01", end: "2024-03-20", progress: 0, assignee: "amy", status: "todo", tags: ["b", "a"] });
const C = task({ name: "c-task", status: "ghost" }); // 日付・進捗なし、未知ステータス / no dates or progress, unknown status
const M = task({ name: "mile", milestone: true, end: "2024-03-05" }); // マイルストーンは期限日で並ぶ / milestone anchors on its due date
const ALL = [A, B, C, M];

check("name: case-insensitive", sorted(ALL, settings("name")) === "A-task,b-task,c-task,mile");
check("start: undated last, milestone by due date", sorted(ALL, settings("start")) === "A-task,b-task,mile,c-task");
check("end", sorted(ALL, settings("end")) === "mile,b-task,A-task,c-task");
check("progress: unset before 0%", sorted(ALL, settings("progress")) === "c-task,mile,A-task,b-task");
check("assignee: case-insensitive, unset first", sorted(ALL, settings("assignee")) === "c-task,mile,A-task,b-task");
check("status: configured order, unknown/unset last", sorted([A, B, C], settings("status")) === "A-task,b-task,c-task");
check("tags joined", sorted([A, B], settings("tags")) === "A-task,b-task");
check("desc flips", sorted(ALL, settings("name", "desc")) === "mile,c-task,b-task,A-task");
check("unknown sort column falls back to start", sorted(ALL, settings("ghost")) === sorted(ALL, settings("start")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
