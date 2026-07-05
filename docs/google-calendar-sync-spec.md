# Google カレンダー双方向同期 仕様書 / Google Calendar Two-Way Sync Specification

日本語 | [English](#english)

> ステータス: 実装済み（未リリース） / Status: implemented (not yet released)
> 対象バージョン: 2.1.0（予定）

## 1. 概要

Task Gantt のタスク（1 Markdown ファイル = 1 タスク）と、ユーザーが選択した 1 つの Google カレンダーを**双方向**に同期する。

- **Push（タスク → GCal）**: 対象タスクの作成・日付変更・削除をイベントとして反映する。
- **Pull（GCal → タスク）**: プラグインが作成したイベントの日時変更・削除をフロントマターへ書き戻す。
- Push / Pull は設定で個別に ON/OFF でき、片方向運用（書き出しのみ / 取り込みのみ）にも縮退できる。

**スコープ外（本バージョンでは扱わない）**: GCal 側で新規作成された予定のタスク化、繰り返しイベント、複数カレンダー同期、モバイル対応。

## 2. 認証（OAuth 2.0）

プラグイン開発者のサーバーは存在しないため、**ユーザー自身の Google Cloud プロジェクト**を使う。

1. ユーザーが GCP で Calendar API を有効化し、OAuth クライアント（デスクトップアプリ型）を作成。クライアント ID / シークレットを設定画面に入力する。
2. 「接続」ボタンで一時的なローカル HTTP サーバー（`http://127.0.0.1:<ランダムポート>`）を起動し、既定ブラウザで同意画面を開く（ループバックフロー、PKCE 併用）。
3. 認可コードをトークンに交換し、リフレッシュトークンを `data.json` に保存する。アクセストークンはメモリ保持し、失効時に自動更新する。

- **スコープ**: `calendar.events`（イベント読み書き）＋ `calendar.calendarlist.readonly`（カレンダー一覧の取得）。フルの `calendar` スコープは要求しない。
- **プラットフォーム**: ローカルサーバーは Electron 前提のため**デスクトップ限定**。`Platform.isDesktop` でガードし、モバイルでは設定 UI に非対応の旨を表示する（`manifest.json` の `isDesktopOnly` は `false` のまま）。
- **開示事項（README）**: ネットワーク通信の内容、リフレッシュトークンが `data.json` に平文保存されること、GCP の「未確認アプリ」警告と自分をテストユーザーに追加する手順。

## 3. データモデルと対応付け

### 3.1 マッピング

| タスク側 | GCal イベント側 |
|---|---|
| ファイル名（拡張子なし） | `summary` |
| `start` / `end`（日付のみ） | 終日イベント（`end.date` は排他的なので +1 日） |
| `start` / `end`（時刻あり） | `dateTime`（設定 `tz` のオフセットを使用） |
| マイルストーン（`end` のみ / `milestone: true`） | 1 日の終日イベント |
| 本文の先頭 500 文字 ＋ `obsidian://open` リンク | `description` |
| `gcalId`（新フロントマターキー、`keys` でリネーム可） | イベント ID（対応付けの主キー） |
| `gcal: true`（オプトインフラグ、同名キー設定可） | —（同期対象の印） |

- イベント側には `extendedProperties.private.taskGantt = "<vault名>|<ファイルパス>"` を付与し、プラグイン管理イベントを識別する（Pull のフィルタにも使用）。パスはリネーム・移動で古くなり得るため参考情報とし、主キーは常に `gcalId` ↔ イベント ID。
- 日付のないタスク・`gcal: true` のないタスク（オプトイン設定時）は同期しない。

### 3.2 同期状態（`data.json` に保存）

```ts
gcal: {
  clientId: string; clientSecret: string;
  refreshToken: string;            // 空なら未接続
  calendarId: string;              // 同期先カレンダー
  pushEnabled: boolean; pullEnabled: boolean;   // 既定: 両方 true
  scopeFolder: string;             // 空なら既定フォルダに従う
  optInOnly: boolean;              // 既定 true（gcal: true のタスクのみ）
  pullIntervalMin: number;         // 既定 5 分
  deleteEventOnTaskDelete: boolean;   // 既定 true
  onEventDeleted: "unlink" | "clearDates";  // 既定 "unlink"（gcalId を外すだけ）
  syncToken: string;               // 増分 Pull 用。無効化時は空に戻す
  state: Record<string, {          // パス → 同期スナップショット
    id: string;                    // イベント ID
    hash: string;                  // 最終同期時のローカル内容ハッシュ（名前+start+end+時刻+本文要約）
    etag: string;                  // 最終同期時のイベント etag
    at: number;                    // 同期時刻 (epoch ms)
  }>;
}
```

## 4. 同期エンジン

### 4.1 トリガー

- **Push**: `metadataCache.on("changed")` ＋ `vault.on("delete" / "rename")` を数秒デバウンスしてキュー処理。既存の 1 分スケジューラでも取りこぼしを掃く。
- **Pull**: `pullIntervalMin` 間隔（既定 5 分）で増分取得。
- **手動**: 設定画面と詳細パネルの「今すぐ同期」ボタン（Push＋Pull を即時実行）。

### 4.2 Push（タスク → GCal）

対象タスクごとに現在のハッシュを `state[path].hash` と比較し、変化があるものだけ API を呼ぶ。

- **作成**: `gcalId` なし → 事前に `privateExtendedProperty` でパス検索して重複がないことを確認してから `events.insert` → 返ってきた ID を即座にフロントマターへ書き込み、`state` を更新。
- **更新**: `gcalId` あり＆ハッシュ変化 → `events.patch`。
- **削除**: ファイル削除・日付削除・オプトイン解除 → `deleteEventOnTaskDelete` に従い `events.delete`（404 は成功扱い）。
- **リネーム/移動**: `gcalId` はフロントマターと一緒に移動するので追従は自動。次回 Push で `summary` と拡張プロパティのパスを更新する。

### 4.3 Pull（GCal → タスク）

- `events.list` を `syncToken` ＋ `privateExtendedProperty=taskGantt...` フィルタで増分取得（フィルタは初回から一貫させる）。`410 Gone` が返ったらトークンを破棄してフル再取得。
- 変更イベント: 対応タスクの `start` / `end`（と時刻）をフロントマターへ書き戻す。タイトル変更はファイルリネームを伴い危険なため**書き戻さない**（次回 Push でタスク側の名前に戻る旨を README に明記）。
- `status: "cancelled"`（削除）: `onEventDeleted` に従う。既定はリンク解除（`gcalId` を外してタスクは残す）。ファイル削除は行わない。

### 4.4 ループ防止と衝突解決

- **ループ防止**: Push 後にレスポンスの `etag` を `state` に記録。Pull で受け取ったイベントの `etag` が記録と一致すれば「自分の書き込みのエコー」としてスキップする。Pull でフロントマターを書き換えた直後に `state.hash` も更新し、Push が再発火しないようにする。
- **衝突（前回同期以降に両側が変化）**: イベントの `updated` とローカル変更の検知時刻を比較し、**新しい方を採用**（last-writer-wins）。敗者側は上書きし、`Notice` で 1 行通知する。

### 4.5 エラー処理

- `401` → トークン更新して 1 回リトライ。更新も失敗したら「再接続が必要」状態にして Notice。
- `403 rateLimitExceeded` / `429` → 指数バックオフ（最大 3 回）。以降は次のティックに持ち越し。
- オフライン → キューを保持して次のティックで再試行。失敗が続いてもガント本体の動作は阻害しない（`notify.ts` と同じ「個別に握る」方針）。
- 多端末（Obsidian Sync 等）: `state` は端末ごとだが、主キー `gcalId` はフロントマター経由で共有されるため update/delete は冪等。create 競合は 4.2 の事前検索で緩和する。

## 5. UI

### 5.1 設定画面（新セクション「Google Calendar」）

クライアント ID / シークレット、接続・切断ボタン（接続状態表示）、カレンダー選択ドロップダウン、Push / Pull トグル、対象フォルダとオプトイン設定、Pull 間隔、削除ポリシー 2 種、「今すぐ同期」＋最終同期時刻とエラー表示。

### 5.2 詳細パネル

- 「Google カレンダーに同期」トグル（`gcal: true` の読み書き）
- 同期済みタスクに「Google カレンダーで開く」リンク（`event.htmlLink`）

### 5.3 i18n

全文言を `i18n.ts` の 8 言語（en/ja/ko/zh-CN/zh-TW/fr/es/ru）に追加する。

## 6. 変更ファイルと規模感

| ファイル | 内容 | 目安 |
|---|---|---|
| `src/gcal/auth.ts`（新規） | ループバック OAuth、トークン保存・更新 | ~200 行 |
| `src/gcal/api.ts`（新規） | `requestUrl` ベースの Calendar REST ラッパー | ~150 行 |
| `src/gcal/sync.ts`（新規） | Push キュー、増分 Pull、衝突解決、ループ防止 | ~400 行 |
| `src/settings.ts` | `gcal` 設定ブロック＋設定 UI | +150 行 |
| `src/i18n.ts` | 8 言語の文言 | +30 キー |
| `src/view.ts` | 詳細パネルのトグルとリンク | +60 行 |
| `src/main.ts` | スケジューラ組み込み、イベント購読 | +30 行 |
| `src/model.ts` | `gcalId` / `gcal` キーの読み書き | +20 行 |
| `README.md` | セットアップ手順（GCP 図解）と開示事項 | — |

依存パッケージの追加はなし（OAuth・REST とも `requestUrl` と Node 標準 `http` で実装）。

## 7. マイルストーン

1. **M1 認証**: OAuth ループバック＋設定 UI（接続・カレンダー選択）
2. **M2 Push**: 作成・更新・削除、詳細パネルのトグル
3. **M3 Pull**: syncToken 増分取得、衝突解決、ループ防止
4. **M4 仕上げ**: i18n、README、エッジケース（多端末・オフライン）、リリース 2.1.0

## 8. テスト計画

- `test/` にユニットテスト: マッピング（終日 +1 日、時刻＋tz、マイルストーン）、ハッシュ差分判定、衝突解決の勝敗、etag エコー判定。
- 手動テストマトリクス: 作成/更新/削除 × Push/Pull × 日付のみ/時刻あり、syncToken 失効（410）、トークン失効、オフライン復帰。

---

# English

Planned specification for two-way sync between Task Gantt tasks (one Markdown file = one task) and a single user-selected Google Calendar.

- **Push (task → GCal)**: create / update / delete events when in-scope tasks change. **Pull (GCal → task)**: write date/time changes and deletions of plugin-created events back to frontmatter. Each direction can be toggled independently. Out of scope: importing foreign GCal events as tasks, recurring events, multiple calendars, mobile.
- **Auth**: user's own Google Cloud OAuth client (desktop-app type) with a loopback redirect (`http://127.0.0.1:<random port>`, PKCE). Refresh token stored in `data.json` (disclosed in README). Scopes: `calendar.events` + `calendar.calendarlist.readonly`. Desktop-only, guarded by `Platform.isDesktop`.
- **Mapping**: file name → `summary`; date-only → all-day event (exclusive end +1 day); timed → `dateTime` with the plugin's `tz` offset; milestone → one-day all-day event; body excerpt + `obsidian://` link → `description`. The event ID is stored in a new `gcalId` frontmatter key (renamable via `keys`); events carry `extendedProperties.private.taskGantt = "<vault>|<path>"` for identification and pull filtering. Opt-in per task via `gcal: true` (default) or sync the whole scope folder.
- **Engine**: push is triggered by debounced `metadataCache`/vault events plus the existing 1-minute scheduler, with a per-path snapshot (`{id, hash, etag, at}`) so unchanged tasks make no API calls; pull runs every N minutes (default 5) via `events.list` with `syncToken` + `privateExtendedProperty` filter, falling back to a full re-list on `410 Gone`. Titles are never renamed from the GCal side. Event deletion unlinks the task by default (never deletes files).
- **Loop prevention**: pushed etags are recorded and matching pull results are skipped as echoes; pulled writes refresh the local hash so push doesn't re-fire. **Conflicts**: last-writer-wins by comparing the event's `updated` with the local change time, with a Notice.
- **Errors**: 401 → refresh once then mark "reconnect needed"; 403/429 → exponential backoff; offline → retry next tick. Sync failures never block the Gantt itself.
- **New files**: `src/gcal/auth.ts`, `src/gcal/api.ts`, `src/gcal/sync.ts`; additions to settings, i18n (8 languages), detail panel, scheduler, README. No new dependencies.
- **Milestones**: M1 auth → M2 push → M3 pull/conflicts → M4 polish & release 2.1.0. Unit tests for mapping, diffing, conflict and echo logic; manual matrix for token/syncToken expiry and offline recovery.
