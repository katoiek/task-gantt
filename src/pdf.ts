// 最小の PDF 書き出し：画像（RGB）を 1 ページに 1 枚置く。外部ライブラリなし
// a minimal PDF writer: one RGB image per page, no external library

export interface PdfPage {
  pageW: number; // 用紙の幅（pt）/ page width in points
  pageH: number; // 用紙の高さ（pt）/ page height in points
  img: { w: number; h: number; rgb: Uint8Array }; // 8 bit RGB（行ごとに詰める）/ 8-bit RGB, rows packed
  x: number; // 画像の左上（pt、用紙の左上が原点）/ top-left of the image (pt, origin at the page's top-left)
  y: number;
  width: number; // 画像を置く大きさ（pt）/ placed size (pt)
  height: number;
}

const enc = new TextEncoder();

// zlib 形式（PDF の FlateDecode がそのまま読める）で圧縮 / compress in zlib format (what PDF's FlateDecode reads as is)
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 数値を PDF 用の文字列に（指数表記にしない）/ a number as PDF text (never exponent notation)
const num = (n: number): string => (Math.round(n * 1000) / 1000).toString();

export async function buildPdf(pages: PdfPage[]): Promise<Uint8Array> {
  if (!pages.length) throw new Error("no pages");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = []; // オブジェクト番号 n（1 始まり）の位置は offsets[n - 1] / object n (1-based) sits at offsets[n - 1]
  let size = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    size += b.length;
  };
  const text = (s: string): void => push(enc.encode(s));
  const begin = (n: number): void => {
    offsets[n - 1] = size;
    text(`${n} 0 obj\n`);
  };

  // 先頭行の次に非 ASCII のコメントを置くと、PDF をバイナリとして扱ってもらえる / a non-ASCII comment marks the file as binary
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "%PDF-1.4\n%âãÏÓ\n"

  // 1: Catalog、2: Pages、以降はページごとに Page・内容・画像の 3 つ / 1: Catalog, 2: Pages, then Page, content and image for each page
  begin(1);
  text("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  text(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pageN = 3 + i * 3;
    const contentN = pageN + 1;
    const imageN = pageN + 2;
    const top = p.pageH - p.y - p.height; // PDF の原点は左下 / PDF's origin is the bottom-left
    const content = enc.encode(`q ${num(p.width)} 0 0 ${num(p.height)} ${num(p.x)} ${num(top)} cm /Im0 Do Q`);
    begin(pageN);
    text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.pageW)} ${num(p.pageH)}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>\nendobj\n`);
    begin(contentN);
    text(`<< /Length ${content.length} >>\nstream\n`);
    push(content);
    text("\nendstream\nendobj\n");
    const packed = await deflate(p.img.rgb);
    begin(imageN);
    text(`<< /Type /XObject /Subtype /Image /Width ${p.img.w} /Height ${p.img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`);
    push(packed);
    text("\nendstream\nendobj\n");
  }

  // 相互参照表と末尾 / the cross-reference table and trailer
  const xref = size;
  const count = offsets.length + 1;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const o of offsets) table += `${String(o).padStart(10, "0")} 00000 n \n`;
  text(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// 行を何ページに分けるか。最初のページは表題の分だけ入る行が少ない。行の途中では切らない
// how rows split across pages; the first page fits fewer rows (it carries the title). A row is never cut in two
export function planPages(totalRows: number, rowsFirst: number, rowsRest: number): { from: number; count: number }[] {
  const first = Math.max(1, Math.floor(rowsFirst));
  const rest = Math.max(1, Math.floor(rowsRest));
  const out: { from: number; count: number }[] = [];
  let from = 0;
  do {
    const count = Math.min(out.length ? rest : first, totalRows - from);
    out.push({ from, count });
    from += count;
  } while (from < totalRows);
  return out;
}

// 1 ページに入る行数 = (使える高さ − 固定の部分) ÷ 行の高さ（最低 1 行）/ rows per page = (usable height − fixed parts) ÷ row height (at least 1)
export function rowsThatFit(usable: number, fixed: number, rowH: number): number {
  return Math.max(1, Math.floor((usable - fixed) / rowH));
}
