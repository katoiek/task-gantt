# Google Tasks 双方向同期 仕様書 / Google Tasks Two-Way Sync Specification

日本語 | [English](#english)

> ステータス: 計画中（未実装） / Status: planned (not implemented)
> 対象バージョン: 未定 / Target version: not set
>
> 2026-09-27 改訂: M1（認証）の試作ブランチ `worktree-gtasks-m1-auth` は、クライアントシークレットとリフレッシュトークンを `data.json` に平文で保存しており、2.10.1（Issue #6）で Google カレンダー側を SecretStorage へ移した方針と食い違うため破棄した。本仕様書も SecretStorage 前提に改めた。実装時は `src/gcal/secrets.ts` と同じ方式を使うこと。
> Revised 2026-09-27: the M1 (auth) prototype branch `worktree-gtasks-m1-auth` kept the client secret and refresh token in plain text in `data.json`, at odds with 2.10.1 (issue #6), which moved the Google Calendar ones into SecretStorage, so it was discarded. This spec now assumes SecretStorage; implement it the way `src/gcal/secrets.ts` does.

## 1. 概要

Task Gantt の Task（1 Markdown ファイル = 1 Task）と、ユーザーが選択した 1 つの Google Tasks **タスクリスト**を**双方向**に同期する。既存の Google カレンダー同期（`docs/google-calendar-sync-spec.md`）とは**独立したモジュール**として実装し、設定・認証・同期状態を一切共有しない。

- **Push（Task → Google Tasks）**: 対象 Task の作成・期日変更・完了/未完了・削除を Google Task として反映する。
- **Pull（Google Tasks → Task）**: プラグインが作成した Google Task の期日変更・完了状態の変化・削除をフロントマターへ書き戻す。
- Push / Pull は設定で個別に ON/OFF でき、片方向運用にも縮退できる。

**独立モジュールにする理由**: 本プラグインは「機能ごとに独立モジュール（`notify.ts` / `gcal/`）」という構成を採っており、既存の Google カレンダー利用者に設定移行やトークン再取得のリスクを与えないため、`src/gtasks/` を新設して並列に置く。ユーザーは同じ GCP OAuth クライアントの Client ID / Client Secret を両方の入力欄に貼り付ければ使い回せるので、追加コストは実質「同意画面をもう一度通すこと」だけになる。

**スコープ外（本バージョンでは扱わない）**: Google Tasks 側で新規作成されたタスクの Task 化、複数タスクリストの同期、Subtask（親子）階層の同期、Dependency（`after`）の同期、繰り返しタスク、開始日（`start`）の同期、モバイル対応。

## 2. 認証（OAuth 2.0）

プラグイン開発者のサーバーは存在しないため、**ユーザー自身の Google Cloud プロジェクト**を使う（gcal と同じ方式・同じコード構造）。

1. ユーザーが GCP で Tasks API を有効化し、OAuth クライアント（デスクトップアプリ型）を作成。クライアント ID / シークレットを設定画面の **Google Tasks** セクションに入力する（gcal の入力欄とは別）。
2. 「接続」ボタンで一時的なローカル HTTP サーバー（`http://127.0.0.1:<ランダムポート>/callback`）を起動し、既定ブラウザで同意画面を開く（ループバックフロー、PKCE S256 併用、state 検証、3 分でタイムアウト）。
3. 認可コードをトークンに交換し、リフレッシュトークンを **SecretStorage** に保存する（クライアントシークレットも同様。`data.json` には置かない。`src/gcal/secrets.ts` と同じ方式）。アクセストークンはメモリ保持のみで、失効時に自動更新する（`access_type=offline` ＋ `prompt=consent`）。

- **スコープ**: `https://www.googleapis.com/auth/tasks` のみ。Google Tasks API にはカレンダーの `calendar.calendarlist.readonly` に相当する読み取り専用スコープが存在せず、**タスクリスト一覧の取得にも同じフルスコープが必要**なため、スコープの絞り込みはできない。この点は README にも明記する（gcal より広い権限を求める理由の説明）。
- **プラットフォーム**: ループバックサーバーは Electron 前提のため**デスクトップ限定**。`Platform.isDesktop` でガードし、モバイルでは設定 UI に非対応の旨だけを表示する（`manifest.json` の `isDesktopOnly` は `false` のまま）。
- **接続失敗時**: Google が返した `error_description` / `error` をそのまま Notice に出し、`lastError` にも残す（`redirect_uri_mismatch` と `invalid_client` では対処が全く違うため、汎用メッセージだけではコンソールを開かないと切り分けられない）。
- **切断**: リフレッシュトークンを revoke（ベストエフォート）し、SecretStorage のリフレッシュトークンと `state` / `lastPullAt` / `lastError` をクリアする。
- **開示事項（README）**: ネットワーク通信の内容、クライアントシークレットとリフレッシュトークンは SecretStorage に保存され `data.json` には残らないこと、`tasks` スコープが読み書き両方を含むこと、GCP の「未確認アプリ」警告と自分をテストユーザーに追加する手順。

## 3. データモデルと対応付け

用語は `CONTEXT.md` に従う。混同を避けるため、本書では本プラグイン側を **Task**、リモート側を **Google Task**、同期先のリストを **タスクリスト**と書く。

### 3.1 マッピング

| Task 側 | Google Task 側 |
|---|---|
| ファイル名（拡張子なし） | `title` |
| `end ?? start`（**日付のみ**） | `due` |
| 本文の先頭 500 文字 ＋ `obsidian://open` リンク | `notes` |
| Status の Status group（完了 / それ以外） | `status`（`completed` / `needsAction`）＋ `completed` |
| `gtasksId`（新フロントマターキー、`keys` でリネーム可） | Google Task の `id`（対応付けの主キー） |
| `gtasks: true`（オプトインフラグ、同名キー設定可） | —（同期対象の印） |

**日付についての明示的な制約**:

- Google Tasks の `due` は RFC3339 で受け渡すが、**Google 側は日付部分しか保持せず、常に UTC 深夜として保存される**。したがって `startTime` / `endTime`（時刻）は同期に使わない。Push は `YYYY-MM-DDT00:00:00.000Z` の形で送る。
- **`start`（開始日）は同期されない**。Google Tasks に開始日の表現先が無いため。範囲を持つ Task では `end`（期限）だけが `due` として片道の意味を持ち、`end` が無い Task は `start` を期日として送る（`end ?? start`）。Pull で `due` が変わっても `start` は一切書き換えない。
- 日付を 1 つも持たない Task、`gtasks: true` の無い Task（オプトイン設定時）は同期対象外。
- **`due` を空へ戻す操作は行わない**。期日が消えた Task は「同期対象外になった」として削除ポリシー（4.2）に委ねる。`due: null` の扱いは API 実装差が大きく、中途半端に空の Google Task が残ると次の Pull で挙動が読めなくなるため。

**識別についての gcal との重要な差分**:

- Google Tasks の Task リソースには gcal の `extendedProperties.private` に相当する**任意のメタデータ領域が無い**。したがって「この Google Task はどの Vault のどのパスに対応するか」をリモート側に構造化して持たせられない。
- 代替として `notes` の末尾に `obsidian://open?vault=<Vault 名>&file=<パス>` を 1 行付ける。これは人間向けのリンクであると同時に、Pull 時の**取り込み（adopt）判定**にも使う（4.3）。
- ただし `tasks.list` にはメタデータでの**サーバー側フィルタが無い**ため、gcal の `privateExtendedProperty` 検索による「作成直前の重複チェック」は実現できない。多端末での二重作成は Pull 側の取り込みで解消する（4.3・4.4）。
- 主キーは常に `gtasksId` ↔ Google Task の `id`。`notes` 内のパスはリネーム・移動で古くなり得るため参考情報とする。

### 3.2 同期状態（`data.json` に保存。秘匿情報は除く）

```ts
gtasks: {
  clientId: string;
  // clientSecret / refreshToken は SecretStorage に保存し、ここには置かない（2.10.1 以降の方針）
  // clientSecret / refreshToken live in SecretStorage, never here (the policy since 2.10.1)
  taskListId: string;              // 同期先タスクリスト
  taskListName: string;            // 表示用
  pushEnabled: boolean; pullEnabled: boolean;   // 既定: 両方 true
  scopeFolder: string;             // 空なら既定フォルダに従う
  optInOnly: boolean;              // 既定 true（gtasks: true の Task のみ）
  pullIntervalMin: number;         // 既定 5 分
  deleteRemoteOnTaskDelete: boolean;         // 既定 true
  onRemoteDeleted: "unlink" | "clearDates";  // 既定 "unlink"（gtasksId を外すだけ）
  statusSyncEnabled: boolean;      // 既定 true（ステータス往復の ON/OFF）
  completedStatus: string;         // 既定の完了ステータス（Completed group の Status id）
  reopenStatus: string;            // 既定の再開ステータス（Completed 以外の Status id）
  lastPullAt: number;              // 差分 Pull の基準時刻 (epoch ms)。gcal の syncToken に相当
  lastSync: number;                // 最終成功時刻 (epoch ms)
  lastError: string;               // 直近のエラー（設定画面に表示）
  state: Record<string, {          // パス → 同期スナップショット
    id: string;                    // Google Task の id
    hash: string;                  // 最終同期時のローカル内容ハッシュ（名前+期日+完了+本文要約）
    etag: string;                  // 最終同期時の Google Task の etag（エコー判定）
    done: boolean;                 // 最終同期時のリモート完了状態（ステータス往復の基準）
    at: number;                    // 同期時刻 (epoch ms)
    link?: string;                 // Google Task の webViewLink（保持のみ・5.2 参照）
  }>;
}
```

フロントマターキー名の設定（`keys`）に `gtasksId` / `gtasks` を追加する（既定値は同名）。`loadSettings()` では gcal と同じく既定値とのマージ＋`state` の浅いコピーを行う。

## 4. 同期エンジン

### 4.1 トリガー

- **Push**: `metadataCache.on("changed")` ＋ `vault.on("delete" / "rename")` を 5 秒デバウンスしてキュー処理（gcal の `schedulePush` と同型で、両モジュールが同じイベントから独立に予約される）。
- **Pull**: `pullIntervalMin` 間隔（既定 5 分）で差分取得。既存の 1 分スケジューラの中で `lastGtasksPull` を見て判定する（gcal の `lastGcalPull` と並列）。
- **手動**: 設定画面の「今すぐ同期」ボタンと、コマンド `Google Tasks: 今すぐ同期`（Push＋Pull を即時実行）。
- 実行中ガード（`running` / `rerun`）は gcal と同型。同期に失敗しても Board 本体の描画・編集は一切阻害しない。

### 4.2 Push（Task → Google Tasks）

対象 Task ごとに現在のハッシュを `state[path].hash` と比較し、変化があるものだけ API を呼ぶ。ハッシュには **名前・期日（`end ?? start` の日付）・完了かどうか・本文抜粋**を含める。`start` 単独の変更や時刻（`startTime` / `endTime`）の変更ではハッシュが変わらず、API 呼び出しも発生しない（3.1 の制約の裏返し）。

- **作成**: `gtasksId` なし → Google Task を新規作成 → 返ってきた `id` を即座にフロントマターへ書き込み、`state` を更新する。gcal と違い作成前のサーバー側重複検索はできない（3.1）ため、重複は Pull 側の取り込みで検出・解消する。
- **更新**: `gtasksId` あり＆ハッシュ変化 → 部分更新。リモートが 404 / 410（手動削除済み）なら作り直す。
- **完了/未完了**: 4.6 のルールに従って `status` と `completed` を同時に送る。
- **削除**: ファイル削除・期日削除・オプトイン解除・スコープ外への移動 → `deleteRemoteOnTaskDelete` に従って Google Task を削除（404 / 410 は成功扱い）。ファイル削除以外（スコープ外・オプトアウト・期日削除）は設定に関わらず必ずリモートから外す。ファイルが残っている場合は `gtasksId` も外す。
- **リネーム/移動**: `gtasksId` はフロントマターと一緒に移動するので追従は自動。`state` のキーを付け替え、ハッシュを空にして次の Push で `title` と `notes` 内のパスを更新する。

### 4.3 Pull（Google Tasks → Task）※ gcal と根本的に異なる箇所

**Google Tasks API の `tasks.list` には、カレンダーの `syncToken` / `nextSyncToken` に相当する増分同期の仕組みが無い。** gcal の実装（`syncToken` を保存し、`410 Gone` でフル再取得へフォールバックする）を**そのまま移植してはならない**。代わりに次の方式を採る。

- 毎回のリクエストに以下を付けて「前回 Pull 以降に変化した全 Google Task」を取得する。
  - `updatedMin` = `lastPullAt` から安全マージン（60 秒）を引いた時刻の RFC3339 表現。端末とサーバーの時計ずれ・境界の取りこぼしを避けるため、意図的に少し過去へ倒す。重複して取得しても etag のエコー判定とハッシュ比較で無害。
  - `showCompleted=true` ＋ `showHidden=true`：Google Tasks では完了操作をしたタスクが `hidden` になり、`showHidden` を付けないと一覧から落ちる。完了の往復（4.6）を成立させるために両方必須。
  - `showDeleted=true`：削除済みは `deleted: true` のフラグ付きで返る（gcal の `status: "cancelled"` に相当）。
  - `maxResults=100`（Tasks API の 1 ページ上限）＋ `pageToken` で全ページを走査する。gcal の 250 件とは上限が違う点に注意。
- **初回**（`lastPullAt` が 0）は `updatedMin` を付けずにタスクリスト全件を取得し、既存の Google Task を取り込む機会にする。
- 全ページを取り切った時点で `lastPullAt` を**リクエスト開始時刻**へ更新する（応答完了時刻にすると、その間の変更を落とす）。エラーで途中終了した場合は更新しない。
- タスクリストを切り替えたとき、および切断時は `lastPullAt = 0` ＋ `state = {}` にリセットする。

取得した各 Google Task の処理:

1. `state` の `id` 逆引きで対応パスを求める。見つからない場合は `notes` 内の `obsidian://open?vault=<この Vault>&file=<パス>` を読み、そのパスに Task が実在して同期スコープ内なら**取り込む（adopt）**。取り込みでは `state` エントリを作り、フロントマターへ `gtasksId` を書き込む。これが多端末での二重作成と「他端末が作った紐付け」を解消する唯一の経路になる（gcal の作成前検索の代わり）。
2. `deleted: true` → `onRemoteDeleted` に従う。既定はリンク解除（`gtasksId` を外して Task 自体は残す）。ファイル削除は行わない。
3. `etag` が `state[path].etag` と一致 → 自分の書き込みのエコーとしてスキップ（4.4）。
4. `due` が変化していれば `end` フロントマターへ書き戻す。ローカルに時刻（`endTime`）がある場合は**時刻を保持したまま日付だけ差し替える**（Google 側は時刻を持たないので、時刻を消すと片側だけの情報が毎回失われるため）。`start` は書き換えない。
5. `status` が前回同期時点（`state[path].done`）から変化していれば 4.6 に従って Status を書き換える。
6. `title` は**書き戻さない**（ファイルリネームを伴い危険）。リモート側で名前が変わっていたらハッシュを空にして、次の Push で Task 名に戻す（README に明記）。
7. リモートに `due` が無くなっていた場合はローカルの日付を消さず、ハッシュを空にして次の Push で期日を復元する（破壊的な方向へは倒さない）。

Pull で書き換えたパスの集合は、同じティックの Push から除外する（`metadataCache` が古いままの可能性があるため次のティックへ回す）。

### 4.4 ループ防止と衝突解決

- **ループ防止**: Push 後にレスポンスの `etag` を `state` に記録し、Pull で受け取った Google Task の `etag` が記録と一致すれば「自分の書き込みのエコー」としてスキップする。Pull でフロントマターを書き換えた直後に `state.hash` と `state.done` も更新し、Push が再発火しないようにする。
- **衝突（前回同期以降に両側が変化）**: Google Task の `updated` とローカルファイルの mtime を比較し、**新しい方を採用**（last-writer-wins）。敗者側は上書きし、`Notice` で 1 行通知する。期日とステータスを個別にマージすることはしない（フィールド単位の混合マージは利用者から結果を予測できないため、Task 単位で勝敗を決める）。
- **重複の解消**: 同一パスに対して複数の Google Task が存在してしまった場合（多端末での同時作成）、`state` に載っている `id` を正とし、取り込み時に別 `id` の Google Task を見つけたら**後から取り込んだ方を削除**して 1 対 1 に戻す。削除は `deleteRemoteOnTaskDelete` の設定に関わらず行う（重複はユーザーの意図ではないため）。

### 4.5 エラー処理

- `401` → トークンを強制更新して 1 回だけリトライ。更新も失敗（`invalid_grant`）したら接続情報を落とし、「再接続が必要」として設定画面と Notice に出す。
- `403 rateLimitExceeded` / `429` → 指数バックオフ（最大 3 回）。以降は次のティックへ持ち越す。
- `400`（不正な `due` など）→ 該当 Task だけスキップして `lastError` に残し、他の Task の同期は続行する。
- オフライン → キューを保持して次のティックで再試行。失敗が続いても Board の動作は阻害しない（`notify.ts` と同じ「個別に握る」方針）。
- 多端末（Obsidian Sync 等）: `state` は端末ごとだが、主キー `gtasksId` はフロントマター経由で共有されるため update / delete は冪等。create 競合は 4.3 の取り込みと 4.4 の重複解消で収束させる。
- gcal と Google Tasks の両方に同期している Task では、片側の Pull による書き戻しがもう片側の Push を誘発し得る。両者ともハッシュ比較で 1 往復に収束するため無限ループにはならないが、エッジケースとして M5 の手動テスト項目に含める。

### 4.6 ステータスの往復

Google Tasks の状態は `needsAction` / `completed` の**2 値しかない**。一方、本プラグインの Status はユーザー定義で、それぞれが固定 4 分類の Status group（アクティブ / 完了 / 延期 / キャンセル）に属する（`CONTEXT.md`）。この非対称を次のように解く。

**Push（Task → Google Tasks）**

- Task の Status が属する Status group が **完了** → `status: "completed"` ＋ `completed`（完了日時）を送る。`completed` には Push 実行時刻を入れる（Google 側の完了日時は「いつ完了操作をしたか」であり、期日とは別概念のため、`end` は使わない）。
- **それ以外のすべての group（アクティブ / 延期 / キャンセル）と、Status 未設定・設定に無い Status id** → `status: "needsAction"` ＋ `completed` を明示的に空にする。
  - キャンセルを `completed` に倒さない理由: Google Tasks 上で「完了した」と読めてしまい、事実と食い違うため。中止という概念はローカルの真実に留める。
- 完了 / 未完了の判定は **Status group だけ**を根拠にし、Status の id やラベルからは推測しない（`CONTEXT.md` の規約）。

**Pull（Google Tasks → Task）**

- リモートの `status` を `state[path].done`（前回同期時点の完了状態）と比較し、**変化していた場合にのみ**ローカルの Status フィールド（Status group ではなく、実際の Status 値）を書き換える。変化していなければ Status には一切触れない（ユーザーが Completed group 内で選び分けた具体的な Status を、同期のたびに潰さないため）。
  - 未完了 → 完了 に変化 → `keys.status` を **`completedStatus`（既定の完了ステータス）** に書き換える。
  - 完了 → 未完了 に変化 → `keys.status` を **`reopenStatus`（既定の再開ステータス）** に書き換える。
- `statusSyncEnabled` が false のときは書き換えを行わず、`state[path].done` の記録だけ更新する（次に true へ戻したとき、過去の変化がまとめて適用されないようにするため）。
- 設定の既定値: `completedStatus` は Completed group の最初の Status、`reopenStatus` は Completed 以外の最初の Status。設定済みの Status id が Status 定義から消えていた場合は同じ規則でフォールバックし、設定画面に注意書きを出す。Completed group の Status が 1 つも定義されていない場合はステータス往復を自動的に無効化し、その旨を設定画面に表示する。

## 5. UI

### 5.1 設定画面（新セクション「Google Tasks」）

既存の「Google Calendar」セクションの直後に、同じ並び・同じ構造で追加する。行ごとに `ctlGtasks*` ヘルパーを用意し、`display()` と `getSettingDefinitions()` の両経路で共有する（gcal と同じく二重管理によるズレを防ぐ）。モバイルでは見出しと非対応の案内だけを出し、未接続時は認証情報より下の行を描かない。

| 行 | 内容 |
|---|---|
| クライアント ID / クライアントシークレット | シークレットは伏せ字入力 |
| アカウント | 接続 / 切断ボタン＋接続状態 |
| タスクリスト | `tasklists.list` の一覧から選択（非同期で差し込む）。変更で `state` と `lastPullAt` をリセット |
| Push / Pull | 各トグル |
| オプトイン | `gtasks: true` のある Task だけ同期するトグル |
| 対象フォルダ | 空欄で既定フォルダ |
| Pull 間隔 | 1 / 5 / 10 / 30 / 60 分 |
| Task 削除時にリモートも削除 | トグル |
| リモート削除時の挙動 | リンク解除 / 日付もクリア |
| ステータスを同期 | トグル（既定 ON） |
| 既定の完了ステータス | Completed group の Status から選択 |
| 既定の再開ステータス | Completed group 以外の Status から選択 |
| 今すぐ同期 | ボタン＋最終同期時刻 / 直近のエラー表示 |

### 5.2 詳細パネル

- 「Google Tasks に同期」トグル（`gtasks: true` の読み書き）。接続済み＆タスクリスト選択済みのときだけ表示し、オプトイン設定が OFF のときは操作不可の表示にする（gcal のトグルと同じ挙動）。
- **「ブラウザで開く」リンクは持たせない**（gcal との差分）。当初の想定「Google Tasks には `htmlLink` 相当が無い」は API 仕様を確認した結果**誤り**で、Task リソースには `webViewLink`（output only、Google Tasks Web UI への絶対リンク）が存在する。ただし v1 のスコープでは詳細パネルに導線を増やさない方針を維持し、値は `state[path].link` に保持するだけに留める。UI へ出す場合は M5 以降の任意項目として扱い、`webViewLink` が空の Google Task では汎用の `https://tasks.google.com/` へのリンクに縮退させる。

### 5.3 i18n

全文言を `i18n.ts` の 8 言語（en / ja / ko / zh-CN / zh-TW / fr / es / ru）に追加する。gcal の 32 キーに対し、タスクリスト選択・ステータス往復 3 行・スコープ注意書きが増えて「ブラウザで開く」が減るため、およそ 34 キー。既存の gcal キーは流用せず、`gtasks*` の独立キーとして定義する（文言の差分が出せなくなるため）。

## 6. 変更ファイルと規模感

現行コードベース（2.9.1）の実サイズを踏まえた見積もり。括弧内は現在の行数。

| ファイル | 内容 | 目安 |
|---|---|---|
| `src/gtasks/auth.ts`（新規） | ループバック OAuth、トークン保存・更新・切断 | ~210 行（`gcal/auth.ts` は 243 行。ほぼ同型で、差はスコープと文言） |
| `src/gtasks/api.ts`（新規） | `requestUrl` ベースの Tasks REST ラッパー（`tasklists.list` / `tasks.list` / `insert` / `patch` / `delete`） | ~140 行（`gcal/api.ts` は 134 行） |
| `src/gtasks/map.ts`（新規） | 期日・`notes`・完了状態の純粋な変換とハッシュ、ステータス往復の分岐 | ~130 行（`gcal/map.ts` は 104 行） |
| `src/gtasks/sync.ts`（新規） | Push キュー、`updatedMin` 差分 Pull、取り込み、衝突解決、ループ防止 | ~380 行（`gcal/sync.ts` は 335 行。取り込みとステータス往復の分だけ増える） |
| `src/settings.ts`（911 行） | `gtasks` 設定ブロック、`ctlGtasks*` 13 行分、`drawGtasks`、`getSettingDefinitions` への追加 | +約 200 行 |
| `src/i18n.ts`（1868 行） | 8 言語 × 約 34 キー | +約 310 行 |
| `src/view.ts`（2881 行） | 詳細パネルのトグル（リンクなしのため gcal より小さい） | +約 40 行 |
| `src/main.ts`（165 行） | スケジューラ分岐（`lastGtasksPull`）、コマンド登録、`loadSettings` のマージ | +約 25 行 |
| `test/gtasks.test.mjs`（新規） | `src/gtasks/map.ts` の単体テスト | ~150 行 |
| `package.json` | `test` スクリプトへビルド 1 本と実行 1 本を追記 | +2 コマンド |
| `README.md` | セットアップ手順（GCP・Tasks API 有効化）と開示事項、`start` と時刻が同期されない旨 | — |

`src/types.ts` は変更なし（設定型は gcal と同じく `settings.ts` に置く）。依存パッケージの追加もなし（OAuth・REST とも `requestUrl` と Node 標準 `http` のみ）。

## 7. マイルストーン

1. **M1 認証**: `gtasks/auth.ts` ＋ `gtasks/api.ts` の `tasklists.list`、設定 UI の接続・切断・タスクリスト選択まで。
2. **M2 Push**: 作成・更新・削除、`gtasksId` の書き込み、詳細パネルのトグル、ハッシュによる差分抑止。
3. **M3 Pull / 衝突解決**: `updatedMin` 方式の差分取得、`deleted` の処理、取り込み（adopt）、etag エコー判定、last-writer-wins。
4. **M4 ステータス往復・設定 UI**: 4.6 の Push / Pull 分岐、既定の完了 / 再開ステータスの設定行、`statusSyncEnabled`。
5. **M5 仕上げ**: i18n 8 言語、README（開示事項・制約の明記）、エッジケース（多端末・オフライン・gcal との併用・タスクリスト切替）、次のマイナーリリース。

Subtask 階層（`parent` / `position` / `move`）の同期は**今後のマイルストーン（未着手）**として据え置く。Google Tasks の並び替え API は不透明な辞書順の `position` 文字列と「直前の兄弟 ID」を明示する `move` エンドポイントに依存し、期日・タイトルの同期に比べてリスクとコストが大きいため、v1 は flat とする。

## 8. テスト計画

`package.json` の `test` スクリプトに、`src/gtasks/map.ts` を esbuild で `test/gtasks-map.mjs` へバンドルするステップと `node test/gtasks.test.mjs` の実行を追記する（`obsidian` は既存の `test/obsidian-stub.mjs` にエイリアス）。副作用のある `sync.ts` ではなく、純粋関数を集めた `map.ts` を対象にするのは gcal と同じ方針。

単体テスト（`test/gtasks.test.mjs`）:

- **期日マッピング**: `end ?? start` の選択、`end` のみ / `start` のみ、時刻付きの値から時刻が落ちること、送信形が UTC 深夜であること。
- **同期対象判定**: 日付なし Task が対象外になること。
- **`notes` 構築**: 本文抜粋が先頭で、`obsidian://open?vault=...&file=...` が付くこと、500 文字で切られること。
- **ハッシュ差分**: 名前・期日・完了状態・本文で変わること、`start`（`end` があるとき）や `startTime` / `endTime` の変更では**変わらない**こと。
- **完了マッピング（Push）**: Completed group → `completed` ＋ 完了日時、アクティブ / 延期 / **キャンセル** / 未設定 / 未知の id → `needsAction` ＋ 完了日時なし。
- **ステータス往復（Pull）**: `done` 不変 → Status を書き換えない、false→true → `completedStatus`、true→false → `reopenStatus`、設定値が空 / 存在しない id のときのフォールバック、Completed group が未定義のときの無効化。
- **衝突勝敗**: `updated` と mtime の比較（ローカル勝ち / リモート勝ち / 同時刻）。
- **echo 判定**: `etag` 一致でスキップ、不一致で処理。
- **削除判定**: `deleted: true` の Google Task が削除として扱われること。
- **`updatedMin` の算出**: `lastPullAt` から安全マージンを引いた RFC3339 になること、初回（0）は付かないこと。

手動テストマトリクス: 作成 / 更新 / 削除 × Push / Pull、完了 → 未完了 → 完了の往復、Google Tasks Web UI で完了してから「クリア」した（`hidden` になった）タスクの取り込み、タスクリスト切替、トークン失効と再接続、オフライン復帰、gcal と同時に同期している Task、多端末での同時編集。

---

# English

Planned specification for two-way sync between Task Gantt tasks (one Markdown file = one task) and a single user-selected Google Tasks **task list**, implemented as a module independent from the existing Google Calendar sync.

- **Push (Task → Google Tasks)**: create / update / complete / delete Google Tasks when in-scope tasks change. **Pull (Google Tasks → Task)**: write due-date changes, completion changes and deletions back to frontmatter. Each direction toggles independently. Out of scope: importing foreign Google Tasks, multiple task lists, subtask hierarchy, dependencies (`after`), start dates, times of day, mobile.
- **Separate module**: `src/gtasks/{auth,api,map,sync}.ts` with its own client ID / secret / refresh token under `plugin.settings.gtasks`, deliberately not merged with `gcal` — this follows the existing per-feature module pattern and spares current Calendar users any migration risk. The same GCP OAuth client can be pasted into both sections, so the extra cost is one more consent screen.
- **Auth**: the user's own GCP OAuth client (desktop type), loopback redirect on `http://127.0.0.1:<random port>/callback` with PKCE, client secret and refresh token stored in **SecretStorage**, never in `data.json` (as `src/gcal/secrets.ts` does since 2.10.1; disclosed in README). Scope is `https://www.googleapis.com/auth/tasks` only — the Tasks API has no read-only counterpart to `calendar.calendarlist.readonly`, so even listing task lists needs the full scope. Desktop-only, guarded by `Platform.isDesktop`.
- **Mapping**: file name → `title`; `end ?? start` (**date only**) → `due`; body excerpt + `obsidian://` link → `notes`; the task id lives in a new `gtasksId` frontmatter key (renamable via `keys`); opt-in per task via `gtasks: true`. **`start` is never synced** (Google Tasks has nowhere to put it) and `due` carries no time of day (Google stores it as UTC midnight), so `startTime` / `endTime` are excluded from the hash entirely.
- **No extended properties**: unlike Calendar events, a Google Task has no arbitrary metadata field and `tasks.list` offers no server-side metadata filter, so the pre-insert duplicate search used by the gcal engine is impossible. The `obsidian://` line in `notes` doubles as the marker, and duplicates are reconciled by an *adopt-on-pull* step that claims unknown remote tasks pointing at an existing path and deletes the extra copy.
- **Pull differs fundamentally from gcal**: the Tasks API has **no `syncToken`/`nextSyncToken`**. Instead every pull passes `updatedMin` (last pull time minus a 60-second safety margin) together with `showCompleted=true`, `showHidden=true` (completed tasks become hidden and would otherwise vanish) and `showDeleted=true`, paging at `maxResults=100` (the Tasks limit, not gcal's 250). Deletions arrive as `deleted: true` rather than `status: "cancelled"`. The first pull omits `updatedMin` and lists the whole task list to adopt what is already there.
- **Status round-trip** (new problem, absent from gcal): Google Tasks only knows `needsAction` / `completed`, while Task Gantt has user-defined statuses each belonging to one of the four fixed status groups. Push maps the *completed* group to `status: "completed"` (with a `completed` timestamp) and every other group — including *cancelled* — to `needsAction`. Pull rewrites the local status **only when the remote state changed since the last sync**, using two new settings: a default completed status (chosen from the completed group) and a default reopen status (chosen from the others).
- **Loop prevention / conflicts**: identical to gcal in shape — a per-path snapshot `{id, hash, etag, done, at}`, debounced push, interval pull, echo detection by `etag`, and last-writer-wins by comparing the remote `updated` with the local mtime (whole-task, never field-by-field). Titles never flow back from the remote side.
- **Deletion policy**: mirrors gcal's `deleteEventOnTaskDelete` / `onEventDeleted`, named `deleteRemoteOnTaskDelete` / `onRemoteDeleted` (`"unlink" | "clearDates"`, default unlink; files are never deleted).
- **Detail panel**: an opt-in toggle only. No "open in browser" link in v1 — note that the original assumption was wrong, the Task resource *does* expose an output-only `webViewLink`, so the value is merely stored in the snapshot and surfacing it is deferred.
- **New files**: `src/gtasks/{auth,api,map,sync}.ts` plus additions to settings (~200 lines), i18n (~34 keys × 8 languages), detail panel, scheduler and README. No new dependencies (`requestUrl` + Node's `http` only).
- **Milestones**: M1 auth → M2 push → M3 pull/conflicts → M4 status round-trip & settings UI → M5 polish and the next minor release. Unit tests build `src/gtasks/map.ts` with esbuild into `test/gtasks.test.mjs` (added to the `test` script) covering due mapping, hashing, completion mapping, the pull status branches, conflict outcomes, echo detection and `updatedMin` computation.
