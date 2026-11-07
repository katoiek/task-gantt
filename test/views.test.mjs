// ビュー（作成・複製・改名・削除・鍵の追従）の検証 / Tests for views (create, duplicate, rename, delete, key moves)
import {
  cloneConfig,
  boardKey,
  uniqueName,
  createBoardViews,
  addView,
  duplicateView,
  renameView,
  deleteView,
  activeView,
  moveBoardKeys,
  eachConfig,
  repairBoardViews,
} from "./views.mjs";

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

const cfg = (over = {}) => ({
  groupBy: "folder",
  colorBy: "status",
  flat: false,
  rollup: false,
  showEmptyFolders: true,
  progressLine: false,
  hideLabels: false,
  markOverdue: false,
  filters: [],
  filterMatch: "all",
  visibleColumns: ["start", "end"],
  columnWidths: {},
  sortBy: "start",
  sortDir: "asc",
  zoom: "Week",
  collapsed: [],
  ...over,
});

// ── boardKey ──
check("boardKey: フォルダのパス", boardKey("Projects/A") === "folder:Projects/A");
check("boardKey: 前後の / は無視", boardKey("/Projects/A/") === "folder:Projects/A");
check("boardKey: Vault のルートは空", boardKey("") === "folder:");

// ── createBoardViews / activeView ──
{
  const bv = createBoardViews("Gantt", cfg());
  check("create: ビューが 1 つ・それが開いている", bv.views.length === 1 && bv.active === bv.views[0].id && activeView(bv).name === "Gantt");
  check("create: 種類は gantt", bv.views[0].type === "gantt");
  bv.active = "gone";
  check("activeView: 開いているビューが無ければ先頭", activeView(bv) === bv.views[0]);
}

// ── uniqueName / addView ──
{
  const bv = createBoardViews("Gantt", cfg());
  check("uniqueName: 重ならなければそのまま", uniqueName(bv, "Plan") === "Plan");
  check("uniqueName: 重なれば連番", uniqueName(bv, "Gantt") === "Gantt 2");
  const a = addView(bv, "Gantt", cfg());
  const b = addView(bv, "Gantt", cfg());
  check("addView: 末尾に足し、名前は連番", bv.views.length === 3 && a.name === "Gantt 2" && b.name === "Gantt 3");
  check("addView: ID は重ならない", new Set(bv.views.map((v) => v.id)).size === 3);
  check("addView: 空の名前は View に", addView(bv, "   ", cfg()).name === "View");
  check("addView: 開くのは呼び出し側（active は変わらない）", bv.active === "v1");
}

// ── duplicateView ──
{
  const bv = createBoardViews("Gantt", cfg({ filters: [{ kind: "text", field: "name", op: "contains", value: "x" }], visibleColumns: ["start", "end", "status"], columnWidths: { start: 90 } }));
  addView(bv, "Other", cfg());
  const copy = duplicateView(bv, "v1", (n) => `${n} copy`);
  check("duplicate: 元の右隣に入る", bv.views[1] === copy && bv.views.map((v) => v.name).join() === "Gantt,Gantt copy,Other");
  check("duplicate: 設定がそっくり同じ", JSON.stringify(copy.config) === JSON.stringify(bv.views[0].config));
  copy.config.filters.push({ kind: "text", field: "name", op: "contains", value: "y" });
  copy.config.visibleColumns.push("tags");
  copy.config.columnWidths.start = 120;
  check("duplicate: 配列・オブジェクトは共有しない（変えても元は変わらない）", bv.views[0].config.filters.length === 1 && bv.views[0].config.visibleColumns.length === 3 && bv.views[0].config.columnWidths.start === 90);
  check("duplicate: 無い ID は null", duplicateView(bv, "nope", (n) => n) === null);
  const again = duplicateView(bv, "v1", (n) => `${n} copy`);
  check("duplicate: 2 回目は名前が連番", again.name === "Gantt copy 2");
}

// ── renameView ──
{
  const bv = createBoardViews("Gantt", cfg());
  addView(bv, "Plan", cfg());
  check("rename: 名前が変わる", renameView(bv, "v1", "  Board A  ") && bv.views[0].name === "Board A");
  check("rename: 空は拒否", !renameView(bv, "v1", "   ") && bv.views[0].name === "Board A");
  check("rename: 同じ名前なら変更なし", !renameView(bv, "v1", "Board A"));
  check("rename: 他と重なれば連番", renameView(bv, "v1", "Plan") && bv.views[0].name === "Plan 2");
  check("rename: 無い ID は false", !renameView(bv, "nope", "X"));
}

// ── deleteView ──
{
  const bv = createBoardViews("A", cfg());
  addView(bv, "B", cfg());
  addView(bv, "C", cfg());
  bv.active = "v3";
  check("delete: 開いているビューを消すと左隣が開く", deleteView(bv, "v3") && bv.active === "v2" && bv.views.length === 2);
  bv.active = "v1";
  check("delete: 先頭を消すと右隣が開く", deleteView(bv, "v1") && bv.active === "v2" && bv.views.length === 1);
  check("delete: 最後の 1 つは消せない", !deleteView(bv, "v2") && bv.views.length === 1);
  const bv2 = createBoardViews("A", cfg());
  addView(bv2, "B", cfg());
  bv2.active = "v1";
  check("delete: 開いていないビューを消しても active は変わらない", deleteView(bv2, "v2") && bv2.active === "v1");
  check("delete: 無い ID は false", !deleteView(bv2, "nope") === true);
}

// ── moveBoardKeys ──
{
  const mk = () => createBoardViews("G", cfg());
  const map = { "folder:Projects": mk(), "folder:Projects/Sub": mk(), "folder:Other": mk() };
  const moved = moveBoardKeys(map, "Projects", "Work");
  check("moveBoardKeys: フォルダ名の変更に追従（配下も）", moved && Object.keys(map).sort().join() === "folder:Other,folder:Work,folder:Work/Sub");
  const map2 = { "folder:A": mk(), "folder:B": mk() };
  const before = map2["folder:B"];
  moveBoardKeys(map2, "A", "B");
  check("moveBoardKeys: 行き先に既にあれば上書きしない", map2["folder:B"] === before && "folder:A" in map2);
  check("moveBoardKeys: 似た名前（Projects2）は動かさない", (() => {
    const m = { "folder:Projects2": mk() };
    return !moveBoardKeys(m, "Projects", "Work") && "folder:Projects2" in m;
  })());
}

// ── eachConfig / cloneConfig ──
{
  const map = { "folder:A": createBoardViews("G", cfg()), "folder:B": createBoardViews("G", cfg()) };
  addView(map["folder:A"], "H", cfg());
  let n = 0;
  eachConfig(map, (c) => {
    c.visibleColumns.push("cf:1");
    n++;
  });
  check("eachConfig: 全ボードの全ビューに適用", n === 3 && Object.values(map).every((bv) => bv.views.every((v) => v.config.visibleColumns.includes("cf:1"))));
  const c = cfg({ visibleColumns: ["a"] });
  const d = cloneConfig(c);
  d.visibleColumns.push("b");
  check("cloneConfig: 複製は元と独立", c.visibleColumns.length === 1);
}

// ── repairBoardViews ──
{
  const base = cfg();
  const good = createBoardViews("G", cfg({ zoom: "Month" }));
  const raw = {
    "folder:ok": JSON.parse(JSON.stringify(good)),
    "folder:noviews": { active: "v1", views: [] },
    "folder:garbage": "text",
    "folder:partial": { active: "gone", views: [{ id: "a", name: "A", type: "gantt", config: { zoom: "Day" } }, { id: 5, name: "bad" }] },
  };
  const fixed = repairBoardViews(raw, base);
  check("repair: 壊れたボードは捨てる", Object.keys(fixed).sort().join() === "folder:ok,folder:partial");
  check("repair: 正しいものはそのまま", fixed["folder:ok"].views[0].config.zoom === "Month" && fixed["folder:ok"].active === "v1");
  check("repair: 足りない設定は base で補う", fixed["folder:partial"].views[0].config.zoom === "Day" && fixed["folder:partial"].views[0].config.sortBy === "start" && Array.isArray(fixed["folder:partial"].views[0].config.visibleColumns));
  check("repair: 壊れたビュー（ID が数など）は捨てる", fixed["folder:partial"].views.length === 1);
  check("repair: 開いているビューが無ければ先頭", fixed["folder:partial"].active === "a");
  fixed["folder:ok"].views[0].config.visibleColumns.push("x");
  check("repair: base や元のデータと配列を共有しない", base.visibleColumns.length === 2 && raw["folder:ok"].views[0].config.visibleColumns.length === 2);
  check("repair: 空や不正な入力は空", Object.keys(repairBoardViews(null, base)).length === 0 && Object.keys(repairBoardViews("x", base)).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
