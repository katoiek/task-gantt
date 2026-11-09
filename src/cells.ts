// テーブルのセル操作の、Obsidian に依存しない純粋な部分（コピー＆ペーストの文字列、フィル）。画面は view.ts
// the pure part of the table's cell operations (clipboard text, fill); the screen is in view.ts
import type { DateFormat, StatusDef } from "./types";
import { parseDate } from "./timeline";

// ── TSV（タブ区切り）/ TSV (tab-separated) ──
// Excel・Google スプレッドシート・Wrike と貼り合える形。タブ・改行・"" を含む欄は "" で囲み、中の " は "" にする
// the shape Excel, Google Sheets and Wrike exchange: a field with a tab, a newline or a quote is wrapped in "", and a " inside becomes ""
export function toTsv(rows: string[][]): string {
  const field = (s: string): string => (/[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map(field).join("\t")).join("\n");
}

// TSV を行×欄に。"" で囲んだ欄は、中のタブ・改行を欄の一部として読む。末尾の改行（Excel が付ける）は空行にしない
// TSV into rows × fields; a "…" field keeps its tabs and newlines; the trailing newline Excel adds isn't an extra row
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const s = text.replace(/\r\n?/g, "\n");
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === "\t") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
    i++;
  }
  // 最後の行（改行で終わっていなければここで確定）/ the last row, when the text didn't end with a newline
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── セルの値の読み取り / reading a cell's value ──

// 日付（と時刻）の文字。"" = 空にする、null = 読めない。例: "2026/11/02", "2026-11-02 09:30"
// a date (and time) text: "" = clear, null = unreadable. e.g. "2026/11/02", "2026-11-02 09:30"
export function parseDateTimeText(text: string, fmt: DateFormat): { date: string; time?: string } | null {
  const t = text.trim();
  if (t === "") return { date: "" };
  const m = t.match(/^(.*?)(?:[ T]+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const datePart = m[1].trim();
  // ISO（年が先頭の 4 桁）は、表示形式に関わらず読む。それ以外は、設定の表示形式で読む
  // ISO (a leading 4-digit year) is read whatever the display format is; anything else follows the setting
  const iso = /^\d{4}\D\d{1,2}\D\d{1,2}$/.test(datePart) ? parseDate(datePart, "YYYY/MM/DD") : parseDate(datePart, fmt);
  if (!iso) return null;
  if (m[2] === undefined) return { date: iso };
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return null;
  return { date: iso, time: `${String(hh).padStart(2, "0")}:${m[3]}` };
}

// ステータスの文字（名前か ID。大文字小文字は無視）。"" = 外す、null = 知らない名前
// a status text (label or id, case-insensitive): "" = clear, null = unknown
export function statusIdFromText(text: string, statuses: StatusDef[]): string | null {
  const t = text.trim();
  if (t === "") return "";
  const low = t.toLowerCase();
  const hit = statuses.find((s) => s.label.toLowerCase() === low) ?? statuses.find((s) => s.id.toLowerCase() === low);
  return hit ? hit.id : null;
}

// タグの文字（カンマ・読点・改行区切り。# は外し、重複は 1 つに）/ a tags text (comma-, 、- or newline-separated; # dropped, duplicates merged)
export function tagsFromText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,、\n]/)) {
    const tag = raw.replace(/^\s*#/, "").trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

// 進捗の文字（"60"、"60%"）。数値でなければ null、空は ""。0〜100 に収める
// a progress text ("60", "60%"): null when not a number, "" when blank; clamped to 0–100
export function progressFromText(text: string): number | "" | null {
  const t = text.trim().replace(/%$/, "").trim();
  if (t === "") return "";
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── フィル / fill ──

// 選んだ n 行を繰り返すとき、選択の先頭から k 行ずれた行（負なら上）に入れる元の行の番号
// when repeating the n selected rows, the index of the source row for the row k rows from the selection's start (negative = above)
export function fillSourceIndex(k: number, n: number): number {
  return ((k % n) + n) % n;
}

// ── 範囲の集計 / range summary ──
export interface CellSummary {
  count: number; // 空でないセルの数 / non-empty cells
  kind: "number" | "date" | "text"; // すべて数値、すべて日付、それ以外 / all numbers, all dates, anything else
  min?: number | string; // number: 数値、date: ISO / a number, or an ISO date
  max?: number | string;
  sum?: number;
}

// 選んだセルの文字から、件数・最小・最大・合計をつくる。空のセルは数えない。数値と日付は、全部がそうであるときだけ
// count, min, max and sum from the selected cells' texts; blanks don't count; numbers and dates only when every value is one
export function summarizeCells(values: string[], fmt: DateFormat): CellSummary {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  const count = filled.length;
  if (!count) return { count, kind: "text" };
  const nums = filled.map((v) => (/^-?\d+(\.\d+)?%?$/.test(v) ? Number(v.replace("%", "")) : NaN));
  if (nums.every((n) => !Number.isNaN(n))) return { count, kind: "number", min: Math.min(...nums), max: Math.max(...nums), sum: nums.reduce((a, b) => a + b, 0) };
  const dates = filled.map((v) => parseDateTimeText(v, fmt)?.date ?? "");
  if (dates.every((d) => d !== "")) {
    const sorted = [...dates].sort();
    return { count, kind: "date", min: sorted[0], max: sorted[sorted.length - 1] };
  }
  return { count, kind: "text" };
}

// ── CSV ──
// 1 つの欄を CSV 用に。カンマ・引用符・改行を含めば "" で囲む。Excel が数式として実行しうる先頭（= + @、- の後ろが数字でない）には ' を足す
// one field for CSV: wrapped in "" when it has a comma, a quote or a newline; a leading = + @ (or a - not followed by a digit), which Excel could run as a formula, gets a ' in front
export function csvField(value: string): string {
  const safe = /^[=+@\t\r]/.test(value) || /^-[^\d.]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// 行×欄を CSV に。改行は CRLF（Excel の既定）。先頭の BOM は、書き込む側で付ける
// rows × fields as CSV, with CRLF line ends (Excel's default); the BOM is added by whoever writes the file
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}
