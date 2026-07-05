// Google Calendar REST API の薄いラッパー（requestUrl ベース・依存追加なし）
// a thin Google Calendar REST wrapper on top of requestUrl (no extra dependencies)

import { requestUrl } from "obsidian";
import type GanttPlugin from "../main";
import { getAccessToken } from "./auth";

const BASE = "https://www.googleapis.com/calendar/v3";

// API エラー（HTTP ステータス付き）/ API error carrying the HTTP status
export class GcalApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// イベントリソース（使用フィールドのみ）/ event resource (only the fields we use)
export interface GEvent {
  id: string;
  status?: string;
  etag?: string;
  updated?: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  recurrence?: string[];
  recurringEventId?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface GEventList {
  items?: GEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

// クエリを URL へ（配列は同名パラメータの繰り返し）/ build the query string (arrays repeat the parameter)
function buildUrl(path: string, query?: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
  }
  const qs = p.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
}

// 認証付き呼び出し。401 は一度だけトークンを強制更新してリトライ
// authenticated call; on 401, force-refresh the token and retry once
async function call<T>(
  plugin: GanttPlugin,
  method: string,
  path: string,
  opts: { query?: Record<string, string | string[] | undefined>; body?: unknown } = {}
): Promise<T> {
  const url = buildUrl(path, opts.query);
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(plugin, attempt > 0);
    const res = await requestUrl({
      url,
      method,
      throw: false,
      headers: { Authorization: `Bearer ${token}` },
      ...(opts.body !== undefined
        ? { contentType: "application/json", body: JSON.stringify(opts.body) }
        : {}),
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status >= 400) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = res.json as { error?: { message?: string } };
        if (j.error?.message) msg += `: ${j.error.message}`;
      } catch {
        /* 本文なし / no body */
      }
      throw new GcalApiError(res.status, `Google Calendar: ${method} ${path} → ${msg}`);
    }
    if (res.status === 204 || !res.text) return undefined as T;
    return res.json as T;
  }
}

// 書き込み可能なカレンダー一覧 / writable calendars
export async function listCalendars(plugin: GanttPlugin): Promise<{ id: string; summary: string; primary?: boolean }[]> {
  const res = await call<{ items?: { id: string; summary: string; primary?: boolean }[] }>(
    plugin,
    "GET",
    "/users/me/calendarList",
    { query: { minAccessRole: "writer" } }
  );
  return res.items ?? [];
}

export async function insertEvent(plugin: GanttPlugin, calendarId: string, event: object): Promise<GEvent> {
  return call<GEvent>(plugin, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body: event });
}

export async function patchEvent(
  plugin: GanttPlugin,
  calendarId: string,
  eventId: string,
  event: object
): Promise<GEvent> {
  return call<GEvent>(
    plugin,
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: event }
  );
}

// 削除。既に消えている（404/410）は成功扱い / delete; already-gone (404/410) counts as success
export async function deleteEvent(plugin: GanttPlugin, calendarId: string, eventId: string): Promise<void> {
  try {
    await call<void>(
      plugin,
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  } catch (e) {
    if (e instanceof GcalApiError && (e.status === 404 || e.status === 410)) return;
    throw e;
  }
}

export async function listEvents(
  plugin: GanttPlugin,
  calendarId: string,
  query: Record<string, string | string[] | undefined>
): Promise<GEventList> {
  return call<GEventList>(plugin, "GET", `/calendars/${encodeURIComponent(calendarId)}/events`, { query });
}
