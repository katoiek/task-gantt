// ボードの PNG / PDF 書き出し：画面にある表とタイムラインの DOM を写し取って画像にする
// exporting the board as PNG or PDF: the table and timeline already in the DOM are copied into an image

import { buildPdf, planPages, rowsThatFit } from "./pdf";

export type ExportFormat = "png" | "pdf";
// chart = タイムラインだけ、table = 表とタイムライン / chart = the timeline only, table = the table and the timeline
export type ExportScope = "chart" | "table";

export interface BoardExportInput {
  grid: HTMLElement; // 画面の .ogantt-grid / the on-screen .ogantt-grid
  scope: ExportScope;
  chartW: number; // タイムラインの幅（px）/ timeline width in px
  tableW: number; // 表の幅（px）/ table width in px
  rows: number;
  rowH: number;
  headH: number;
  title: string;
  maxPixels: number; // キャンバスの面積の上限（スマホは小さい）/ canvas area cap (smaller on phones)
}

// 画像の中では Web フォントが使えないので、どの環境にもあるフォントで描く（日本語も含む）
// web fonts aren't available inside an image, so draw with fonts every system has (Japanese included)
export const EXPORT_FONT = '-apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP", "Noto Sans", sans-serif';

const PAD = 16; // 画像の余白 / the image's margin
const TITLE_H = 36; // 表題の高さ / the title band
const MAX_SIDE = 16384; // キャンバスの一辺の上限 / the canvas side limit
const XHTML = "http://www.w3.org/1999/xhtml";
// A4 横（pt）と余白 / A4 landscape in points, and its margin
const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 24;

// 画像に埋め込む CSS：このプラグインのルール（と、アイコン用の .svg-icon）、そこで使う CSS 変数の今の値（テーマの色）
// the CSS embedded in the image: this plugin's rules (and .svg-icon for the icons) plus the current values of the CSS variables they use (the theme's colours)
function exportCss(grid: HTMLElement, extra: string): { css: string; vars: string } {
  const doc = grid.ownerDocument;
  const rules: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      for (const r of Array.from(sheet.cssRules)) {
        const sel = (r as Partial<CSSStyleRule>).selectorText;
        if (sel && (sel.includes(".ogantt-") || sel.includes(".svg-icon"))) rules.push(r.cssText);
      }
    } catch {
      // 読めない（別オリジンの）シートは飛ばす / skip a sheet that can't be read (another origin)
    }
  }
  const css = rules.join("\n") + "\n" + extra;
  const win = doc.defaultView ?? window;
  const cs = win.getComputedStyle(grid);
  const names = new Set<string>(css.match(/--[\w-]+/g) ?? []);
  for (const m of grid.outerHTML.match(/var\((--[\w-]+)/g) ?? []) names.add(m.slice(4));
  names.add("--background-primary").add("--text-normal");
  const vars = [...names]
    .map((n) => {
      const v = cs.getPropertyValue(n).trim();
      return v ? `${n}:${v};` : "";
    })
    .join("");
  return { css, vars };
}

// 画面の grid を書き出し用に整えた複製 / the on-screen grid copied and tidied for export
function prepareClone(inp: BoardExportInput): HTMLElement {
  const clone = inp.grid.cloneNode(true) as HTMLElement;
  // 操作用のもの（依存を作るハンドル・列幅のつまみ）と、選択・ホバーの強調は絵に要らない
  // controls (link handles, column grips) and selection/hover highlights don't belong in a picture
  clone.querySelectorAll(".ogantt-handles-layer, .ogantt-col-grip").forEach((el) => el.remove());
  for (const cls of ["is-selected", "is-dragging", "is-drop-target", "is-link-target", "is-visible"]) {
    clone.querySelectorAll("." + cls).forEach((el) => el.classList.remove(cls));
  }
  if (inp.scope === "chart") {
    clone.querySelector(".ogantt-corner")?.remove();
    clone.querySelector(".ogantt-tbody")?.remove();
    clone.classList.add("ogantt-x-chart");
    clone.style.gridTemplateColumns = `${inp.chartW}px`;
  }
  return clone;
}

// 書き出し全体の画像（表題＋ボード）。論理サイズは (幅+余白×2) × (表題+高さ+余白×2)、scale 倍の解像度
// the whole image (title + board); logical size is (width + 2 margins) × (title + height + 2 margins), drawn at `scale`
async function renderBoardCanvas(inp: BoardExportInput): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  const doc = inp.grid.ownerDocument;
  const win = doc.defaultView ?? window;
  const cs = win.getComputedStyle(inp.grid);
  const W = inp.scope === "chart" ? inp.chartW : inp.tableW + inp.chartW;
  const H = inp.headH + inp.rows * inp.rowH;
  const totalW = W + PAD * 2;
  const totalH = PAD + TITLE_H + H + PAD;
  const scale = Math.min(2, MAX_SIDE / totalW, MAX_SIDE / totalH, Math.sqrt(inp.maxPixels / (totalW * totalH)));

  // 位置指定（sticky）は複製の中では要らない。ticks は軸を基準に置かれるので relative にする
  // sticky isn't needed in the copy; the ticks are placed against the axis, so keep those positioned (relative)
  const boxSizing = cs.boxSizing || "border-box";
  const { css, vars } = exportCss(
    inp.grid,
    [
      `*, *::before, *::after { box-sizing: ${boxSizing}; }`,
      ".ogantt-corner, .ogantt-tbody, .ogantt-axis { position: relative !important; top: auto !important; left: auto !important; }",
      ".ogantt-x-chart .ogantt-axis, .ogantt-x-chart .ogantt-svgwrap { grid-column: 1 !important; }",
    ].join("\n")
  );

  const wrap = doc.createElementNS(XHTML, "div");
  wrap.setAttribute(
    "style",
    `width:${W}px;height:${H}px;overflow:hidden;background:var(--background-primary);color:var(--text-normal);` +
      `font-family:${EXPORT_FONT};font-size:${cs.fontSize};line-height:${cs.lineHeight};${vars}`
  );
  const style = doc.createElementNS(XHTML, "style");
  style.textContent = css;
  wrap.appendChild(style);
  wrap.appendChild(prepareClone(inp));

  // XML として不正な制御文字（ファイル名などに紛れ込みうる。タブ・改行は有効）は画像の読み込みを壊すので除く
  // XML-invalid control characters (possible in file names; tab and newlines are valid) would break the image, so drop them
  const inner = new XMLSerializer().serializeToString(wrap).replace(/[\p{Cc}\uFFFE\uFFFF]/gu, (c) => ("\t\n\r".includes(c) ? c : ""));
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${inner}</foreignObject></svg>`;
  // blob: の URL だと、読み込んだ画像でキャンバスが「汚染」され（読み出し禁止）PNG にできない。data: の URL なら汚染されない
  // a blob: URL makes the loaded image taint the canvas (no read-back, so no PNG); a data: URL doesn't
  const url = await readDataUrl(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const canvas = createEl("canvas");
  try {
    const img = new win.Image();
    img.src = url;
    await img.decode();
    canvas.width = Math.round(totalW * scale);
    canvas.height = Math.round(totalH * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2D canvas");
    ctx.fillStyle = cs.getPropertyValue("--background-primary").trim() || "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = cs.getPropertyValue("--text-normal").trim() || "#000000";
    ctx.font = `600 ${15 * scale}px ${EXPORT_FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText(inp.title, PAD * scale, (PAD + TITLE_H / 2) * scale);
    // SVG 画像は描く大きさで描き直されるので、拡大しても文字や線がにじまない / an SVG image is re-rasterised at the drawn size, so text and lines stay sharp when scaled
    ctx.drawImage(img, PAD * scale, (PAD + TITLE_H) * scale, W * scale, H * scale);
    return { canvas, scale };
  } catch (e) {
    canvas.width = canvas.height = 0;
    throw e;
  }
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? ok(reader.result) : fail(new Error("could not read the image")));
    reader.onerror = () => fail(new Error(reader.error?.message ?? "could not read the image"));
    reader.readAsDataURL(blob);
  });
}

export async function boardToPng(inp: BoardExportInput): Promise<Uint8Array> {
  const { canvas } = await renderBoardCanvas(inp);
  try {
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    if (!blob) throw new Error("the canvas gave no PNG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = canvas.height = 0; // 大きなキャンバスのメモリをすぐ手放す / release the big canvas right away
  }
}

// A4 横に幅をそろえて並べ、縦に長ければ行の境目でページを分ける。2 ページ目からも日付軸（と表の見出し）を付ける
// fit the width to an A4 landscape page and split a tall board between rows; the date axis (and table header) repeats on every page
export async function boardToPdf(inp: BoardExportInput): Promise<Uint8Array> {
  const { canvas: src, scale } = await renderBoardCanvas(inp);
  const page = createEl("canvas");
  try {
    const srcW = src.width;
    // 1 canvas px あたりの pt。小さな板は 100%（1 CSS px = 0.75pt）より大きくしない / points per canvas px; a small board isn't enlarged past 100% (1 CSS px = 0.75pt)
    const k = Math.min((PAGE_W - MARGIN * 2) / srcW, 0.75 / scale);
    const availPx = (PAGE_H - MARGIN * 2) / k;
    const rowPx = inp.rowH * scale;
    const titleBand = Math.round((PAD + TITLE_H) * scale);
    const headBand = Math.round(inp.headH * scale);
    const plan = planPages(inp.rows, rowsThatFit(availPx, titleBand + headBand, rowPx), rowsThatFit(availPx, headBand, rowPx));
    const pages = [];
    for (let i = 0; i < plan.length; i++) {
      const { from, count } = plan[i];
      const first = i === 0;
      const sy = Math.round(titleBand + headBand + from * rowPx);
      const sh = Math.min(Math.round(count * rowPx), src.height - sy);
      const w = srcW;
      const h = (first ? titleBand : 0) + headBand + sh;
      page.width = w;
      page.height = h;
      const ctx = page.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2D canvas");
      // 1 ページ目は表題＋見出し、以降は見出しだけ / the first page gets the title and header, the rest just the header
      if (first) ctx.drawImage(src, 0, 0, w, titleBand + headBand, 0, 0, w, titleBand + headBand);
      else ctx.drawImage(src, 0, titleBand, w, headBand, 0, 0, w, headBand);
      ctx.drawImage(src, 0, sy, w, sh, 0, h - sh, w, sh);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const rgb = new Uint8Array(w * h * 3);
      for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
        rgb[q] = rgba[p];
        rgb[q + 1] = rgba[p + 1];
        rgb[q + 2] = rgba[p + 2];
      }
      pages.push({ pageW: PAGE_W, pageH: PAGE_H, img: { w, h, rgb }, x: MARGIN, y: MARGIN, width: w * k, height: h * k });
    }
    return await buildPdf(pages);
  } finally {
    src.width = src.height = 0;
    page.width = page.height = 0;
  }
}
