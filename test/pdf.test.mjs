// PDF 書き出しとページ分割の検証 / Tests for the PDF writer and page planning
import { buildPdf, planPages, rowsThatFit } from "./pdf.mjs";

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

// ── planPages ──
{
  const j = (x) => JSON.stringify(x);
  check("planPages: 最初のページは行が少ない", j(planPages(10, 3, 4)) === j([{ from: 0, count: 3 }, { from: 3, count: 4 }, { from: 7, count: 3 }]));
  check("planPages: 1 ページに収まる", j(planPages(2, 5, 5)) === j([{ from: 0, count: 2 }]));
  check("planPages: ちょうど割り切れても空のページを作らない", j(planPages(8, 4, 4)) === j([{ from: 0, count: 4 }, { from: 4, count: 4 }]));
  check("planPages: 0 以下の行数は 1 行として扱う（止まらない）", planPages(3, 0, -2).length === 3);
  const all = planPages(37, 6, 9);
  check("planPages: 全行を過不足なく並べる", all.reduce((n, p) => n + p.count, 0) === 37 && all.every((p, i) => i === 0 || p.from === all[i - 1].from + all[i - 1].count));
  check("rowsThatFit: 固定部分を引いて行の高さで割る", rowsThatFit(500, 80, 30) === 14);
  check("rowsThatFit: 入らなくても最低 1 行", rowsThatFit(40, 80, 30) === 1);
}

// ── buildPdf ──
{
  const rgbA = new Uint8Array(4 * 3 * 3).map((_, i) => (i * 7) % 256); // 4x3 の画像 / a 4x3 image
  const rgbB = new Uint8Array(2 * 2 * 3).fill(200);
  const pdf = await buildPdf([
    { pageW: 842, pageH: 595, img: { w: 4, h: 3, rgb: rgbA }, x: 24, y: 24, width: 400.5, height: 300 },
    { pageW: 842, pageH: 595, img: { w: 2, h: 2, rgb: rgbB }, x: 24, y: 24, width: 100, height: 100 },
  ]);
  const latin = new TextDecoder("latin1").decode(pdf);
  check("PDF: ヘッダーと末尾", latin.startsWith("%PDF-1.4\n") && latin.trimEnd().endsWith("%%EOF"));
  check("PDF: ページ数", /\/Type \/Pages \/Kids \[3 0 R 6 0 R\] \/Count 2/.test(latin));
  check("PDF: 用紙の大きさ", (latin.match(/\/MediaBox \[0 0 842 595\]/g) ?? []).length === 2);
  // 画像は左下原点に直す：y=24, 高さ 300 → 下端は 595-24-300=271 / image placed from the bottom-left: 595-24-300 = 271
  check("PDF: 画像の位置（左下原点に変換）", latin.includes("q 400.5 0 0 300 24 271 cm /Im0 Do Q"));

  // 相互参照表：各オブジェクトの位置が実際の "n 0 obj" を指す / every xref offset points at its "n 0 obj"
  const startxref = Number(/startxref\n(\d+)\n/.exec(latin)[1]);
  check("PDF: startxref が xref を指す", latin.slice(startxref, startxref + 4) === "xref");
  const lines = latin.slice(startxref).split("\n");
  const size = Number(lines[1].split(" ")[1]);
  let ok = size === 1 + 2 + 3 * 2;
  for (let n = 1; n < size; n++) {
    const off = Number(lines[2 + n].slice(0, 10));
    ok = ok && latin.slice(off, off + `${n} 0 obj`.length) === `${n} 0 obj`;
  }
  check("PDF: すべてのオブジェクトの位置が正しい", ok);
  check("PDF: trailer の Size と Root", latin.includes(`/Size ${size} /Root 1 0 R`));

  // 画像の中身：圧縮を戻すと元の RGB になる / inflating the image stream gives the original RGB back
  const read = async (n) => {
    const head = latin.indexOf(`${n} 0 obj`);
    const len = Number(/\/Length (\d+)/.exec(latin.slice(head))[1]);
    const start = latin.indexOf("stream\n", head) + "stream\n".length;
    const stream = new Blob([pdf.slice(start, start + len)]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const a = await read(5);
  const b = await read(8);
  check("PDF: 1 枚目の画像が一致", a.length === rgbA.length && a.every((v, i) => v === rgbA[i]));
  check("PDF: 2 枚目の画像が一致", b.length === rgbB.length && b.every((v, i) => v === rgbB[i]));

  let threw = false;
  try {
    await buildPdf([]);
  } catch {
    threw = true;
  }
  check("PDF: ページが無ければ作らない", threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
