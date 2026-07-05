// タスク ⇄ Google カレンダーイベントの純粋な変換ロジック（副作用なし・単体テスト対象）
// pure task ⇄ Google Calendar event mapping logic (no side effects; unit-tested)

import { combineDateTime, parseStored } from "../model";
import type { GEvent } from "./api";

// 変換に必要なタスク側フィールド / the task fields the mapping needs
export interface TaskLike {
  path: string;
  name: string;
  start?: string;
  end?: string;
  startTime?: string;
  endTime?: string;
  milestone: boolean;
}

// ISO 日付に日数を加算 / add days to an ISO date
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// 設定タイムゾーンの壁時計を RFC3339（秒付き）へ / wall-clock in the configured tz → RFC3339 (with seconds)
export function rfc3339(date: string, time: string, tz: string): string {
  // combineDateTime は "YYYY-MM-DDTHH:mm+09:00" を返すので秒を差し込む / insert the seconds Google requires
  return combineDateTime(date, time, tz)!.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/, "$1:00");
}

// 同期対象か＝日付を持つタスクのみ / syncable = the task has at least one date
export function hasDates(t: TaskLike): boolean {
  return !!(t.start ?? t.end);
}

// ローカル内容の指紋。一致すれば API 呼び出しを省く（gcalId 自体は含めない）
// fingerprint of the local content; equal hashes skip the API call (gcalId itself is excluded)
export function taskHash(t: TaskLike, excerpt: string): string {
  const s = JSON.stringify([t.name, t.start, t.end, t.startTime, t.endTime, t.milestone, excerpt]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + s.length.toString(36);
}

// イベントの start/end を組み立てる。PATCH で 終日⇄時刻あり を切り替えられるよう、使わない側は明示的に null
// build the event start/end; the unused variant is an explicit null so PATCH can flip all-day ⇄ timed
export function eventTimes(
  t: TaskLike,
  tz: string
): { start: { date: string | null; dateTime: string | null }; end: { date: string | null; dateTime: string | null } } {
  const allDay = (s: string, e: string) => ({
    start: { date: s, dateTime: null },
    // 終日イベントの end.date は排他的 / the all-day end.date is exclusive
    end: { date: addDays(e, 1), dateTime: null },
  });
  if (t.milestone) {
    const d = (t.end ?? t.start)!;
    const time = t.endTime;
    if (!time) return allDay(d, d);
    const v = rfc3339(d, time, tz);
    return { start: { dateTime: v, date: null }, end: { dateTime: v, date: null } };
  }
  const start = t.start!;
  const end = t.end ?? start;
  // 両端に時刻があるときだけ時刻付き。片側だけの時刻は終日扱い / timed only when both ends have a time
  if (t.startTime && t.endTime) {
    return {
      start: { dateTime: rfc3339(start, t.startTime, tz), date: null },
      end: { dateTime: rfc3339(end, t.endTime, tz), date: null },
    };
  }
  return allDay(start, end);
}

// タスク → イベント本体 / task → event payload
export function buildEvent(t: TaskLike, tz: string, excerpt: string, vaultName: string): object {
  const noExt = t.path.replace(/\.md$/, "");
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(noExt)}`;
  return {
    summary: t.name,
    description: excerpt ? `${excerpt}\n\n${uri}` : uri,
    ...eventTimes(t, tz),
    extendedProperties: { private: { tgVault: vaultName, tgPath: t.path } },
  };
}

// イベント → ローカルの日付・時刻（設定タイムゾーンの表示値）。読めないイベントは null
// event → local dates/times (display values in the configured tz); unparsable events → null
export function fromEvent(
  ev: GEvent,
  tz: string
): { start: string; end: string; startTime?: string; endTime?: string } | null {
  if (ev.start?.date && ev.end?.date) {
    // 終日：排他的 end を内包表現へ戻す / all-day: convert the exclusive end back to inclusive
    const end = addDays(ev.end.date, -1);
    return { start: ev.start.date, end: end < ev.start.date ? ev.start.date : end };
  }
  if (ev.start?.dateTime) {
    const ps = parseStored(ev.start.dateTime, tz);
    const pe = parseStored(ev.end?.dateTime ?? ev.start.dateTime, tz);
    if (!ps || !pe) return null;
    return { start: ps.date, end: pe.date, startTime: ps.time, endTime: pe.time };
  }
  return null;
}
