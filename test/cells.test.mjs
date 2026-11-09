// テーブルのセル操作（TSV・日付・ステータス・タグ・進捗・フィル）の検証 / Tests for the table's cell operations (TSV, dates, status, tags, progress, fill)
import { toTsv, parseTsv, parseDateTimeText, statusIdFromText, tagsFromText, progressFromText, fillSourceIndex, summarizeCells, csvField, toCsv } from "./cells.mjs";

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
const j = (x) => JSON.stringify(x);

// ── TSV ──
check("toTsv: タブと改行でつなぐ", toTsv([["a", "b"], ["c", "d"]]) === "a\tb\nc\td");
check("toTsv: タブ・改行・引用符を含む欄は囲む", toTsv([['x\ty', 'say "hi"', "l1\nl2"]]) === '"x\ty"\t"say ""hi"""\t"l1\nl2"');
check("parseTsv: 行×欄に分ける", j(parseTsv("a\tb\nc\td")) === j([["a", "b"], ["c", "d"]]));
check("parseTsv: 末尾の改行は空行にしない（Excel）", j(parseTsv("a\tb\n")) === j([["a", "b"]]));
check("parseTsv: CRLF も読む", j(parseTsv("a\tb\r\nc\td\r\n")) === j([["a", "b"], ["c", "d"]]));
check("parseTsv: 囲んだ欄の中のタブ・改行・引用符", j(parseTsv('"x\ty"\t"say ""hi"""\t"l1\nl2"')) === j([["x\ty", 'say "hi"', "l1\nl2"]]));
check("parseTsv: 空の欄を保つ", j(parseTsv("a\t\tc")) === j([["a", "", "c"]]));
check("parseTsv: 1 つの値", j(parseTsv("hello")) === j([["hello"]]));
check("parseTsv: 空文字は空", parseTsv("").length === 0);
check("TSV: 往復して同じになる", (() => {
  const rows = [["a", 'b"c', "d\te"], ["", "x\ny", "z"]];
  return j(parseTsv(toTsv(rows))) === j(rows);
})());

// ── 日付 ──
check("parseDateTimeText: 設定の形式", j(parseDateTimeText("2026/11/02", "YYYY/MM/DD")) === j({ date: "2026-11-02" }) && j(parseDateTimeText("02/11/2026", "DD/MM/YYYY")) === j({ date: "2026-11-02" }) && j(parseDateTimeText("11/02/2026", "MM/DD/YYYY")) === j({ date: "2026-11-02" }));
check("parseDateTimeText: ISO は、表示形式に関わらず読む", j(parseDateTimeText("2026-11-02", "DD/MM/YYYY")) === j({ date: "2026-11-02" }));
check("parseDateTimeText: 時刻つき", j(parseDateTimeText("2026/11/02 09:30", "YYYY/MM/DD")) === j({ date: "2026-11-02", time: "09:30" }) && j(parseDateTimeText("2026-11-02T9:05", "YYYY/MM/DD")) === j({ date: "2026-11-02", time: "09:05" }));
check("parseDateTimeText: 空は、空にする", j(parseDateTimeText("  ", "YYYY/MM/DD")) === j({ date: "" }));
check("parseDateTimeText: 読めないものは null", parseDateTimeText("abc", "YYYY/MM/DD") === null && parseDateTimeText("2026/13/40", "YYYY/MM/DD") === null && parseDateTimeText("2026/11/02 25:00", "YYYY/MM/DD") === null && parseDateTimeText("2026/02/30", "YYYY/MM/DD") === null);

// ── ステータス ──
const ST = [{ id: "todo", label: "To do", color: "#999", group: "active" }, { id: "done", label: "Done", color: "#3c6", group: "completed" }];
check("statusIdFromText: 名前でも ID でも（大文字小文字は無視）", statusIdFromText("done", ST) === "done" && statusIdFromText("TO DO", ST) === "todo" && statusIdFromText("To do", ST) === "todo");
check("statusIdFromText: 空は外す、知らない名前は null", statusIdFromText("", ST) === "" && statusIdFromText("ghost", ST) === null);

// ── タグ・進捗 ──
check("tagsFromText: カンマ・読点・改行で分け、# を外し、重複を 1 つに", j(tagsFromText("#a, b、c\nb")) === j(["a", "b", "c"]));
check("tagsFromText: 空は空", tagsFromText("  ").length === 0);
check("progressFromText: 数値・%・範囲", progressFromText("60") === 60 && progressFromText("60%") === 60 && progressFromText("150") === 100 && progressFromText("-5") === 0 && progressFromText("33.6") === 34);
check("progressFromText: 空は ''、数値でなければ null", progressFromText("") === "" && progressFromText("abc") === null);

// ── フィル ──
check("fillSourceIndex: 下へ繰り返す", [0, 1, 2, 3, 4].map((k) => fillSourceIndex(k, 2)).join() === "0,1,0,1,0");
check("fillSourceIndex: 上へ繰り返す（負）", [-1, -2, -3].map((k) => fillSourceIndex(k, 2)).join() === "1,0,1" && fillSourceIndex(-1, 1) === 0);

// ── 範囲の集計 ──
{
  const n = summarizeCells(["10", "20%", "", "5.5"], "YYYY/MM/DD");
  check("summarizeCells: 数値は、件数・合計・最小・最大（空は数えない・% は外す）", n.kind === "number" && n.count === 3 && n.sum === 35.5 && n.min === 5.5 && n.max === 20);
  const d = summarizeCells(["2026/11/20", "2026/11/02 09:30", "2026/12/01"], "YYYY/MM/DD");
  check("summarizeCells: 日付は、最小・最大（時刻は無視）", d.kind === "date" && d.count === 3 && d.min === "2026-11-02" && d.max === "2026-12-01");
  const t = summarizeCells(["a", "10", ""], "YYYY/MM/DD");
  check("summarizeCells: 混ざっていれば、件数だけ", t.kind === "text" && t.count === 2 && t.min === undefined);
  check("summarizeCells: すべて空なら、件数 0", summarizeCells(["", " "], "YYYY/MM/DD").count === 0);
  check("summarizeCells: 負の数・日付形式（日/月/年）", summarizeCells(["-3", "4"], "YYYY/MM/DD").min === -3 && summarizeCells(["02/11/2026", "01/12/2026"], "DD/MM/YYYY").max === "2026-12-01");
}

// ── CSV ──
{
  check("csvField: ふつうの文字はそのまま", csvField("Task 1") === "Task 1" && csvField("") === "" && csvField("2026/11/02") === "2026/11/02");
  check("csvField: カンマ・引用符・改行を含めば囲む", csvField("a,b") === '"a,b"' && csvField('say "hi"') === '"say ""hi"""' && csvField("l1\nl2") === '"l1\nl2"');
  check("csvField: 数式になりうる先頭には ' を足す", csvField("=1+1") === "'=1+1" && csvField("+cmd") === "'+cmd" && csvField("@x") === "'@x" && csvField("-x") === "'-x");
  check("csvField: 負の数は、そのまま", csvField("-3") === "-3" && csvField("-0.5") === "-0.5");
  check("csvField: 数式の先頭に、カンマも含むとき", csvField("=a,b") === `"'=a,b"`);
  check("toCsv: CRLF で、末尾にも改行", toCsv([["名前", "期限"], ["タスク,1", "2026/11/02"]]) === '名前,期限\r\n"タスク,1",2026/11/02\r\n');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
