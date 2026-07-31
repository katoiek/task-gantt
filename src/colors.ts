// 名前から色を決める共通処理。ビュー（タグ/フォルダ/担当者のバー色）と
// 設定画面（タグ色の取り込み）の両方が使うため、循環参照の起きない独立モジュールに置く。
// shared name → color helpers, used by the view (tag/folder/assignee bar colors) and by
// settings (importing tag colors); kept in its own module so neither side forms an import cycle.

// HSL → #rrggbb（カラーピッカーの初期値に hex が要るため）/ HSL → hex (color inputs need hex)
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// 名前から安定した色を生成（担当者/タグ/フォルダ共通・同じ名前は常に同じ色）/ deterministic color from any name
export function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return hslToHex(h, 55, 55);
}

// Obsidian 本体のタグ色（テーマ追従）。テーマが変数を定義していない場合は既定の紫にフォールバック
// Obsidian's own tag color, following the theme; falls back to its default purple if a theme omits it
const OBSIDIAN_TAG_FALLBACK = "#8b6cef";
export function obsidianTagColor(): string {
  const v = getComputedStyle(document.body).getPropertyValue("--tag-color").trim();
  return v || OBSIDIAN_TAG_FALLBACK;
}

// CSS の色表現を #rrggbb へ寄せる（input[type=color] は hex しか受け付けないため）
// coerce a CSS color into #rrggbb (input[type=color] only accepts hex)
export function toHex(css: string): string {
  const v = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return OBSIDIAN_TAG_FALLBACK; // hsl() など変換できない表現 / expressions we can't convert, e.g. hsl()
}

// タグの実効色を決める。優先順位は 個別の色 > タグの既定色 > Obsidian 本体のタグ色。
// 一覧に名前だけ残して色を空にした行は「既定色に従う」を意味する。
// resolve a tag's effective color: per-tag override > configured default > Obsidian's own tag color.
// An entry kept in the list with an empty color means "follow the default".
export function resolveTagColor(overrides: { name: string; color: string }[], defaultColor: string, tag: string): string {
  return overrides.find((c) => c.name === tag)?.color || defaultColor || obsidianTagColor();
}
