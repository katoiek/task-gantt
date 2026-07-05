// 双方向同期エンジン：Push（タスク→GCal）と Pull（GCal→タスク）、衝突解決、ループ防止
// the two-way sync engine: push (task → GCal), pull (GCal → task), conflict resolution, loop prevention

import { Notice, Platform, TFile } from "obsidian";
import type GanttPlugin from "../main";
import { collectTasks, combineDateTime, readBody } from "../model";
import { Task } from "../types";
import { t as tr } from "../i18n";
import { GcalApiError, GEvent, deleteEvent, insertEvent, listEvents, patchEvent } from "./api";
import { buildEvent, fromEvent, hasDates, taskHash, TaskLike } from "./map";

// 初回フル取得の下限（過去90日）/ initial full sync lower bound (90 days back)
const FULL_SYNC_DAYS = 90;
// 本文の説明欄への転記量 / how much of the body goes into the event description
const EXCERPT_LEN = 500;

// 実行中ガード（再入は完了後にもう一周）/ re-entrancy guard (a re-entry queues one more run)
let running = false;
let rerun = false;
let pushTimer = 0;

// 同期を実行できる状態か / can we sync at all?
function ready(plugin: GanttPlugin): boolean {
  const g = plugin.settings.gcal;
  return Platform.isDesktop && !!g.refreshToken && !!g.calendarId && (g.pushEnabled || g.pullEnabled);
}

// 同期スコープのタスク（設定フォルダ・日付あり・オプトイン条件）/ tasks in the sync scope
function scopeTasks(plugin: GanttPlugin): Task[] {
  const s = plugin.settings;
  const folder = s.gcal.scopeFolder || s.rootFolder;
  return collectTasks(plugin.app, s, folder).filter((t) => hasDates(t) && optedIn(plugin, t.path));
}

// フロントマターを取得 / read a file's frontmatter
function fmOf(plugin: GanttPlugin, path: string): Record<string, unknown> | undefined {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return undefined;
  return plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
}

// 同期対象フラグ（オプトイン設定時は gcal: true のタスクのみ）/ opt-in check
function optedIn(plugin: GanttPlugin, path: string): boolean {
  if (!plugin.settings.gcal.optInOnly) return true;
  const v = fmOf(plugin, path)?.[plugin.settings.keys.gcal];
  return v === true || v === "true";
}

// 説明欄に載せる本文抜粋 / the body excerpt for the description
async function excerptOf(plugin: GanttPlugin, path: string): Promise<string> {
  return (await readBody(plugin.app, path)).slice(0, EXCERPT_LEN);
}

// gcalId フロントマターの書き込み/削除 / write or clear the gcalId frontmatter key
async function writeGcalId(plugin: GanttPlugin, path: string, id: string | undefined): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = plugin.settings.keys;
  await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    if (id) fm[k.gcalId] = id;
    else delete fm[k.gcalId];
  });
}

// GCal 側で消えたイベントのタスク処理（既定はリンク解除のみ・ファイルは消さない）
// handle a task whose event was deleted on the GCal side (default: just unlink; never delete the file)
async function unlinkTask(plugin: GanttPlugin, path: string, clearDates: boolean): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = plugin.settings.keys;
  await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    delete fm[k.gcalId];
    if (clearDates) {
      delete fm[k.start];
      delete fm[k.end];
    }
  });
}

// GCal 側の変更をフロントマターへ書き戻す / write remote date changes back into frontmatter
async function writeRemoteDates(
  plugin: GanttPlugin,
  path: string,
  d: { start: string; end: string; startTime?: string; endTime?: string },
  keepMilestone: boolean
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = plugin.settings.keys;
  const tz = plugin.settings.tz;
  await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    fm[k.end] = combineDateTime(d.end, d.endTime, tz);
    if (keepMilestone) {
      delete fm[k.start]; // マイルストーンは期限のみ / a milestone keeps only the due date
    } else {
      fm[k.start] = combineDateTime(d.start, d.startTime, tz);
      // イベントが複数日に広がったら明示フラグも外す（バーに追従させる）
      // when the event grew past one day, drop the explicit flag so the bar follows
      if (d.start !== d.end && fm[k.milestone] === true) delete fm[k.milestone];
    }
  });
}

// 作成の直前に既存イベントを検索（多端末での二重作成を防ぐ）
// search for an existing event right before inserting (prevents duplicates across devices)
async function createFor(plugin: GanttPlugin, t: TaskLike, payload: object): Promise<GEvent> {
  const g = plugin.settings.gcal;
  const vault = plugin.app.vault.getName();
  const found = await listEvents(plugin, g.calendarId, {
    privateExtendedProperty: [`tgPath=${t.path}`, `tgVault=${vault}`],
    maxResults: "2",
  });
  const live = found.items?.find((e) => e.status !== "cancelled");
  if (live) return patchEvent(plugin, g.calendarId, live.id, payload);
  return insertEvent(plugin, g.calendarId, payload);
}

// ---- Push（タスク → GCal）----
// skip: この直前の Pull で書き換えたパス。metadataCache が古いままの可能性があるので今回は触らない
// skip: paths just written by pull; the metadata cache may still be stale, so leave them for the next tick
async function pushPass(plugin: GanttPlugin, skip: Set<string>): Promise<void> {
  const g = plugin.settings.gcal;
  const app = plugin.app;
  const k = plugin.settings.keys;
  const tz = plugin.settings.tz;
  const vault = app.vault.getName();
  const tasks = scopeTasks(plugin);
  const active = new Set(tasks.map((t) => t.path));

  // 1) 孤児掃除：スコープから消えた state エントリのイベントを削除
  // 1) orphan cleanup: delete events whose task left the scope
  for (const [path, st] of Object.entries(g.state)) {
    if (active.has(path) || skip.has(path)) continue;
    const file = app.vault.getAbstractFileByPath(path);
    const exists = file instanceof TFile;
    // ファイル削除時はポリシーに従う。スコープ外れ・オプトアウト・日付削除は常にイベントを外す
    // deleted files follow the policy; out-of-scope / opted-out / dateless always drop the event
    if (!exists && !g.deleteEventOnTaskDelete) {
      delete g.state[path];
      continue;
    }
    await deleteEvent(plugin, g.calendarId, st.id);
    if (exists) await writeGcalId(plugin, path, undefined);
    delete g.state[path];
  }

  // 2) 作成・更新：ハッシュが変わったタスクだけ API を呼ぶ
  // 2) upserts: only tasks whose fingerprint changed hit the API
  for (const t of tasks) {
    if (skip.has(t.path)) continue;
    const fmId = fmOf(plugin, t.path)?.[k.gcalId];
    const knownId = fmId != null && fmId !== "" ? String(fmId) : "";
    let st = g.state[t.path];
    // 他端末が作った紐付け（frontmatter の gcalId）を取り込む / adopt a link created on another device
    if (!st && knownId) st = g.state[t.path] = { id: knownId, hash: "", etag: "", at: 0 };
    const excerpt = await excerptOf(plugin, t.path);
    const hash = taskHash(t, excerpt);
    if (st && st.hash === hash) continue;
    const payload = buildEvent(t, tz, excerpt, vault);
    let ev: GEvent;
    if (st) {
      try {
        ev = await patchEvent(plugin, g.calendarId, st.id, payload);
      } catch (e) {
        // イベントが手動削除されていたら作り直す / recreate when the event was deleted manually
        if (e instanceof GcalApiError && (e.status === 404 || e.status === 410)) {
          ev = await createFor(plugin, t, payload);
        } else throw e;
      }
    } else {
      ev = await createFor(plugin, t, payload);
    }
    g.state[t.path] = { id: ev.id, hash, etag: ev.etag ?? "", at: Date.now(), link: ev.htmlLink };
    if (knownId !== ev.id) await writeGcalId(plugin, t.path, ev.id);
  }
}

// ---- Pull（GCal → タスク）----
// syncToken による増分取得。書き換えたパスの集合を返す（同ティックの Push から除外するため）
// incremental pull via syncToken; returns the set of paths written (excluded from this tick's push)
async function pullPass(plugin: GanttPlugin, retried = false): Promise<Set<string>> {
  const g = plugin.settings.gcal;
  const app = plugin.app;
  const tz = plugin.settings.tz;
  const vault = app.vault.getName();
  const justPulled = new Set<string>();

  const items: GEvent[] = [];
  let pageToken: string | undefined;
  try {
    do {
      const res = await listEvents(plugin, g.calendarId, {
        maxResults: "250",
        showDeleted: "true",
        pageToken,
        // 初回はフル取得（過去90日〜）。以降は syncToken で差分のみ / full sync first, then deltas only
        ...(g.syncToken
          ? { syncToken: g.syncToken }
          : { timeMin: new Date(Date.now() - FULL_SYNC_DAYS * 864e5).toISOString() }),
      });
      items.push(...(res.items ?? []));
      pageToken = res.nextPageToken;
      if (res.nextSyncToken) g.syncToken = res.nextSyncToken;
    } while (pageToken);
  } catch (e) {
    // syncToken 失効（410）→ 破棄してフル取得をやり直す / expired sync token (410) → retry with a full sync
    if (e instanceof GcalApiError && e.status === 410 && !retried) {
      g.syncToken = "";
      return pullPass(plugin, true);
    }
    throw e;
  }

  const byId = new Map(Object.entries(g.state).map(([path, st]) => [st.id, path]));
  const tasksByPath = new Map(scopeTasks(plugin).map((t) => [t.path, t]));

  for (const ev of items) {
    // 繰り返しイベントは対象外 / recurring events are out of scope
    if (ev.recurrence || ev.recurringEventId) continue;
    // 自分（この Vault のプラグイン）が作ったイベントだけ扱う / only touch events this vault's plugin created
    let path = byId.get(ev.id);
    if (!path) {
      const priv = ev.extendedProperties?.private;
      if (priv?.tgVault !== vault || !priv.tgPath) continue;
      path = priv.tgPath;
    }
    const st = g.state[path];
    if (!st || st.id !== ev.id) continue; // 未紐付けは Push 側に任せる / unlinked events are push's job

    // GCal 側で削除された / deleted on the GCal side
    if (ev.status === "cancelled") {
      await unlinkTask(plugin, path, g.onEventDeleted === "clearDates");
      delete g.state[path];
      justPulled.add(path);
      continue;
    }

    // 自分の書き込みのエコーはスキップ（ループ防止の要）/ skip echoes of our own writes (the loop-prevention core)
    if (ev.etag && ev.etag === st.etag) {
      st.link = ev.htmlLink ?? st.link;
      continue;
    }

    const t = tasksByPath.get(path);
    const file = app.vault.getAbstractFileByPath(path);
    if (!t || !(file instanceof TFile)) continue; // 消えたタスクは Push の孤児掃除が処理 / push handles orphans
    const remote = fromEvent(ev, tz);
    if (!remote) continue;

    // 衝突判定：前回同期以降に両側が変わっていたら新しい方が勝つ（last-writer-wins）
    // conflict: when both sides changed since the last sync, the newer one wins
    const excerpt = await excerptOf(plugin, path);
    const localChanged = taskHash(t, excerpt) !== st.hash;
    const remoteMs = ev.updated ? Date.parse(ev.updated) : 0;
    if (localChanged && file.stat.mtime >= remoteMs) {
      st.hash = ""; // ローカル勝ち：次の Push で上書きさせる / local wins: force the next push to overwrite
      new Notice(tr().gcalKeptLocal(t.name));
      continue;
    }
    if (localChanged) new Notice(tr().gcalKeptRemote(t.name));

    const keepMilestone = t.milestone && remote.start === remote.end;
    await writeRemoteDates(plugin, path, remote, keepMilestone);
    // 書き込み後の内容でハッシュを更新（Push の再発火を防ぐ）/ refresh the hash so push doesn't re-fire
    const after: TaskLike = {
      path,
      name: t.name,
      start: keepMilestone ? undefined : remote.start,
      end: remote.end,
      startTime: keepMilestone ? undefined : remote.startTime,
      endTime: remote.endTime,
      milestone: keepMilestone,
    };
    st.hash = taskHash(after, excerpt);
    st.etag = ev.etag ?? "";
    st.at = Date.now();
    st.link = ev.htmlLink ?? st.link;
    justPulled.add(path);
    // タイトルは GCal 側から書き戻さない（ファイルリネームは危険）。次の Push でタスク名に戻す
    // titles never flow back (file renames are risky); the next push restores the task's name
    if (ev.summary !== t.name) st.hash = "";
  }
  return justPulled;
}

// ---- エントリポイント ----
// 同期の実行。エラーは lastError に記録して本体の動作は止めない（次のティックで再試行）
// run a sync; errors land in lastError and never block the plugin (the next tick retries)
export async function syncGcal(plugin: GanttPlugin, opts: { pull: boolean }): Promise<boolean> {
  if (!ready(plugin)) return false;
  if (running) {
    rerun = true;
    return true;
  }
  running = true;
  const g = plugin.settings.gcal;
  let ok = true;
  try {
    let justPulled = new Set<string>();
    if (g.pullEnabled && opts.pull) justPulled = await pullPass(plugin);
    if (g.pushEnabled) await pushPass(plugin, justPulled);
    g.lastSync = Date.now();
    g.lastError = "";
  } catch (e) {
    ok = false;
    g.lastError = e instanceof Error ? e.message : String(e);
    console.error("Task Gantt: Google Calendar sync failed", e);
  } finally {
    running = false;
    await plugin.saveData(plugin.settings);
    if (rerun) {
      rerun = false;
      void syncGcal(plugin, { pull: false });
    }
  }
  return ok;
}

// ローカル編集後の Push を数秒デバウンスして予約 / schedule a debounced push after local edits
export function schedulePush(plugin: GanttPlugin): void {
  if (!ready(plugin) || !plugin.settings.gcal.pushEnabled) return;
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void syncGcal(plugin, { pull: false }), 5_000);
}

// リネーム・移動の追従：state のキーを付け替え、次の Push で summary と tgPath を更新
// follow renames/moves: re-key the state entry; the next push refreshes summary and tgPath
export function migrateRenamedPath(plugin: GanttPlugin, oldPath: string, newPath: string): void {
  const g = plugin.settings.gcal;
  const st = g.state[oldPath];
  if (!st) return;
  delete g.state[oldPath];
  g.state[newPath] = { ...st, hash: "" }; // 名前が変わった可能性があるので必ず Push させる / force a push
  schedulePush(plugin);
}
