// buildRows / マイルストーン判定 / span 集約 の検証
// Tests for buildRows, milestone detection, and group span rollup
import { bodyOf, withBody, movePaths, buildRows, kanbanLanes, listWith, newStatus, moveCollapsed, cardProgress, kanbanStep, anchorStart, anchorEnd, subtreePaths, parseStored, combineDateTime, toInstant, inferStatusGroup, statusGroupOf, customFieldIssues, validCustomFields, readCustomValue, customValueText, parseCustomInput } from "./model.mjs";

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

// カンバンの進捗：100% は全部、0% は 1 枚も無いときだけ / kanban progress: 100% only when all are done, 0% only when none are
check("cardProgress 199/200 は 99", cardProgress(199, 200) === 99);
check("cardProgress 全部で 100", cardProgress(200, 200) === 100);
check("cardProgress 1/201 は 1", cardProgress(1, 201) === 1);
check("cardProgress 0 枚は 0", cardProgress(0, 5) === 0);
// Obsidian のメタデータ（見出し・リスト項目・区切り線）を本文から作る小さな代役 / a small stand-in for Obsidian's metadata (headings, list items, thematic breaks)
function fakeCache(text) {
  const cache = { headings: [], listItems: [], sections: [] };
  let offset = 0;
  text.split("\n").forEach((line, i) => {
    const position = { start: { line: i, col: 0, offset }, end: { line: i, col: line.length, offset: offset + line.length } };
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const li = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s+)?/);
    if (h) cache.headings.push({ level: h[1].length, heading: h[2], position });
    else if (line.trim() === "***") cache.sections.push({ type: "thematicBreak", position });
    else if (li) cache.listItems.push({ parent: li[1] ? i - 1 : -i, task: li[2], position });
    offset += line.length + 1;
  });
  return [cache, text];
}
const lanesOf = (text) => kanbanLanes(...fakeCache(text)).map((l) => `${l.title}:${l.cards.map((c) => `${c.text}${c.done ? "✓" : ""}`).join("+")}`).join(" | ");

// 列の中のどの箇条書きもカード（チェックの有無・記号を問わない）/ any bullet in a lane is a card, checkbox or not
check("kanbanLanes: 箇条書きはすべてカード", lanesOf(["## Todo", "- idea", "+ [x] done", "1. [ ] numbered", "## Done", "- [x] shipped"].join("\n")) === "Todo:idea+done✓+numbered | Done:shipped✓");
// アーカイブ（*** の後の ## Archive）は列にも数にも入らない / the archive (## Archive after ***) is neither a lane nor counted
const archived = ["## Doing", "- [ ] a", "- [ ] b", "## Done", "- [x] c", "", "***", "", "## Archive", "", "- [x] old 1", "- [x] old 2"].join("\n");
check("kanbanLanes: アーカイブは数えない", lanesOf(archived) === "Doing:a+b | Done:c✓");
check("kanbanLanes: 文字なしでも数は同じ", kanbanLanes(fakeCache(archived)[0]).flatMap((l) => l.cards).length === 3);

// 担当者などの多値フィールドに 1 件足す・外す / adding or removing one entry of a multi-valued field
check("listWith: 1 人に足すとリスト", JSON.stringify(listWith("Ana", "Ben", true)) === '["Ana","Ben"]');
check("listWith: 同じ人（表示名が同じ）は足さない", listWith(["[[Ben]]"], "Ben", true) === undefined);
check("listWith: 引用符なしの [[x]] は文字列にして残す", JSON.stringify(listWith([["Ana"]], "Ben", true)) === '["[[Ana]]","Ben"]');
check("listWith: 外してもほかの値は書いたまま", JSON.stringify(listWith(["Ana", 7, "Ben"], "Ben", false)) === '["Ana",7]');
check("listWith: リストはリストのまま", JSON.stringify(listWith(["Ana", "Ben"], "Ben", false)) === '["Ana"]');
check("listWith: 最後の 1 人を外すと null（キーごと消す）", listWith("Ana", "Ana", false) === null);
check("listWith: いない人は外せない（変更なし）", listWith("Ana", "Ben", false) === undefined);

// フォルダの改名：畳んだ親タスク（パス）は追いかけ、見出しのキー（相対）とほかの軸はそのまま
// a folder rename: collapsed parent tasks (paths) follow it, heading keys (relative) and other axes stay
check("moveCollapsed", moveCollapsed(["folder:Proj/Launch.md", "folder:Design", "status:Done", "folder:Other/x.md"], "Proj", "Work").join() === "folder:Work/Launch.md,folder:Design,status:Done,folder:Other/x.md");

// 新しいステータス：id は名前から連番、色は未使用のパレット色 / a new status: id from the label (numbered), an unused palette colour
const st0 = [{ id: "todo", label: "To do", color: "#ef4444", group: "active" }];
const st1 = newStatus(st0, "In review");
check("newStatus: id は名前から", st1.id === "in-review" && st1.label === "In review" && st1.group === "active");
check("newStatus: 使っていない色", st1.color !== "#ef4444");
check("newStatus: 同じ名前は連番", newStatus([...st0, st1], "In review").id === "in-review-2");

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

// フォルダ直下のタスクはサブフォルダより先（後だと直前のサブフォルダの中に見える）
// a folder's own tasks come before its subfolders (after them they'd read as part of the subfolder above)
const mixed = buildRows([
  { path: "p/Root task.md", name: "Root task", groups: [], start: "2026-02-01", end: "2026-02-01", milestone: false },
  { path: "p/A/In A.md", name: "In A", groups: ["A"], start: "2026-02-02", end: "2026-02-02", milestone: false },
]);
check("ルート直下のタスクがフォルダより先", mixed[0].kind === "task" && mixed[0].task.name === "Root task" && mixed[1].group === "A");

// ----- カンバン本文 / kanban bodies -----
check("カンバン: 列とカードと完了", lanesOf(["## To do", "", "- [ ] Header", "- [ ] Footer", "  - [x] nested, not a card", "", "## Done", "", "**Complete**", "- [x] Setup"].join("\n")) === "To do:Header+Footer | Done:Setup✓");
check("カンバン: 列より前のリストは無視", lanesOf("- [ ] stray\n## L\n- card") === "L:card");

// カンバンの今と次のカード / a kanban's current and next card
const KS = [{ id: "todo", label: "To do", group: "active" }, { id: "in-progress", label: "In progress", group: "active" }, { id: "blocked", label: "Blocked", group: "deferred" }, { id: "done", label: "Done", group: "completed" }];
const lane = (title, ...cards) => ({ title, cards: cards.map((c) => ({ text: c.replace(/^x /, ""), done: c.startsWith("x ") })) });
check("カンバン: 「始めた」列の最初の未チェックが今", JSON.stringify(kanbanStep([lane("To do", "a"), lane("In progress", "x b", "c"), lane("Done", "x d")], KS, "in-progress")) === '{"card":"c","stage":"In progress","now":true}');
check("カンバン: 今が無ければ止めた・完了の列を飛ばして次", JSON.stringify(kanbanStep([lane("Blocked", "z"), lane("To do", "x a", "b"), lane("In progress", "x c")], KS, "in-progress")) === '{"card":"b","stage":"To do"}');
check("カンバン: 工程の列（ステータスでない）は順に読む・書式は外す", JSON.stringify(kanbanStep([lane("שלב 1", "x א"), lane("שלב 2", "[[DB|חיבור]] @{2026-11-10}")], KS, "in-progress")) === '{"card":"חיבור","stage":"שלב 2"}');
check("カンバン: 全部済みなら何も無し", JSON.stringify(kanbanStep([lane("To do", "x a")], KS, "in-progress")) === "{}");

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
// 入れ子の子には sub の印 / a nested child is marked sub
check("入れ子の子だけ sub", cRow.sub === true && !pRow.sub);

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

// successorClosure は schedule.test.mjs へ移動 / successorClosure moved to schedule.test.mjs

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

// 本文とフロントマターの切り分け（CRLF・中身の無い ---/---・フロントマター無し）/ splitting body and frontmatter (CRLF, an empty ---/---, none at all)
check("bodyOf: 普通のフロントマター", bodyOf("---\na: 1\n---\nhello\n") === "hello");
check("bodyOf: CRLF", bodyOf("---\r\na: 1\r\n---\r\nhello\r\n") === "hello");
check("bodyOf: 中身の無い ---/--- は本文に出さない", bodyOf("---\n---\nhello") === "hello" && bodyOf("---\n---") === "");
check("bodyOf: フロントマター無し", bodyOf("hello\n---\nx") === "hello\n---\nx");
check("withBody: フロントマターの直後に空行を足さない", withBody("---\na: 1\n---\nold\n", "new") === "---\na: 1\n---\nnew\n");
check("withBody: CRLF のフロントマターはそのまま", withBody("---\r\na: 1\r\n---\r\nold", "new") === "---\r\na: 1\r\n---\r\nnew\n");
check("withBody: 中身の無い ---/--- を保つ・本文を空にできる", withBody("---\n---", "x") === "---\n---\nx\n" && withBody("---\na: 1\n---\nold", "") === "---\na: 1\n---\n");
check("withBody: フロントマター無し", withBody("old", "new") === "new\n");

check("movePaths: ファイルとフォルダの改名に付いて行く", movePaths(["A/x.md", "A/sub/y.md", "B.md", "AB.md"], "A", "Z").join() === "Z/x.md,Z/sub/y.md,B.md,AB.md" && movePaths(["B.md"], "B.md", "C.md")[0] === "C.md");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
