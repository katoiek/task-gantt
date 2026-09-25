// フィルタ判定（matchFilter / applyFilters）とグループ再マッピング（regroup）の検証
// Tests for filter matching (matchFilter / applyFilters) and group remapping (regroup)
import { matchFilter, applyFilters, regroup } from "./filter.mjs";

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
const task = (o) => ({ path: `${o.name}.md`, groups: ["Proj"], deps: [], milestone: false, tags: [], ...o });
const STATUSES = [
  { id: "todo", label: "To do", color: "#888", group: "active" },
  { id: "done", label: "Done", color: "#0a0", group: "completed" },
  { id: "drop", label: "Dropped", color: "#a00", group: "cancelled" },
];
const TODAY = 20000; // 任意の通日番号 / an arbitrary day index
const names = (list) => list.map((t) => t.name).join(",");

const A = task({ name: "Alpha Plan", status: "todo", assignee: "kei", tags: ["work", "urgent"] });
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

// ── regroup ──
const groupsOf = (list) => list.map((t) => `${t.name}:${t.groups[0]}`).join(",");
check("folder grouping is untouched", regroup(ALL, "folder", false, STATUSES, "(none)") === ALL);
check("flat skips remapping", regroup(ALL, "tag", true, STATUSES, "(none)") === ALL);
check("tag grouping duplicates multi-tag tasks",
  groupsOf(regroup(ALL, "tag", false, STATUSES, "(none)")) === "Alpha Plan:work,Alpha Plan:urgent,Beta:work,gamma:(none),Delta:(none)");
check("status grouping uses labels, raw id for unknown, none for unset",
  groupsOf(regroup(ALL, "status", false, STATUSES, "(none)")) === "Alpha Plan:To do,Beta:Done,gamma:ghost,Delta:(none)");
check("assignee grouping", groupsOf(regroup(ALL, "assignee", false, STATUSES, "(none)")) === "Alpha Plan:kei,Beta:(none),gamma:(none),Delta:(none)");
check("regroup doesn't mutate the input", A.groups[0] === "Proj");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
