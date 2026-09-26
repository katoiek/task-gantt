// wikilink の解析（Obsidian に依存しない純粋関数。テスト対象）
// wikilink parsing: pure functions with no Obsidian dependency (unit-tested)

export interface Wikilink {
  linkpath: string; // リンク先（# 以降と | 以降を除いた部分）/ the target, without #subpath or |alias
  subpath: string; // "#見出し" など（無ければ空）/ e.g. "#Heading" (empty when absent)
  alias?: string; // "|表示名" の表示名 / the display text after "|"
}

// 値全体が 1 つの wikilink（[[...]]）ならその中身を返す / parse a value that is exactly one wikilink
export function parseWikilink(v: string): Wikilink | null {
  const m = v.trim().match(/^\[\[([^[\]|#]*)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]$/);
  if (!m || !m[1].trim()) return null;
  const alias = m[3]?.trim();
  return { linkpath: m[1].trim(), subpath: m[2] ?? "", alias: alias || undefined };
}

// 表示用の名前。wikilink なら表示名（なければファイル名）、それ以外はそのまま
// the name to show: a wikilink's alias (or its file name), anything else as-is
export function linkLabel(v: string): string {
  const w = parseWikilink(v);
  if (!w) return v;
  if (w.alias) return w.alias;
  const base = w.linkpath.split("/").pop() ?? w.linkpath;
  return base.replace(/\.md$/i, "");
}

// openLinkText に渡すリンクテキスト（linkpath＋subpath）/ the link text handed to openLinkText (linkpath + subpath)
export function linkTarget(w: Wikilink): string {
  return w.linkpath + w.subpath;
}

// カーソル直前が入力途中の wikilink（"[[" の後で "]]"・改行・"|" がまだ無い）なら、
// "[[" の位置と入力済みの検索語を返す
// when the text before the caret ends inside an unfinished wikilink ("[[" with no "]]", newline or "|" after it),
// return where the "[[" starts and the query typed so far
export function wikilinkQuery(before: string): { start: number; query: string } | null {
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const query = before.slice(open + 2);
  if (/\]\]|[\n|[]/.test(query)) return null;
  return { start: open, query };
}

// フロントマターの値を文字列に。引用符なしの `key: [[x]]` は YAML で [["x"]] と読まれるので wikilink に戻す
// a frontmatter value as text. An unquoted `key: [[x]]` parses as the YAML array [["x"]], so turn it back into a wikilink
export function fmText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && typeof v[0][0] === "string") {
    return `[[${v[0][0]}]]`;
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v); // 想定外の型（配列・オブジェクト）はそのまま見える形に / show unexpected shapes verbatim
}
