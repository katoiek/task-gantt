// wikilink 解析（parseWikilink / linkLabel / wikilinkQuery / fmText）の検証
// Tests for wikilink parsing (parseWikilink / linkLabel / wikilinkQuery / fmText)
import { parseWikilink, linkLabel, linkTarget, wikilinkQuery, fmText } from "./links.mjs";

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

// ── parseWikilink ──
check("plain text is not a link", parseWikilink("kei") === null);
check("empty link is not a link", parseWikilink("[[]]") === null);
check("text around a link is not a single link", parseWikilink("see [[a]]") === null);
const w = parseWikilink("[[People/田中#Profile|Tanaka]]");
check("linkpath", w?.linkpath === "People/田中");
check("subpath", w?.subpath === "#Profile");
check("alias", w?.alias === "Tanaka");
check("linkTarget keeps the subpath", linkTarget(w) === "People/田中#Profile");
check("surrounding spaces are ignored", parseWikilink("  [[a]] ")?.linkpath === "a");

// ── linkLabel ──
check("label of plain text", linkLabel("kei") === "kei");
check("label uses the alias", linkLabel("[[People/田中|Tanaka]]") === "Tanaka");
check("label falls back to the file name", linkLabel("[[People/田中]]") === "田中");
check("label drops .md", linkLabel("[[People/田中.md]]") === "田中");

// ── wikilinkQuery ──
check("no [[", wikilinkQuery("abc") === null);
check("just opened", JSON.stringify(wikilinkQuery("x [[")) === JSON.stringify({ start: 2, query: "" }));
check("typing a query", wikilinkQuery("x [[foo ba")?.query === "foo ba");
check("closed link", wikilinkQuery("[[a]] b") === null);
check("newline ends it", wikilinkQuery("[[a\nb") === null);
check("alias part ends it", wikilinkQuery("[[a|b") === null);
check("latest [[ wins", wikilinkQuery("[[a]] [[b")?.start === 6);

// ── fmText ──
check("undefined stays undefined", fmText(undefined) === undefined);
check("string passes through", fmText("[[a]]") === "[[a]]");
check("unquoted YAML wikilink is restored", fmText([["田中"]]) === "[[田中]]");
check("numbers become text", fmText(3) === "3");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
