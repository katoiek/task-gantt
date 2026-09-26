// Google 連携の秘匿情報（クライアントシークレット・リフレッシュトークン）の保管
// storage for the Google secrets (client secret + refresh token)
// data.json は同期・バックアップ・git に載りやすいので、Obsidian の SecretStorage（OS キーチェーン）に置く。
// SecretStorage は端末ごとの保存なので、別端末では再接続が必要になる。
// data.json travels through sync, backups and git, so these live in Obsidian's SecretStorage (the OS keychain).
// SecretStorage is per device, so each device has to connect on its own.

import type GanttPlugin from "../main";

// SecretStorage の ID（小文字英数字とダッシュのみ）/ SecretStorage ids (lowercase alphanumerics and dashes only)
const ID_CLIENT_SECRET = "task-gantt-gcal-client-secret";
const ID_REFRESH_TOKEN = "task-gantt-gcal-refresh-token";

// 旧バージョンが data.json に平文で置いていたフィールド / fields older versions kept in plain text in data.json
type LegacyGcal = { clientSecret?: string; refreshToken?: string };

function read(plugin: GanttPlugin, id: string, legacy: string | undefined): string {
  try {
    const v = plugin.app.secretStorage.getSecret(id);
    if (v) return v;
  } catch (e) {
    console.error("Task Gantt: failed to read secret", id, e);
  }
  // 移行に失敗した場合だけ旧フィールドが残っている / the legacy field only survives a failed migration
  return legacy ?? "";
}

// 削除 API は無いので空文字で上書きして消す / there is no delete API, so clearing writes an empty string
function write(plugin: GanttPlugin, id: string, value: string): void {
  plugin.app.secretStorage.setSecret(id, value);
}

export function getClientSecret(plugin: GanttPlugin): string {
  return read(plugin, ID_CLIENT_SECRET, (plugin.settings.gcal as LegacyGcal).clientSecret);
}

export function setClientSecret(plugin: GanttPlugin, value: string): void {
  write(plugin, ID_CLIENT_SECRET, value);
}

export function getRefreshToken(plugin: GanttPlugin): string {
  return read(plugin, ID_REFRESH_TOKEN, (plugin.settings.gcal as LegacyGcal).refreshToken);
}

export function setRefreshToken(plugin: GanttPlugin, value: string): void {
  write(plugin, ID_REFRESH_TOKEN, value);
}

// data.json の平文を SecretStorage へ移し、data.json 側から消す。移した場合は true（呼び出し側で保存する）
// move plain-text values from data.json into SecretStorage and drop them there; true when anything moved (caller saves)
export function migrateLegacySecrets(plugin: GanttPlugin): boolean {
  const g = plugin.settings.gcal as LegacyGcal;
  let moved = false;
  const pairs: [keyof LegacyGcal, string][] = [
    ["clientSecret", ID_CLIENT_SECRET],
    ["refreshToken", ID_REFRESH_TOKEN],
  ];
  for (const [key, id] of pairs) {
    if (!(key in g)) continue;
    const v = g[key];
    try {
      if (v) write(plugin, id, v);
      delete g[key];
      moved = true;
    } catch (e) {
      // 書けなければ平文を残す（接続が切れるよりまし）/ keep the plain text if the write fails (better than losing the connection)
      console.error("Task Gantt: failed to move secret to SecretStorage", key, e);
    }
  }
  return moved;
}
