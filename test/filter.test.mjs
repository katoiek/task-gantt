// フィルタ判定（matchFilter / applyFilters）とグループ再マッピング（regroup）の検証
// Tests for filter matching (matchFilter / applyFilters) and group remapping (regroup)
import { matchFilter, applyFilters, regroup, besideHeading, isOverdue, isUrgent, interruptions, runningWorkOf, attentionOf, exceptionOf, exceptionsOf, subtaskSummary, urgentFirst, strongest } from "./filter.mjs";

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

// テスト用のタスクとステータス定義 / fixtures
const task = (o) => ({ path: `${o.name}.md`, groups: ["Proj"], deps: [], milestone: false, tags: [], assignees: [], ...o });
const STATUSES = [
  { id: "todo", label: "To do", color: "#888", group: "active" },
  { id: "done", label: "Done", color: "#0a0", group: "completed" },
  { id: "drop", label: "Dropped", color: "#a00", group: "cancelled" },
];
const TODAY = 20000; // 任意の通日番号 / an arbitrary day index
const names = (list) => list.map((t) => t.name).join(",");

const A = task({ name: "Alpha Plan", status: "todo", assignees: ["kei"], tags: ["work", "urgent"] });
const B = task({ name: "Beta", status: "done", tags: ["work"] });
const C = task({ name: "gamma", status: "ghost" }); // 設定に無い id / unknown id
const D = task({ name: "Delta" }); // 何も未設定 / nothing set
const ALL = [A, B, C, D];

// ── テキスト 6 演算子（大文字小文字無視・前後空白無視）/ six text ops (case- and whitespace-insensitive) ──
const text = (op, value) => ({ kind: "text", field: "name", op, value });
check("text is (case-insensitive)", matchFilter(A, text("is", " alpha plan "), STATUSES, TODAY));
check("text isNot", !matchFilter(A, text("isNot", "ALPHA PLAN"), STATUSES, TODAY) && matchFilter(B, text("isNot", "alpha plan"), STATUSES, TODAY));
check("text contains", matchFilter(A, text("contains", "PLA"), STATUSES, TODAY));
check("text notContains", !matchFilter(A, text("notContains", "plan"), STATUSES, TODAY) && matchFilter(B, text("notContains", "plan"), STATUSES, TODAY));
check("text startsWith", matchFilter(A, text("startsWith", "al"), STATUSES, TODAY) && !matchFilter(B, text("startsWith", "al"), STATUSES, TODAY));
check("text endsWith", matchFilter(A, text("endsWith", "plan"), STATUSES, TODAY) && !matchFilter(A, text("endsWith", "alpha"), STATUSES, TODAY));
check("text empty query passes everything", ALL.every((t) => matchFilter(t, text("isNot", "  "), STATUSES, TODAY)));

// ── カテゴリ / category ──
const cat = (field, op, values = []) => ({ kind: "category", field, op, values });
check("status is (OR within field)", names(applyFilters(ALL, [cat("status", "is", ["todo", "done"])], "all", STATUSES, TODAY)) === "Alpha Plan,Beta");
check("status is \"\" (unset sentinel)", names(applyFilters(ALL, [cat("status", "is", [""])], "all", STATUSES, TODAY)) === "Delta");
check("status isNot excludes the listed values", names(applyFilters(ALL, [cat("status", "isNot", ["todo"])], "all", STATUSES, TODAY)) === "Beta,gamma,Delta");
check("assignee empty / notEmpty",
  names(applyFilters(ALL, [cat("assignee", "empty")], "all", STATUSES, TODAY)) === "Beta,gamma,Delta"
  && names(applyFilters(ALL, [cat("assignee", "notEmpty")], "all", STATUSES, TODAY)) === "Alpha Plan");
check("tag is matches any of the task's tags", names(applyFilters(ALL, [cat("tag", "is", ["urgent"])], "all", STATUSES, TODAY)) === "Alpha Plan");
check("tag is \"\" = untagged", names(applyFilters(ALL, [cat("tag", "is", [""])], "all", STATUSES, TODAY)) === "gamma,Delta");

// statusGroup：未知 id と未設定は「未設定」扱い → 未完了（isNot completed/cancelled）に含まれる
// statusGroup: unknown ids and unset read as unset, so they count as incomplete
check("statusGroup is completed", names(applyFilters(ALL, [cat("statusGroup", "is", ["completed"])], "all", STATUSES, TODAY)) === "Beta");
check("statusGroup unknown id = unset", names(applyFilters(ALL, [cat("statusGroup", "empty")], "all", STATUSES, TODAY)) === "gamma,Delta");
check("statusGroup incomplete keeps unknown/unset",
  names(applyFilters(ALL, [cat("statusGroup", "isNot", ["completed", "cancelled"])], "all", STATUSES, TODAY)) === "Alpha Plan,gamma,Delta");

// ── 日付（開始・期限）/ date ──
const E = task({ name: "Eps", start: "2024-10-01", end: "2024-10-05" });
const M = task({ name: "Mile", milestone: true, end: "2024-10-10" });
const date = (field, op, value) => ({ kind: "date", field, op, value });
const spec = (d) => ({ kind: "specific", date: d });
check("date start is", matchFilter(E, date("start", "is", spec("2024-10-01")), STATUSES, TODAY));
check("date end before", matchFilter(E, date("end", "before", spec("2024-10-06")), STATUSES, TODAY));
check("date start of a milestone anchors on its due date", matchFilter(M, date("start", "is", spec("2024-10-10")), STATUSES, TODAY));
check("date empty matches undated tasks only", matchFilter(D, date("start", "empty"), STATUSES, TODAY) && !matchFilter(E, date("start", "empty"), STATUSES, TODAY));

// ── AND / OR ──
const f1 = cat("tag", "is", ["work"]);
const f2 = cat("status", "is", ["done"]);
check("AND (all)", names(applyFilters(ALL, [f1, f2], "all", STATUSES, TODAY)) === "Beta");
check("OR (any)", names(applyFilters(ALL, [f1, f2], "any", STATUSES, TODAY)) === "Alpha Plan,Beta");
check("no filters returns the input as is", applyFilters(ALL, [], "all", STATUSES, TODAY) === ALL);

// 人は表示名で比べる / people compare by display name
{
  const t = { path: "x.md", name: "x", groups: [], tags: [], assignees: ["[[People/Ben]]"], deps: [], milestone: false };
  check("担当者フィルタ: \"Ben\" は \"[[People/Ben]]\" にも当たる", matchFilter(t, { kind: "category", field: "assignee", op: "is", values: ["Ben"] }, STATUSES, 0));
}

// ── besideHeading：見出しが示す値は行で繰り返さない / a row doesn't repeat its heading's value ──
check("assignee heading drops that person (by display name)", besideHeading(["[[People/Ana]]", "Ben"], "assignees", "assignee", "Ana").join() === "Ben");
check("tag heading drops that tag", besideHeading(["ux", "brand"], "tags", "tag", "ux").join() === "brand");
check("other axes keep every value", besideHeading(["ux", "brand"], "tags", "assignee", "ux").join() === "ux,brand");
check("flat rows (heading \"\") keep every value", besideHeading(["Ana"], "assignees", "assignee", "").join() === "Ana");

// ── regroup ──
const groupsOf = (list) => list.map((t) => `${t.name}:${t.groups[0]}`).join(",");
check("folder grouping is untouched", regroup(ALL, "folder", false, STATUSES, "(none)") === ALL);
check("flat skips remapping", regroup(ALL, "tag", true, STATUSES, "(none)") === ALL);
check("tag grouping duplicates multi-tag tasks",
  groupsOf(regroup(ALL, "tag", false, STATUSES, "(none)")) === "Alpha Plan:work,Alpha Plan:urgent,Beta:work,gamma:(none),Delta:(none)");
check("status grouping uses labels, raw id for unknown, none for unset",
  groupsOf(regroup(ALL, "status", false, STATUSES, "(none)")) === "Alpha Plan:To do,Beta:Done,gamma:ghost,Delta:(none)");
check("assignee grouping", groupsOf(regroup(ALL, "assignee", false, STATUSES, "(none)")) === "Alpha Plan:kei,Beta:(none),gamma:(none),Delta:(none)");

// ── 担当者（多値）/ assignees (multi-valued) ──
const S = task({ name: "Shared", assignees: ["kei", "[[Ana Lee]]"] });
check("a shared task is copied into each assignee's group, wikilinks by their label",
  groupsOf(regroup([S], "assignee", false, STATUSES, "(none)")) === "Shared:kei,Shared:Ana Lee");
check("assignee is matches any of the task's assignees",
  names(applyFilters([A, S, B], [cat("assignee", "is", ["[[Ana Lee]]"])], "all", STATUSES, TODAY)) === "Shared");
check("assignee isNot drops a task that has the person among others",
  names(applyFilters([A, S, B], [cat("assignee", "isNot", ["kei"])], "all", STATUSES, TODAY)) === "Beta");
check("regroup doesn't mutate the input", A.groups[0] === "Proj");

// ── 期限切れ（バーの印と見出しの件数）/ overdue (the bar mark and the heading counts) ──
const due = (end, status) => task({ name: "o", end, status });
const OCT1 = Date.UTC(2024, 9, 1) / 864e5;
check("overdue: due before today and still open", isOverdue(due("2024-09-30", "todo"), STATUSES, OCT1));
check("overdue: no status counts as open", isOverdue(due("2024-09-30"), STATUSES, OCT1));
check("not overdue: completed or cancelled",
  !isOverdue(due("2024-09-30", "done"), STATUSES, OCT1) && !isOverdue(due("2024-09-30", "drop"), STATUSES, OCT1));
check("not overdue: due today, or no dates", !isOverdue(due("2024-10-01", "todo"), STATUSES, OCT1) && !isOverdue(task({ name: "n" }), STATUSES, OCT1));

// ── 急ぎ・割り込み・例外・サブタスクの要約 / urgent, interrupted, exceptions, subtask summary ──
const U = (o) => task({ name: "u", ...o });
check("urgent: urgent / expedite / דחוף in any case; other priorities are normal work",
  isUrgent(U({ priority: "Urgent" })) && isUrgent(U({ priority: " expedite " })) && isUrgent(U({ priority: "דחוף" })) && !isUrgent(U({ priority: "high" })) && !isUrgent(U({})));
const ST = [...STATUSES, { id: "doing", label: "Doing", color: "#00f", group: "active" }, { id: "hold", label: "Blocked", color: "#f00", group: "deferred" }];
const hot = U({ name: "Hotfix", path: "hot.md", priority: "urgent", status: "doing", assignees: ["[[Dana]]"], start: "2024-09-30", end: "2024-10-30" });
const cur = U({ name: "Adapter", path: "cur.md", status: "doing", assignees: ["Dana"], start: "2024-09-20", end: "2024-10-30" });
const later = U({ name: "Later", path: "later.md", status: "doing", assignees: ["Dana"], start: "2024-10-20" });
const held = U({ name: "Held", path: "held.md", status: "hold", assignees: ["Dana"], start: "2024-09-20", end: "2024-10-30" });
const other = U({ name: "Other", path: "other.md", status: "doing", assignees: ["Eli"], start: "2024-09-20", end: "2024-10-30" });
const NONE = { interrupted: new Map(), resume: new Map() };
const keys = (m) => [...m.keys()].join();
const by = (r, p) => (r.get(p) ?? []).map((u) => u.path).join();
// 推測しない：リンクの無い急ぎ仕事は誰も割り込まない / nothing inferred: urgent work without links interrupts nobody
const ip0 = interruptions([hot, cur, later, held, other], ST, OCT1);
check("no links, no interruption (nothing is inferred from assignees or dates)", ip0.interrupted.size === 0 && ip0.resume.size === 0);
// 候補は「始めた」ステータス（ここでは doing）の、同じ人の仕事だけ。To do・止まっている・ほかの人・日付だけでは数えない
// candidates are only the same person's work in the started status (doing here); To do, blocked, other people or dates alone don't count
const todoStarted = U({ name: "Queued", path: "q.md", status: "todo", assignees: ["Dana"], start: "2024-09-01", end: "2024-10-30" });
check("candidates: the started status only, same person, not urgent", runningWorkOf(hot, [hot, cur, later, held, other, todoStarted], "doing").map((t) => t.path).join() === "cur.md,later.md");
check("candidates: none without a started status", runningWorkOf(hot, [hot, cur], undefined).length === 0);
// 明示のリンク（「急ぎにする」で書く）/ explicit links (written by "Mark as urgent")
const linked = { ...hot, interrupts: ["cur.md"] };
const ip = interruptions([linked, cur, other], ST, OCT1);
check("linked: interrupted while the urgent work runs, by that urgent task", by(ip.interrupted, "cur.md") === "hot.md");
check("linked: an urgent task that hasn't started yet interrupts nobody", interruptions([{ ...linked, start: "2024-10-05" }, cur], ST, OCT1).interrupted.size === 0);
const after = interruptions([{ ...linked, status: "done" }, cur], ST, OCT1);
check("linked: once the urgent work is done the task waits to be resumed", after.interrupted.size === 0 && by(after.resume, "cur.md") === "hot.md");
check("linked: a finished target needs no resuming", interruptions([{ ...linked, status: "done" }, { ...cur, status: "done" }], ST, OCT1).resume.size === 0);
check("linked: only the linked task, not the person's other running work", keys(interruptions([linked, cur, { ...cur, path: "cur2.md" }], ST, OCT1).interrupted) === "cur.md");
// 重なった割り込み：一つでも走っていれば割り込み中のまま、再開は全部終わってから / overlapping interruptions: still interrupted while any runs; resume only once all are done
const second = U({ name: "Outage", path: "out.md", priority: "urgent", status: "doing", assignees: ["Dana"], start: "2024-09-30", end: "2024-10-30", interrupts: ["cur.md"] });
const overlap = interruptions([{ ...linked, status: "done" }, second, cur], ST, OCT1);
check("overlapping: one urgent task done, another still running: interrupted, no resume", by(overlap.interrupted, "cur.md") === "out.md" && !overlap.resume.has("cur.md"));
const bothDone = interruptions([{ ...linked, status: "done" }, { ...second, status: "done" }, cur], ST, OCT1);
check("overlapping: both done: resume, from both", by(bothDone.resume, "cur.md") === "hot.md,out.md");
const late = U({ path: "late.md", status: "doing", end: "2024-09-01", priority: "urgent" });
check("exception: urgent wins over overdue", exceptionOf(late, ST, OCT1, new Set(), NONE) === "urgent");
check("exceptions: every reason, strongest first",
  exceptionsOf({ ...late, status: "hold", interrupts: undefined, path: "late.md" }, ST, OCT1, new Set(["late.md"]), NONE).join() === "urgent,overdue,blocked,dependency");
check("exception: dependency, then interrupted, then resume",
  exceptionOf(cur, ST, OCT1, new Set(["cur.md"]), ip) === "dependency" && exceptionOf(cur, ST, OCT1, new Set(), ip) === "interrupted"
  && exceptionOf(cur, ST, OCT1, new Set(), after) === "resume");
check("exception: blocked work says so; finished work has none",
  exceptionOf(held, ST, OCT1, new Set(), NONE) === "blocked" && exceptionOf({ ...late, status: "done" }, ST, OCT1, new Set(), NONE) === undefined);
check("attention: blocked, overdue and urgent; finished work needs none",
  attentionOf(held, ST, OCT1).join() === "blocked" && attentionOf(late, ST, OCT1).join() === "overdue,urgent" && attentionOf({ ...late, status: "done" }, ST, OCT1).length === 0 && attentionOf(cur, ST, OCT1).length === 0);
check("attention filter: is blocked/overdue/urgent keeps only those",
  names(applyFilters([U({ name: "calm", path: "c.md", status: "doing" }), { ...held, name: "held" }], [cat("attention", "is", ["blocked", "overdue", "urgent"])], "all", ST, OCT1)) === "held");
const kids = [U({ name: "a", status: "done" }), U({ name: "b", status: "drop" }), U({ name: "c", status: "todo" }), U({ name: "d" })];
const sum = subtaskSummary(kids, ST);
check("subtask summary: done/total without cancelled, next = first outstanding in order", sum.done === 1 && sum.total === 3 && sum.next?.name === "c");
check("subtask summary: no next when all are done", subtaskSummary([kids[0]], ST).next === undefined);
const byName = (a, b) => a.name.localeCompare(b.name);
check("strongest exception wins, none when none", strongest([undefined, "interrupted", "overdue"]) === "overdue" && strongest([undefined]) === undefined);
check("urgent first among siblings; finished urgent work sorts normally",
  [U({ name: "b" }), U({ name: "z", priority: "urgent" }), U({ name: "a", priority: "urgent", status: "done" })].sort(urgentFirst(ST, byName)).map((t) => t.name).join() === "z,a,b");
check("work waiting to be resumed comes right after urgent work",
  [U({ name: "b", path: "b.md" }), U({ name: "r", path: "r.md" }), U({ name: "z", priority: "urgent" })].sort(urgentFirst(ST, byName, new Map([["r.md", hot]]))).map((t) => t.name).join() === "z,r,b");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
