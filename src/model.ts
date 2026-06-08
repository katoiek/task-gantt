import { App, TFile, TFolder, normalizePath } from "obsidian";
import { GanttSettings } from "./settings";
import { Task, Row, Dep, DepType } from "./types";

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

// 日付らしき値を YYYY-MM-DD 文字列へ（不正値は undefined）/ coerce to YYYY-MM-DD (undefined if not a valid date)
function toDateStr(v: unknown): string | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  // 日付として解釈できない値（例: "未定"）は無効扱いにしてレイアウト崩壊を防ぐ
  // values that aren't a date (e.g. "未定") are dropped so they can't break the layout
  return m ? m[0] : undefined;
}

// after を文字列配列へ正規化 / normalize `after` into a string array
function toArray(v: unknown): string[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [String(v)];
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
  const rawAfter = new Map<string, string[]>(); // path -> 生の after / raw after entries
  const tasks: Task[] = files.map((file) => {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    // スコープから見たフォルダ階層（ファイル名は除く）/ folder chain relative to the scope (without filename)
    const rel = isVaultRoot ? file.path : file.path.slice(rootPath.length + 1);
    const segs = rel.split("/");
    const groups = segs.slice(0, -1);

    const start = toDateStr(fm[k.start]);
    let end = toDateStr(fm[k.end]);
    // マイルストーン＝期限(end)のみ入力、または明示フラグ / milestone = only the due date, or explicit flag
    const milestone = fm[k.milestone] === true || (!!end && !start);
    // 「開始のみ・終了なし」は無効ルール → 終了=開始（1日タスク扱い）/ "start only" isn't valid: mirror end = start
    if (start && !end) end = start;

    rawAfter.set(file.path, toArray(fm[k.after]));
    return {
      path: file.path,
      name: file.basename,
      groups,
      start,
      end,
      status: fm[k.status] != null ? String(fm[k.status]) : undefined,
      assignee: fm[k.assignee] != null ? String(fm[k.assignee]) : undefined,
      deps: [] as Dep[],
      progress: fm[k.progress] != null ? Number(fm[k.progress]) : undefined,
      milestone,
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

// フォルダ階層を入れ子の表示行へ展開（collapsed のフォルダは子を省く）
// flatten the folder tree into nested rows (collapsed folders hide their children)
// 既定のタスク比較＝開始日昇順（呼び出し側が指定しなければこれ）/ default task order = start ascending
const defaultTaskCompare = (a: Task, b: Task): number =>
  (anchorStart(a) ?? "9999").localeCompare(anchorStart(b) ?? "9999");

export function buildRows(
  tasks: Task[],
  collapsed: Set<string> = new Set(),
  folders: string[][] = [],
  taskCompare: (a: Task, b: Task) => number = defaultTaskCompare
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
    // フォルダを名前順に / folders first, sorted by name
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
      const child = node.folders.get(name)!;
      const key = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "group", group: name, depth, key, span: spanOf(descendantTasks(child)) });
      if (!collapsed.has(key)) walk(child, depth + 1, key);
    }
    // 直下タスクを指定の比較関数で並べる（既定は開始日昇順）/ sort direct tasks by the given comparator (default: start asc)
    const list = node.tasks.slice().sort(taskCompare);
    for (const task of list) rows.push({ kind: "task", group: node.name, depth, task });
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
    if (milestone) {
      // マイルストーンは期限(end)のみ / milestone keeps only the due date
      fm[k.end] = end;
      delete fm[k.start];
    } else {
      fm[k.start] = start;
      fm[k.end] = end;
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

// 本文（フロントマターを除く）を取得 / read the body (without frontmatter)
export async function readBody(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return "";
  const text = await app.vault.read(file);
  // 先頭の --- ... --- を除去 / strip leading frontmatter block
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

// 本文を書き戻す（フロントマターは保持）/ write back the body (keeping frontmatter)
export async function writeBody(app: App, path: string, body: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.vault.process(file, (text) => {
    const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const fm = m ? m[0].replace(/\n*$/, "\n") : "";
    const trimmed = body.replace(/\s+$/, "");
    return (fm ? fm + "\n" : "") + (trimmed ? trimmed + "\n" : "");
  });
}

// 新規タスク（空フロントマター .md）をフォルダ直下に作成。名前が衝突したら連番を付ける
// create a new task (.md with empty frontmatter) in the folder; de-duplicate the name with a counter
export async function createTask(app: App, folderPath: string, baseName: string): Promise<TFile | null> {
  const dir = normalizePath(folderPath || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  let name = baseName;
  let i = 1;
  while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${baseName} ${++i}`;
  // 開始/終了は呼び出し側（view）が今日で埋める / caller fills start/end
  const file = await app.vault.create(`${prefix}${name}.md`, "---\n---\n");
  return file instanceof TFile ? file : null;
}

// タスク（ファイル）をリネーム。リンクも更新される / rename the task file (updates links)
export async function renameTask(app: App, path: string, newName: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const safe = newName.replace(/[\\/:*?"<>|]/g, "").trim();
  if (!safe) return null;
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const newPath = `${dir}${safe}.md`;
  if (newPath === path) return path;
  await app.fileManager.renameFile(file, newPath);
  return newPath;
}

// タスク（ファイル）を別フォルダへ移動。リンクは更新される / move the task file to another folder (updates links)
// 同フォルダなら no-op、名前衝突は連番で回避 / no-op if already there; de-duplicate name on collision
export async function moveTask(app: App, path: string, destFolder: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const dir = normalizePath(destFolder || "/");
  if (normalizePath(file.parent?.path ?? "/") === dir) return path; // 既に同じフォルダ / already there
  const prefix = dir === "/" ? "" : dir + "/";
  let name = file.basename;
  let i = 1;
  while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${file.basename} ${++i}`;
  const newPath = `${prefix}${name}.md`;
  await app.fileManager.renameFile(file, newPath);
  return newPath;
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
    const existing = fm[k.after];
    const arr: unknown[] = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
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
    const existing = fm[k.after];
    if (existing == null) return;
    const list: unknown[] = Array.isArray(existing) ? existing : [existing];
    const filtered = list.filter(
      (raw) => resolveLink(app, stripDepType(raw), successorPath)?.path !== predPath
    );
    if (filtered.length) fm[k.after] = filtered;
    else delete fm[k.after];
  });
}
