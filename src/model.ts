import { App, CachedMetadata, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import { GanttSettings } from "./settings";
import { fmList, fmText, isBareLink, linkLabel } from "./links";
import { PALETTE } from "./colors";
import { fixedOffset } from "./timeline";
import { Task, TaskKind, Row, Dep, DepType, StatusDef, StatusGroup, CustomField, CustomFieldType, CustomValue } from "./types";

// ── ステータスグループ / status groups ──
// 移行用の推測に使うキーワード（id・ラベルを小文字化して部分一致）。上から順に評価し、
// どれにも当たらなければ active。日英に加えて日常的に使う和語も見る。
// keywords for the migration guess (substring match on lowercased id + label), evaluated in
// order; anything unmatched lands in active. Japanese wording is included alongside English.
const GROUP_HINTS: [StatusGroup, string[]][] = [
  ["completed", ["done", "complete", "closed", "finish", "resolved", "完了", "済", "終了"]],
  ["cancelled", ["cancel", "reject", "dropped", "abandon", "中止", "キャンセル", "却下", "取り消", "取消"]],
  ["deferred", ["defer", "hold", "pending", "paused", "block", "waiting", "保留", "延期", "待ち", "中断"]],
];

// 既存設定（group を持たない）から所属グループを推測する / guess a group for a pre-upgrade status
export function inferStatusGroup(id: string, label: string): StatusGroup {
  const hay = `${id} ${label}`.toLowerCase();
  for (const [group, words] of GROUP_HINTS) {
    if (words.some((w) => hay.includes(w))) return group;
  }
  return "active";
}

// タスクのステータスが属するグループ。未設定・設定に無い id は undefined（＝分類不能）で、
// 完了扱いにはしない：分類できないものを完了に寄せると完了フィルタが嘘をつく
// the group a task's status belongs to; unset or unknown ids yield undefined rather than being
// folded into "completed" — guessing there would make the completed filter lie
export function statusGroupOf(statuses: StatusDef[], status?: string): StatusGroup | undefined {
  if (!status) return undefined;
  return statuses.find((s) => s.id === status)?.group;
}

// Custom field の不備（列にしない理由）/ why a custom field can't become a column
export type CustomFieldIssue = "empty" | "reserved" | "duplicate";

// 各 Custom field の不備を調べる。キーが空、組み込みキー（開始・期限などの設定キーと tags）と同じ、
// または先に同じキーのフィールドがある場合は列にしない
// check each custom field: an empty key, a key the plugin already reads (the configured built-in keys and
// `tags`), or a key an earlier field already uses keeps it from becoming a column
export function customFieldIssues(settings: GanttSettings): Map<string, CustomFieldIssue> {
  const reserved = new Set([...Object.values(settings.keys), "tags"]);
  const seen = new Set<string>();
  const out = new Map<string, CustomFieldIssue>();
  for (const f of settings.customFields ?? []) {
    const key = f.key.trim();
    if (!key) out.set(f.id, "empty");
    else if (reserved.has(key)) out.set(f.id, "reserved");
    else if (seen.has(key)) out.set(f.id, "duplicate");
    seen.add(key);
  }
  return out;
}

// 列にできる Custom field（定義順）/ the custom fields that can be columns, in definition order
export function validCustomFields(settings: GanttSettings): CustomField[] {
  const issues = customFieldIssues(settings);
  return (settings.customFields ?? []).filter((f) => !issues.has(f.id));
}

// フロントマターの生の値を Custom field の型に合わせて読む。読めない・空は undefined
// read a raw frontmatter value as the field's type; unreadable or empty gives undefined
export function readCustomValue(raw: unknown, type: CustomFieldType, tz: string): CustomValue | undefined {
  if (raw == null || raw === "") return undefined;
  if (type === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === "date") return parseStored(raw, tz)?.date; // 日付部分のみ / the date part only
  if (Array.isArray(raw)) {
    const list = (raw as unknown[]).filter((x) => x != null && x !== "").map((x) => String(x));
    return list.length ? list : undefined;
  }
  return String(raw);
}

// 表示用の文字列（リストはカンマ区切り）/ display text (a list is comma-joined)
export function customValueText(v: CustomValue | undefined): string {
  if (v == null) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

// 入力欄の文字列を書き込む値へ。空は削除（undefined）。text は元がリストならカンマで区切ってリストに戻す。
// number で数値にならない入力は null（＝書き込まない）
// turn an input string into the value to write: blank deletes (undefined); a text field that held a list is split
// back into a list on commas; a number field given a non-number yields null (= don't write)
export function parseCustomInput(input: string, type: CustomFieldType, wasList: boolean): CustomValue | undefined | null {
  const v = input.trim();
  if (v === "") return undefined;
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "text" && wasList) {
    const list = v.split(",").map((x) => x.trim()).filter((x) => x !== "");
    return list.length ? list : undefined;
  }
  return v;
}

// そのキーをフロントマターに持つノート（Vault 全体）/ notes whose frontmatter has the key (whole vault)
export function filesWithFrontmatterKey(app: App, key: string): TFile[] {
  if (!key) return [];
  return app.vault.getMarkdownFiles().filter((f) => {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    return !!fm && Object.prototype.hasOwnProperty.call(fm, key);
  });
}

// フロントマターのキー名を変える（Custom field のキー変更に合わせてノート側も移す）。
// 新しいキーに既に値があるノートは上書きせずに飛ばす
// rename a frontmatter key (moves notes along with a custom field's key change); a note that already
// has a value under the new key is skipped rather than overwritten
export async function renameFrontmatterKey(
  app: App,
  files: TFile[],
  oldKey: string,
  newKey: string
): Promise<{ renamed: number; skipped: number }> {
  let renamed = 0;
  let skipped = 0;
  for (const file of files) {
    await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      if (!Object.prototype.hasOwnProperty.call(fm, oldKey)) return;
      const cur = fm[newKey];
      if (cur != null && cur !== "") {
        skipped++;
        return;
      }
      fm[newKey] = fm[oldKey];
      delete fm[oldKey];
      renamed++;
    });
  }
  return { renamed, skipped };
}

// after の生エントリから型と リンクを分離 / split a raw `after` entry into type + link
function parseDepRaw(raw: string): { type: DepType; link: string } {
  const m = raw.match(/^\s*(FS|SS|FF)\s*:\s*(.*)$/i);
  if (m) return { type: m[1].toUpperCase() as DepType, link: m[2].trim() };
  return { type: "FS", link: raw.trim() };
}

// after エントリから型プレフィックス(FS:/SS:/FF:)を除いてリンク部だけ取り出す / strip the type prefix, keep the link
function stripDepType(raw: unknown): string {
  return String(raw).replace(/^\s*(FS|SS|FF)\s*:\s*/i, "");
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// 設定タイムゾーンのオフセット（分）。"system" は端末のその時点のオフセット（DST考慮）
// configured timezone offset in minutes; "system" = device offset at that instant (DST-aware)
function offsetMinutes(tz: string, instantMs: number): number {
  return fixedOffset(tz) ?? -new Date(instantMs).getTimezoneOffset();
}

// 壁時計（日付＋時刻）でのオフセット（分）。"system" はその日時の端末のオフセット（DST考慮）
// the offset (minutes) at a wall-clock date + time; "system" = the device's offset at that wall time (DST-aware)
function wallOffset(tz: string, date: string, time: string): number {
  return fixedOffset(tz) ?? -new Date(`${date}T${time}`).getTimezoneOffset();
}

// 分オフセットを "+09:00" 形式へ / minutes to a "+09:00" suffix
function offsetSuffix(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// 保存値を表示用の日付＋時刻へ。オフセット付き（+09:00 / Z）は設定タイムゾーンへ換算、
// naive（オフセット無し）はそのまま、日付として読めない値（例: "未定"）は undefined
// parse a stored value into display date + time: zoned values convert to the configured tz,
// naive values pass through, non-date values (e.g. "未定") become undefined
export function parseStored(v: unknown, tz: string): { date: string; time?: string } | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) v = v.toISOString();
  const m = String(v)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return undefined;
  const [, date, h, mi, zone] = m;
  if (h == null) return { date };
  const hh = +h;
  const mm = +mi;
  if (hh > 23 || mm > 59) return { date }; // 不正な時刻は日付のみ扱い / invalid time → date only
  if (!zone) return { date, time: `${pad2(hh)}:${pad2(mm)}` };
  const zu = zone.toUpperCase();
  const zMin = zu === "Z" ? 0 : (zu[0] === "-" ? -1 : 1) * (+zu.slice(1, 3) * 60 + +zu.replace(":", "").slice(-2));
  const [y, mo, d] = date.split("-").map(Number);
  const instant = Date.UTC(y, mo - 1, d, hh, mm) - zMin * 60000;
  const disp = new Date(instant + offsetMinutes(tz, instant) * 60000).toISOString();
  return { date: disp.slice(0, 10), time: disp.slice(11, 16) };
}

// 設定タイムゾーンの壁時計（日付＋時刻）を絶対時刻(ms)へ。通知トリガーの計算に使う
// wall-clock date + time in the configured tz → absolute epoch ms (used for notification triggers)
export function toInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  return naive - wallOffset(tz, date, time) * 60000;
}

// 表示用の日付＋時刻を保存形式へ（時刻があれば設定タイムゾーンのオフセットを付与）
// combine display date + time into the stored value (a time gets the configured tz offset appended)
export function combineDateTime(date: string | undefined, time: string | undefined, tz: string): string | undefined {
  if (!date) return undefined;
  if (!time) return date;
  return `${date}T${time}${offsetSuffix(wallOffset(tz, date, time))}`;
}

// フロントマターの tags 値を文字列配列へ正規化（配列/カンマ/空白区切り・# 抜き）
// normalize a frontmatter `tags` value into a string array (array / comma / space separated, # stripped)
function normalizeTags(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(/[,\s]+/);
  return raw.map((x) => x.replace(/^#/, "").trim()).filter(Boolean);
}

// wikilink / Markdown リンク / 生パスから実ファイルを解決 / resolve a wikilink, markdown link, or raw path
function resolveLink(app: App, raw: string, sourcePath: string): TFile | null {
  let inner = raw.trim();
  const md = inner.match(/\]\(([^)]+)\)/); // [text](path)
  if (md) inner = decodeURIComponent(md[1]);
  else inner = inner.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  inner = inner.split("#")[0].trim();
  return app.metadataCache.getFirstLinkpathDest(inner, sourcePath);
}

// 指定フォルダ配下のタスクを収集（folderPath="" は Vault ルート）/ collect tasks under a scoped folder
export function collectTasks(app: App, settings: GanttSettings, folderPath: string): Task[] {
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();

  const files: TFile[] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") files.push(child);
      else if (child instanceof TFolder && settings.recurse) walk(child);
    }
  };
  walk(root);

  const k = settings.keys;
  const fields = validCustomFields(settings);
  const rawAfter = new Map<string, string[]>(); // path -> 生の after / raw after entries
  const rawParent = new Map<string, string>(); // path -> 生の parent リンク / raw parent link
  const tasks: Task[] = files.map((file) => {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? {};
    // タグはフロントマター＋本文 #tag を統合し # を外す（重複排除）/ merge frontmatter + inline tags, strip #, dedupe
    const tags = cache ? [...new Set((getAllTags(cache) ?? []).map((x) => x.replace(/^#/, "")))] : [];
    // スコープから見たフォルダ階層（ファイル名は除く）/ folder chain relative to the scope (without filename)
    const rel = isVaultRoot ? file.path : file.path.slice(rootPath.length + 1);
    const segs = rel.split("/");
    const groups = segs.slice(0, -1);

    const ps = parseStored(fm[k.start], settings.tz);
    const pe = parseStored(fm[k.end], settings.tz);
    const start = ps?.date;
    let end = pe?.date;
    // マイルストーン＝期限(end)のみ入力、または明示フラグ / milestone = only the due date, or explicit flag
    const milestone = fm[k.milestone] === true || (!!end && !start);
    // 「開始のみ・終了なし」は無効ルール → 終了=開始（1日タスク扱い）/ "start only" isn't valid: mirror end = start
    const endFilled = !!start && !end;
    if (endFilled) end = start;

    rawAfter.set(file.path, fmList(fm[k.after]));
    // parent は any を直接受けず unknown 経由で安全に文字列化 / coerce parent via unknown (avoid unsafe any)
    const pv: unknown = fm[k.parent];
    if (pv != null && pv !== "") {
      const link = Array.isArray(pv) ? (pv as unknown[])[0] : pv;
      rawParent.set(file.path, String(link));
    }
    // Custom field（値のあるものだけ）/ custom fields (only those with a value)
    const custom: Record<string, CustomValue> = {};
    for (const f of fields) {
      const v = readCustomValue(fm[f.key.trim()], f.type, settings.tz);
      if (v !== undefined) custom[f.id] = v;
    }
    // 種類：Kanban プラグインの印があればカンバン、.canvas へのリンクがあればキャンバス / kind: the Kanban plugin's marker, or a link to a .canvas
    const cv = fmText(fm[k.canvas]);
    const canvas = cv ? resolveLink(app, cv, file.path) : null;
    const kind: TaskKind = fm["kanban-plugin"] ? "kanban" : canvas?.extension === "canvas" ? "canvas" : "note";
    // カンバンの進捗はチェックしたカードの割合。カードは詳細パネルの列と同じ kanbanLanes の決まりで数える
    // a kanban's progress is the share of checked cards, counted by kanbanLanes, the same rule the detail panel's lanes use
    const all = kind === "kanban" ? kanbanLanes(cache).flatMap((l) => l.cards) : [];
    const cards = all.length ? { done: all.filter((c) => c.done).length, total: all.length } : undefined;
    return {
      path: file.path,
      name: file.basename,
      groups,
      start,
      end,
      startTime: ps?.time,
      endTime: pe?.time,
      endFilled: endFilled || undefined,
      priority: fmText(fm[k.priority]) || undefined,
      status: fm[k.status] != null ? String(fm[k.status]) : undefined,
      assignees: fmList(fm[k.assignee]),
      kind,
      canvas: kind === "canvas" ? canvas?.path : undefined,
      deps: [] as Dep[],
      progress: cards ? cardProgress(cards.done, cards.total) : fm[k.progress] != null ? parseFloat(String(fm[k.progress])) : undefined, // "50%" も 50 / "50%" reads as 50
      cards,
      milestone,
      parent: undefined,
      tags,
      custom,
    };
  });

  // 依存（after）を型付きでパスへ解決 / resolve typed dependencies to paths
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  for (const t of tasks) {
    for (const raw of rawAfter.get(t.path) ?? []) {
      const { type, link } = parseDepRaw(raw);
      const dest = resolveLink(app, link, t.path);
      if (dest && byPath.has(dest.path)) t.deps.push({ path: dest.path, type });
    }
    // 親リンクを解決（解決できない＝宙ぶらりんはトップレベル扱い）/ resolve parent (unresolved = treated as top-level)
    const rp = rawParent.get(t.path);
    if (rp) {
      const dest = resolveLink(app, rp, t.path);
      if (dest && dest.path !== t.path && byPath.has(dest.path)) t.parent = dest.path;
    }
  }
  return tasks;
}

// スコープ配下の全サブフォルダを「相対セグメント配列」で収集（空フォルダ表示用）
// collect all subfolders under the scope as relative segment arrays (used to show empty folders)
export function collectFolders(app: App, settings: GanttSettings, folderPath: string): string[][] {
  if (!settings.recurse) return []; // 非再帰ならサブフォルダはグループ化されない / no grouping when not recursing
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();
  const out: string[][] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const rel = isVaultRoot ? child.path : child.path.slice(rootPath.length + 1);
      out.push(rel.split("/"));
      walk(child);
    }
  };
  walk(root);
  return out;
}

// タスクの開始・終了アンカー（マイルストーンは期限日に集約）/ task anchor dates (milestone collapses to its due date)
export function anchorStart(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.start;
}
export function anchorEnd(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.end ?? t.start;
}

// フォルダのツリーノード / folder tree node
interface TreeNode {
  name: string;
  folders: Map<string, TreeNode>;
  tasks: Task[];
}

// 配下（子孫含む）の全タスク / all descendant tasks
function descendantTasks(node: TreeNode): Task[] {
  const out = [...node.tasks];
  for (const c of node.folders.values()) out.push(...descendantTasks(c));
  return out;
}

// タスク群からまとめバー範囲を求める / compute the rolled-up span
function spanOf(tasks: Task[]): { start: string; end: string } | undefined {
  const starts = tasks.map(anchorStart).filter((d): d is string => !!d).sort();
  const ends = tasks.map(anchorEnd).filter((d): d is string => !!d).sort();
  return starts.length && ends.length ? { start: starts[0], end: ends[ends.length - 1] } : undefined;
}

// 改名・移動に合わせて折りたたみのキーを付け替える。追いかけるのは親タスクのキー（"folder:<タスクのパス>"）で、
// フォルダの見出しのキーはボードからの相対なのでボードごと動いてもそのまま
// re-point collapse keys after a rename or move: parent tasks' keys ("folder:<task path>") follow it, while folder heading keys are
// relative to the board, so they stay valid when the whole board moves
export function moveCollapsed(keys: string[], from: string, to: string): string[] {
  return keys.map((k) => {
    const p = k.startsWith("folder:") && k.endsWith(".md") ? k.slice(7) : null;
    return p != null && (p === from || p.startsWith(from + "/")) ? `folder:${to}${p.slice(from.length)}` : k;
  });
}

// 改名・移動に合わせてパスの一覧を付け替える（フォルダなら配下ごと）/ re-point a list of paths after a rename or move (a folder takes its contents along)
export function movePaths(paths: string[], from: string, to: string): string[] {
  return paths.map((p) => (p === from || p.startsWith(from + "/") ? to + p.slice(from.length) : p));
}

// フォルダ階層を入れ子の表示行へ展開（collapsed のフォルダは子を省く）
// flatten the folder tree into nested rows (collapsed folders hide their children)
// 既定のタスク比較＝開始日昇順（呼び出し側が指定しなければこれ）/ default task order = start ascending
const defaultTaskCompare = (a: Task, b: Task): number =>
  (anchorStart(a) ?? "9999").localeCompare(anchorStart(b) ?? "9999");

export function buildRows(
  tasks: Task[],
  collapsed: Set<string> = new Set(),
  folders: string[][] = [],
  taskCompare: (a: Task, b: Task) => number = defaultTaskCompare,
  nest = false // 親子（parent）でネストするか（フォルダグループ化時のみ）/ nest by parent (folder grouping only)
): Row[] {
  const root: TreeNode = { name: "", folders: new Map(), tasks: [] };
  // 先に（空かもしれない）フォルダのノードを作る＝タスクが無くても行が出る
  // seed nodes for (possibly empty) folders first, so a folder shows even with no tasks
  for (const chain of folders) {
    let node = root;
    for (const g of chain) {
      if (!g) continue;
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
  }
  for (const t of tasks) {
    let node = root;
    for (const g of t.groups) {
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
    node.tasks.push(t);
  }

  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number, prefix: string) => {
    // 直下タスクが先、サブフォルダは後（名前順）。逆だとフォルダ直下のタスクが直前のサブフォルダの中に見える
    // direct tasks first, then subfolders by name; the other way round a folder's own tasks read as part of the subfolder above them
    placeTasks(node, depth);
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
      const child = node.folders.get(name)!;
      const key = prefix ? `${prefix}/${name}` : name;
      const under = descendantTasks(child);
      rows.push({ kind: "group", group: name, depth, key, span: spanOf(under), tasks: under });
      if (!collapsed.has(key)) walk(child, depth + 1, key);
    }
  };
  // 直下タスクを並べる（nest 時は parent でツリー化）/ place direct tasks (a parent forest when nesting)
  const placeTasks = (node: TreeNode, depth: number) => {
    if (!nest) {
      for (const task of node.tasks.slice().sort(taskCompare)) rows.push({ kind: "task", group: node.name, depth, task });
      return;
    }
    // ── 親子ネスト：同一フォルダ内のタスクを parent でフォレスト化 / nest by parent within this folder ──
    const paths = new Set(node.tasks.map((t) => t.path));
    const kids = new Map<string, Task[]>();
    for (const t of node.tasks) {
      if (!t.parent || !paths.has(t.parent)) continue;
      const list = kids.get(t.parent);
      if (list) list.push(t);
      else kids.set(t.parent, [t]);
    }
    for (const list of kids.values()) list.sort(taskCompare);
    const childrenOf = (p: string): Task[] => kids.get(p) ?? [];
    // 自分＋子孫の集約（ロールアップ用）/ self + descendants span (for rollup)
    const subtree = (t: Task, seen: Set<string>): Task[] => {
      if (seen.has(t.path)) return [];
      seen.add(t.path);
      const out = [t];
      for (const c of childrenOf(t.path)) out.push(...subtree(c, seen));
      return out;
    };
    // ルート＝親が無い or 親が同フォルダに居ない（宙ぶらりん→トップレベル昇格）/ roots = no parent or parent not in this folder
    const roots = node.tasks.filter((t) => !t.parent || !paths.has(t.parent)).sort(taskCompare);
    // フォレストに属するタスク（折りたたみは無視して算出）/ tasks that belong to the forest (ignoring collapse)
    const reachable = new Set<string>();
    const mark = (p: string) => {
      if (reachable.has(p)) return;
      reachable.add(p);
      for (const c of childrenOf(p)) mark(c.path);
    };
    for (const r of roots) mark(r.path);

    const emitted = new Set<string>();
    const emit = (task: Task, d: number, sub = false) => {
      if (emitted.has(task.path)) return; // 重複ガード / dup guard
      emitted.add(task.path);
      const children = childrenOf(task.path);
      const has = children.length > 0;
      const span = has ? spanOf(subtree(task, new Set())) : undefined;
      rows.push({ kind: "task", group: node.name, depth: d, task, key: has ? task.path : undefined, span, hasChildren: has, sub: sub || undefined });
      // 折りたたみ中は子を出さない / hide children while collapsed
      if (has && !collapsed.has(task.path)) for (const c of children) emit(c, d + 1, true);
    };
    for (const r of roots) emit(r, depth);
    // フォレストに到達できない＝循環で孤立したタスクだけトップレベルで出す / surface only cycle-orphaned tasks
    for (const t of node.tasks.filter((x) => !reachable.has(x.path)).sort(taskCompare)) emit(t, depth);
  };
  walk(root, 0, "");
  return rows;
}

// フロントマターの開始/終了を書き戻す / write back start/end into frontmatter
export async function writeDates(
  app: App,
  settings: GanttSettings,
  path: string,
  start: string,
  end: string,
  milestone: boolean
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    // 既存値に時刻が付いていたら表示時刻を新しい日付へ引き継ぐ（オフセットは設定タイムゾーンへ正規化）
    // carry the displayed time-of-day over to the new date (re-normalizing the offset to the configured tz)
    const ts = parseStored(fm[k.start], settings.tz)?.time;
    const te = parseStored(fm[k.end], settings.tz)?.time;
    if (milestone) {
      // マイルストーンは期限(end)のみ / milestone keeps only the due date
      fm[k.end] = combineDateTime(end, te, settings.tz);
      delete fm[k.start];
    } else {
      fm[k.start] = combineDateTime(start, ts, settings.tz);
      // 期限日の無いタスクを動かしても期限日を足さない（1 日のまま開始日だけ）/ moving a task with no due date doesn't add one (it stays a start-only day)
      if (fm[k.end] != null || start !== end) fm[k.end] = combineDateTime(end, te, settings.tz);
    }
  });
}

// 任意のフロントマター値を書き戻す / write back an arbitrary frontmatter value
export async function writeField(
  app: App,
  path: string,
  key: string,
  value: unknown
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    if (value == null || value === "") delete fm[key];
    else fm[key] = value;
  });
}

// 多値フィールド（担当者）を書く。0 件は削除、1 件は元がリストでなければ単一値のまま（既存の書き方を崩さない）
// write a multi-valued field (assignees): none deletes it; a single value stays a plain value unless it was a list already
export async function editListField(app: App, path: string, key: string, value: string, add: boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const next = listWith(fm[key], value, add);
    if (next === null) delete fm[key];
    else if (next !== undefined) fm[key] = next;
  });
}

// 多値のフロントマター値に 1 件足す・外した後の値（変わらなければ undefined、空になれば null）。人は表示名で比べるので
// "Ben" と "[[Ben]]" は同じ人。ほかの値は書かれたまま残し、リストだった値はリストのまま、1 件の値は 1 件のまま
// the value after adding or removing one entry of a multi-valued property (undefined: no change, null: now empty). People compare by
// display name, so "Ben" and "[[Ben]]" are one person. Other entries stay as written, a list stays a list and a single value stays single
export function listWith(raw: unknown, value: string, add: boolean): unknown {
  const wasList = Array.isArray(raw) && !isBareLink(raw);
  // 引用符なしの [[x]] は YAML が入れ子の配列にするので、書き戻す前に "[[x]]" の文字列へ / an unquoted [[x]] is a nested array to YAML: write it back as "[[x]]"
  const items = (raw == null || raw === "" ? [] : wasList ? (raw as unknown[]) : [raw]).map((x) => (isBareLink(x) ? fmText(x) : x));
  const same = (x: unknown) => linkLabel(fmText(x)?.trim() ?? "") === linkLabel(value);
  if (add === items.some(same)) return undefined;
  const next = add ? [...items, value] : items.filter((x) => !same(x));
  return next.length === 0 ? null : next.length > 1 || wasList ? next : next[0];
}

// 本文（フロントマターを除く）を取得 / read the body (without frontmatter)
export async function readBody(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? bodyOf(await app.vault.cachedRead(file)) : "";
}

// ノートの中身から本文だけ（先頭の --- ... --- を除去）/ a note's body: its text without the leading frontmatter block
export function bodyOf(text: string): string {
  return text.replace(FRONTMATTER, "").trim();
}

// 先頭のフロントマター（中身の無い "---\n---" も）/ the leading frontmatter block (an empty "---\n---" too)
const FRONTMATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/;

// フロントマターを保ったまま本文を差し替えたノートの中身（フロントマターの直後に空行を足さない）
// a note's text with its body replaced and its frontmatter kept (no blank line added after the frontmatter)
export function withBody(text: string, body: string): string {
  const m = text.match(FRONTMATTER);
  const fm = !m ? "" : m[0].endsWith("\n") ? m[0] : m[0] + "\n";
  const trimmed = body.replace(/\s+$/, "");
  return fm + (trimmed ? trimmed + "\n" : "");
}

// 本文を書き戻す（フロントマターは保持）/ write back the body (keeping frontmatter)
export async function writeBody(app: App, path: string, body: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.vault.process(file, (text) => withBody(text, body));
}

// 新規タスクをフォルダ直下に作り、作ったパスを返す（ノートが先頭）。名前が衝突したら連番を付ける。
// カンバンはステータスを列にした Kanban プラグイン形式、キャンバスは同名の .canvas を作ってリンクし本文に埋め込む
// create a new task in the folder and return the paths made (the note first); a clashing name gets a counter.
// A kanban gets one lane per status in the Kanban plugin's format; a canvas gets a same-named .canvas, linked and embedded
export async function createTask(app: App, settings: GanttSettings, folderPath: string, baseName: string, kind: TaskKind = "note"): Promise<string[]> {
  const dir = normalizePath(folderPath || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  const taken = (n: string) => !!app.vault.getAbstractFileByPath(`${prefix}${n}.md`) || (kind === "canvas" && !!app.vault.getAbstractFileByPath(`${prefix}${n}.canvas`));
  let name = baseName;
  let i = 1;
  while (taken(name)) name = `${baseName} ${++i}`;
  const md = `${prefix}${name}.md`;
  // 開始/終了は呼び出し側（view）が今日で埋める / caller fills start/end
  if (kind === "kanban") {
    await app.vault.create(md, `---\nkanban-plugin: board\n---\n\n${settings.statuses.map((s) => `## ${s.label}\n\n`).join("\n")}`);
    return [md];
  }
  if (kind !== "canvas") {
    await app.vault.create(md, "---\n---\n");
    return [md];
  }
  const cv = await app.vault.create(`${prefix}${name}.canvas`, JSON.stringify({ nodes: [], edges: [] }));
  // フロントマターのリンクは wikilink（Obsidian がリネームに追従できる形）。キー名は設定で変えられるので YAML は API に書かせる
  // the frontmatter link is a wikilink (Obsidian keeps those updated on rename); the key is configurable, so the API writes the YAML
  const link = `[[${app.metadataCache.fileToLinktext(cv, md, false)}]]`;
  let note: TFile | null = null;
  try {
    note = await app.vault.create(md, `!${link}\n`);
    await app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => { fm[settings.keys.canvas] = link; });
  } catch (e) {
    // ノートが作れなければ、ここで作ったキャンバス（とノート）を消す（取り消しの記録に載らず残ってしまうため）
    // when the note can't be made, delete the canvas (and note) made here: they'd be left behind, outside the undo record
    for (const f of [note, cv]) if (f) await app.vault.delete(f);
    throw e;
  }
  return [md, cv.path];
}

// 新しいステータス。id は名前から作り既存と重ならないよう連番、色はまだ使っていないパレットの色（設定画面と凡例で共通）
// a new status: the id comes from the label, numbered to stay unique, and the colour is the first palette colour not yet used (settings and legend alike)
export function newStatus(statuses: StatusDef[], label: string): StatusDef {
  const base = label.trim().toLowerCase().replace(/\s+/g, "-") || "status";
  let id = base;
  for (let i = 2; statuses.some((x) => x.id === id); i++) id = `${base}-${i}`;
  const used = new Set(statuses.map((x) => x.color.toLowerCase()));
  return { id, label: label.trim(), color: PALETTE.find((c) => !used.has(c)) ?? PALETTE[0], group: "active" };
}

export interface KanbanLane {
  title: string;
  cards: { text: string; done: boolean }[];
}

// チェックしたカードの割合（%）。100% は全部、0% は 1 枚も無いときだけ（199/200 を 100% に丸めない）
// the share of checked cards in %; 100% only when all are done and 0% only when none are (199/200 doesn't round up to 100%)
export function cardProgress(done: number, total: number): number {
  if (done === total) return 100;
  return Math.min(99, Math.max(done ? 1 : 0, Math.round((100 * done) / total)));
}

// カンバンの列とカード。Kanban プラグインと同じ決まり：## 見出しが列、その下の最上位のリスト項目がカード（チェックボックスが無くても）。
// 区切り線（***）から先はアーカイブなので数えない。進捗と詳細パネルの両方がこれを使うので数が必ず合う。text（ノート全文）を渡すとカードの文字も入る
// a kanban's lanes and cards, by the Kanban plugin's rule: each ## heading is a lane and the top-level list items under it are cards (with or
// without a checkbox). Everything from the thematic break (***) on is the archive and doesn't count. Progress and the detail panel both use
// this, so their numbers always agree. Pass the note's full text to get the card text too
export function kanbanLanes(cache: CachedMetadata | null, text = ""): KanbanLane[] {
  const heads = (cache?.headings ?? []).filter((h) => h.level === 2);
  if (!heads.length) return [];
  const first = heads[0].position.start.line;
  const end = cache?.sections?.find((x) => x.type === "thematicBreak" && x.position.start.line > first)?.position.start.line ?? Infinity;
  const lanes = heads.filter((h) => h.position.start.line < end).map((h) => ({ line: h.position.start.line, title: h.heading.trim(), cards: [] as KanbanLane["cards"] }));
  for (const li of cache?.listItems ?? []) {
    const line = li.position.start.line;
    if (li.parent >= 0 || line <= first || line >= end) continue;
    const raw = text.slice(li.position.start.offset, li.position.end.offset).split("\n")[0];
    lanes.filter((l) => l.line < line).pop()?.cards.push({ text: raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "").trim(), done: li.task !== undefined && li.task !== " " });
  }
  return lanes.map(({ title, cards }) => ({ title, cards }));
}

// タスク（ファイル）をリネーム。リンクも更新される / rename the task file (updates links)
// 同じフォルダに同名のノートがあれば "taken"（上書きも例外も起こさない）/ "taken" when a note of that name already sits in the folder (no overwrite, no exception)
export async function renameTask(app: App, path: string, newName: string): Promise<string | null | "taken"> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  // ファイル名に使えない文字と、リンクを壊す #^[]| を除く / drop characters a file name can't hold, and #^[]| which break links
  const safe = newName.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
  if (!safe) return null;
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const newPath = `${dir}${safe}.md`;
  if (newPath === path) return path;
  if (app.vault.getAbstractFileByPath(newPath)) return "taken";
  await app.fileManager.renameFile(file, newPath);
  return newPath;
}

// タスクを削除（ユーザー設定のゴミ箱へ・OSゴミ箱 or .trash・復元可）/ delete a task to the user's trash (recoverable)
export async function deleteTask(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  await app.fileManager.trashFile(file);
  return true;
}

// Vault 内に存在する全タグ（# 抜き・使用数の多い順）。入力候補に使う。
// Obsidian の非公開 metadataCache.getTags() は使わず、公開 API の getAllTags で集計する。
// every tag present in the vault (without #, most-used first), for input suggestions;
// built with the public getAllTags rather than the undocumented metadataCache.getTags()
export function collectAllTags(app: App): string[] {
  const count = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    for (const raw of getAllTags(cache) ?? []) {
      const tag = raw.replace(/^#/, "");
      if (tag) count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  // よく使うタグを上に（同数は名前順）/ most-used first, ties broken by name
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

// タグを追加（フロントマター tags へ・重複排除）/ add a tag to frontmatter `tags` (deduped)
export async function addTag(app: App, path: string, tag: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  const clean = tag.replace(/^#/, "").trim();
  if (!clean) return false;
  let changed = false;
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const cur = normalizeTags(fm.tags);
    if (!cur.includes(clean)) {
      cur.push(clean);
      fm.tags = cur;
      changed = true;
    }
  });
  return changed;
}

// タグを削除（フロントマター tags のみ・本文 #tag は対象外）/ remove a tag from frontmatter `tags` (inline #tags are not touched)
export async function removeTag(app: App, path: string, tag: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const clean = tag.replace(/^#/, "").trim();
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const cur = normalizeTags(fm.tags).filter((x) => x !== clean);
    if (cur.length) fm.tags = cur;
    else delete fm.tags;
  });
}

// 指定タスクのサブツリー（自分＋子孫）のパス一覧 / paths of a task's subtree (self + descendants)
export function subtreePaths(tasks: Task[], rootPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
    for (const c of tasks) if (c.parent === p) visit(c.path);
  };
  visit(rootPath);
  return out;
}

// タスクの親を設定/解除し、サブツリーごと destFolder へ移動する（D&D の本体）
// set/clear a task's parent and move its whole subtree into destFolder (the D&D core)
// 戻り値：移動履歴（from→to・Undo 用）/ returns the moves made (from → to, for undo)
export async function reparentTask(
  app: App,
  settings: GanttSettings,
  tasks: Task[],
  srcPath: string,
  destFolder: string,
  parentFile: TFile | null
): Promise<{ moves: { from: string; to: string }[] } | null> {
  const src = app.vault.getAbstractFileByPath(srcPath);
  if (!(src instanceof TFile)) return null;
  const k = settings.keys;
  // 親リンクを設定（または解除）/ set (or clear) the parent link
  await app.fileManager.processFrontMatter(src, (fm: Record<string, unknown>) => {
    if (parentFile) fm[k.parent] = app.fileManager.generateMarkdownLink(parentFile, srcPath);
    else delete fm[k.parent];
  });
  // サブツリー（自分＋子孫）は同一フォルダに同居しているので、全部 destFolder へ移す
  // the subtree co-locates in one folder, so move all of it into destFolder
  const dir = normalizePath(destFolder || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  const moves: { from: string; to: string }[] = [];
  for (const p of subtreePaths(tasks, srcPath)) {
    const f = app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) continue;
    if (normalizePath(f.parent?.path ?? "/") === dir) continue; // 既に dest / already there
    let name = f.basename;
    let i = 1;
    while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${f.basename} ${++i}`;
    const np = `${prefix}${name}.md`;
    await app.fileManager.renameFile(f, np); // リンクは Obsidian が更新 / Obsidian updates links
    moves.push({ from: p, to: np });
  }
  return { moves };
}

// 依存を追加（型付き）: successor.after に predecessor を足す。既存の同 pred は置き換える
// add a typed dependency; replaces any existing dependency to the same predecessor
export async function addDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string,
  type: DepType
): Promise<boolean> {
  if (successorPath === predPath) return false;
  const succ = app.vault.getAbstractFileByPath(successorPath);
  const pred = app.vault.getAbstractFileByPath(predPath);
  if (!(succ instanceof TFile) || !(pred instanceof TFile)) return false;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(succ, (fm: Record<string, unknown>) => {
    // 引用符なしの [[x]] も文字列の wikilink として読む（fmList）/ an unquoted [[x]] is read as a wikilink string too (fmList)
    const arr = fmList(fm[k.after]);
    // 既存の同 pred を除去 / drop any existing entry to the same predecessor
    const kept = arr.filter(
      (raw) => resolveLink(app, stripDepType(raw), successorPath)?.path !== predPath
    );
    const link = app.fileManager.generateMarkdownLink(pred, successorPath);
    kept.push(type === "FS" ? link : `${type}:${link}`); // FS はプレフィックス無しで後方互換
    fm[k.after] = kept;
  });
  return true;
}

// 依存を削除: successor.after から predecessor を外す / remove a dependency
export async function removeDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string
): Promise<void> {
  const succ = app.vault.getAbstractFileByPath(successorPath);
  if (!(succ instanceof TFile)) return;
  const k = settings.keys;
  await app.fileManager.processFrontMatter(succ, (fm: Record<string, unknown>) => {
    if (fm[k.after] == null) return;
    const list = fmList(fm[k.after]);
    const filtered = list.filter(
      (raw) => resolveLink(app, stripDepType(raw), successorPath)?.path !== predPath
    );
    if (filtered.length) fm[k.after] = filtered;
    else delete fm[k.after];
  });
}
