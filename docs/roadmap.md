# task-gantt リファクタリング & 機能ロードマップ

> 作成日: 2026-09-26 / 対象バージョン: 2.9.1（`ec2e33a`）/ 改訂: 2026-09-26（コード精査の結果を反映）
> 別エージェントへの引き継ぎ用。用語は `CONTEXT.md` に従うこと（Task / Board / Group / Subtask / Inline edit / Custom field など）。

## 0. 前提・現状

- テスト: `npm test` → 51 passed / 0 failed。型チェック（`tsc -noEmit -skipLibCheck`）もエラーなし。
- ロジック層（`src/model.ts` / `src/timeline.ts` / `src/gcal/map.ts`）は純粋関数化されテスト済み。
- 課題は `src/view.ts`（2,881 行）への集中。描画・フィルタ判定・Undo・D&D・詳細パネル・セル編集・ポップオーバーが 1 クラス（`GanttView`）に同居している。
- `src/i18n.ts`（1,868 行）に 8 言語（ja / en / zh / zh-tw / ko / fr / es / ru）が直書き。キーの抜けは `Record<Lang, Strings>` で既に型検出される。
- CI（`.github/workflows/release.yml`）はタグ push 時のビルドのみで、`npm install` を使っている。テスト・型チェックは CI で走らない。
- `package.json` の `obsidian` 依存が `"latest"`（lock では 1.13.0 に解決済み）。

### 作業ルール（全フェーズ共通）

- コードコメントは「日本語 / English」を併記（既存コードと同じ書式）。
- 既存の挙動を変えない（リファクタリングは振る舞いを保存する）。各ステップの後に `npm run build` と `npm test` が通ること。
- 「テーブルに表示できる列はすべて Inline edit に対応する」は恒久仕様。列を追加するときは描画とエディタをセットで実装する。例外は name 列（クリックで詳細パネル、改名はパネルのタイトル欄）。
- 動作確認はリポジトリ直下のテスト Vault `Obsidian-Dev/` へのプラグインコピーで行う（コミット対象外）。
- 1 ステップ = 1 PR 程度の粒度で進める。

### 推奨の進行順

Phase 1 → Redo（Phase 1-5）→ Phase 2（列レジストリ → Custom field）→ 複数選択・一括編集 → FS 自動スケジュール → Phase 3 → Bases ビュー（v3.0）

---

## Phase 1（v2.9.x）: 基盤整備と Undo 修正

### 1-1. CI にテスト・型チェックを追加

- `.github/workflows/ci.yml` を新設し、`push`（main）と `pull_request` で `npm ci` → `npm run build` → `npm test` を実行する。
- `release.yml` も `npm install` → `npm ci` に変え、ビルド前に `npm test` を実行する。
- 受け入れ条件: PR 上で CI が走り、テストが失敗すると赤になる。リリースは lock どおりの依存でビルドされる。

### 1-2. 依存バージョンの固定

- `obsidian: "latest"` を lock と同じ `1.13.0` に固定する（1.7.2 の型に下げるとビルドが壊れる恐れがあるため）。
- 注意: 型が `minAppVersion`（1.7.2）より新しいので、1.7.2 に無い API を呼んでも型では気付けない。新しい API を使うときは `@since` を確認する。
- 任意: `eslint` + `eslint-plugin-obsidianmd` を導入し、`npm run lint` を CI に追加する。

### 1-3. フィルタ判定を `src/filter.ts` へ切り出す

- 対象: `GanttView.matchFilter`（`src/view.ts` 約 1054 行）と `GanttView.processTasks`（約 1091 行）。
- `this` 依存は `plugin.settings.statuses` / `filters` / `filterMatch` と `groupBy` / `flat` / `tr().noneLabel` だけなので、引数で渡す純粋関数にする。
  - 例: `matchFilter(t, f, statuses, today)`、`applyFilters(tasks, filters, match, statuses, today)`、`regroup(tasks, groupBy, flat, statuses, noneLabel)`
- `package.json` の `test` スクリプトに `filter.ts` のバンドルを追加し、`test/filter.test.mjs` を作る。
  - テキスト 6 演算子、カテゴリの `""`（未設定センチネル）、statusGroup（未知 id → 未設定扱い）、AND/OR、タグの複製グループ化を網羅する。
- `.gitignore` に生成物 `test/filter.mjs` を追加する。

### 1-4. Undo の対象限定と全書き込みの Undo 化（バグ寄り・最優先）

- 問題 1（性能）: `pushUndo`（`src/view.ts` 約 1139 行）が操作のたびにボード上の**全タスクファイル**を読んでスナップショットしている。
- 問題 2（不整合）: Undo されない書き込みがある（2.9.1 時点で確認済み）。
  - 詳細パネル: `saveField`（ステータス・担当者）、進捗スライダー、GCal 同期チェック、タイトル欄でのリネーム、本文編集、タグの追加・削除
  - セル: 進捗（`commitProgress`）、ステータス、担当者、タグポップオーバーでの追加・削除
  - 新規作成（`createTask`）・削除（`deleteTask`）
  - Undo できるのは、日付（バー操作・詳細パネル・日付セル）、依存の追加・削除、タググループへの D&D によるタグ付与、親変更・移動のみ。
- 設計:
  - 履歴 1 件は `{ label, files: Map<path, 変更前の内容 | null>, moves }`（実装済み）。
    - `null` は「操作前は存在しなかった」。新規作成は Undo でゴミ箱へ、削除は Undo で同じパスに同じ内容で作り直す（ゴミ箱のコピーはそのまま残る）
    - `moves`: リネーム・移動（逆順に巻き戻す）
  - 書き込みは Undo 付きの 1 つの関数に集約する（`private async mutate(label, paths, fn)`）。表示中の列の Inline edit と詳細パネルの編集は、すべてこの経路を通す。
  - SS/FF 後続の連動（`realignSuccessors`）がある操作では、**書き込み前に**依存を推移的にたどって後続パスを列挙する（`successorClosure(tasks, rootPath)`・純粋関数でテスト可能）。
  - 外部でのリネーム（ファイルエクスプローラー等）: このボードのタスク・フォルダに限り、1 操作として履歴に積む（2.9.3）。時系列どおりに戻せ、古い履歴のパスも食い違わない。フォルダのリネームで配下ごとに届くイベントは 1 件に畳む。当初の「履歴内のパスを付け替える」方式は、Undo が時系列とずれる（名前を戻さずに古い操作だけ戻す）ため置き換えた。
  - 無いファイルを作り直すのは「削除の取り消し」「作成のやり直し」のときだけ。外部で消されたファイルは作り直さない。
  - Obsidian の外（Windows のエクスプローラー・macOS の Finder・同期ツール）での変更は対象外。Obsidian には `rename` ではなく `delete` と `create` として届くため。削除と作成の組をリネームとみなす推測判定は、誤判定の恐れから見送り、README に明記した。
- 受け入れ条件:
  - 全 Inline edit 列と詳細パネルの各フィールド、リネーム、新規作成が Ctrl/Cmd+Z で戻る。
  - 1 操作あたりの読み込みファイル数が「変更対象＋連動対象」に限られる。
  - 外部でのリネームも 1 回の Undo で戻り、その次の Undo でそれ以前の操作が戻る。

### 1-5. Redo

- Undo 実行時に、対象ファイルの現在内容（と逆向きの `moves`）を Redo スタックへ積むだけで実現できる。新しい操作で Redo スタックは空にする。
- ショートカット: Ctrl/Cmd+Shift+Z（と Ctrl+Y）。
- 元計画で却下した「フロントマター差分のコマンド方式」は不要になる。

---

## Phase 2（v2.10）: 列レジストリ化 → Custom field

### 2-1. 列定義のレジストリ化

- 現状、`ColumnId` / `COLUMN_ORDER` / `OPTIONAL_COLUMNS` / `COLUMN_WIDTHS`（`src/view.ts` 56–59 行）、`colLabel`、`renderCell`、各 `paint*Cell` / `edit*Cell`、`taskComparator` が散在している。
- 1 つの定義にまとめる:
  ```ts
  interface ColumnDef {
    id: string;
    label: () => string;
    width: number;
    paint: (ctx: BoardContext, td: HTMLElement, t: Task) => void;
    edit?: (ctx: BoardContext, cell: HTMLElement, t: Task) => void; // name 列以外は必須 / required except for `name`
    compare: (a: Task, b: Task) => number;
    optional: boolean;
  }
  ```
- `BoardContext`（`app`, `settings`, `tasks`, `ppd`, `range`, `mutate`, `refresh`, `rerender`）の型はここで先に定義し、列定義から `GanttView` 全体への参照を避ける（Phase 3 の分割で書き直しにならないように）。
- `settings.visibleColumns` / `columnWidths` / `sortBy` は id 文字列のままで互換を保つ。
- **実装済み**（`src/columns.ts` / `src/board.ts`）。上の案からの変更点:
  - `ColumnDef` は `NameColumn | CellColumn` の判別共用体。name 列はツリー描画のためビューが直接扱い、`CellColumn` だけが `paint` / `edit` / `editAria` を必須で持つ。
  - `paint` が `false` を返すと読み取り専用（ロールアップ中の日付、マイルストーンの開始）。編集の付与はビュー側で一律に行う。
  - 並べ替えは `compare` ではなく `sortKey`（数値は差、それ以外は文字列比較）。`visibleColumns` / `columnWidth` / `taskComparator` は純粋関数で `test/columns.test.mjs` がある。
  - `BoardContext` には `ppd` / `range` をまだ入れていない（使う部品が出てきた時点で足す）。代わりにセル編集用の UI 部品（`inlineInput`、`openPopover`、`openRangePicker` など）を持つ。セル描画・編集の関数は `columns.ts` に移したので、Phase 3-1 の `cells.ts` はほぼ済んでいる。

### 2-2. Custom field 列（`CONTEXT.md` に定義済み・未実装）

- 設定で `{ key, label, type: "text" | "number" | "date" }` の配列を宣言する（`GanttSettings.customFields`）。設定タブに追加・削除 UI を作る。
- `collectTasks`（`src/model.ts`）で `Task.custom: Record<string, string | number | undefined>` を読む。
- レジストリに動的な列として登録し、表示・ソート・Inline edit に対応させる（date 型は既存の日付ピッカーを流用）。書き込みは `mutate` 経由で Undo 可能にする。
- 任意: フィルタにも対応させる（text → TextFilter 相当、number / date → 比較演算子）。
- i18n の新規文言は 8 言語すべてに追加する。
- **実装済み**（フィルタ対応は未着手）。上の案からの変更点:
  - `CustomField` は不変の `id` を持ち、列 id は `cf:<id>`。キー名を変えても列の表示・幅・並べ替えが外れない。削除時は `visibleColumns` / `columnWidths` / `sortBy` から片付ける。
  - `Task.custom` のキーは `CustomField.id`。text のリスト値は配列のまま持ち、表示はカンマ区切り、書き戻しはリスト。date は日付部分のみ扱う。
  - キーが空・組み込みキー（`settings.keys` の値と `tags`）と衝突・重複するフィールドは列にせず、設定画面に注意書きを出す（`customFieldIssues`）。
  - 日付の編集は範囲カレンダーに単一日付モード（`openRangePicker` の `single` 引数）を足して流用した。

---

## Phase 3（v2.11）: view.ts 分割とボード単位の状態保存

### 3-1. `src/view.ts` の分割

`GanttView` にはライフサイクルと状態だけを残し、以下へ委譲する。

```
src/view/
  GanttView.ts     // ライフサイクル・状態 / lifecycle + state
  filterBar.ts     // フィルタ行・プリセット UI（約 524–850 行）/ filter chips, editors, presets
  detailPanel.ts   // 詳細パネル（約 1999–2390 行）/ detail panel
  cells.ts         // セル描画・インライン編集（約 2390–2850 行）/ cell paint + inline edit
  timelineSvg.ts   // グリッド・バー・依存矢印・進捗線（約 1384–1825 行）/ SVG drawing
  dnd.ts           // バーのドラッグ・リサイズ・リンク作成・行 D&D / drag & drop
  popover.ts       // openPopover の共通処理 / shared popover helper
```

- 状態の受け渡しは Phase 2-1 で定義した `BoardContext` で行う。
- 行番号は 2.9.1 時点の目安。

### 3-2. ボード単位の表示状態の保存

- 現状、`groupBy` / `colorBy` / `flat` / `rollup` / `progressLine` / `showEmptyFolders` / `collapsed` は、ビューを開いている間しか保持されない。
- フィルタ（`settings.filters`）は全ボードで共有される 1 組だけ。
- `settings.boards[key]` へ保存する（`getState` / `setState` も併用）。キーは `folder:<path>` 形式にし、将来の Bases 用に `base:<id>` を入れられるようにする。
- `vault.on("rename")` でフォルダのリネームに追従する。既存のグローバル値は初期値として移行する。

### 3-3. i18n の言語別ファイル化（低優先・省略可）

- `src/i18n/{ja,en,zh,zh-tw,ko,fr,es,ru}.ts` に分ける。キーの抜けは既に型で検出されるため、目的は見通しの改善のみ。

---

## Phase 4（v3.0）: 大型機能

| 優先 | 機能 | メモ |
|---|---|---|
| A | 複数選択・一括編集 | Shift / Ctrl クリックで複数行を選択。ステータス・担当者・日付シフト・タグを一括で変更する。`mutate` に複数パスを渡す |
| B | FS 依存の自動スケジュール＋クリティカルパス（FS の押し出しと Duration 列は対応済み・Issue #4。残りはクリティカルパス） | 現状 `realignSuccessors` は SS/FF のみ。先行を動かしたら FS 後続を押し出すオプション（設定トグル・既定 OFF）。既存の依存違反判定の延長でクリティカルパスをハイライト |
| B | 担当者ごとの負荷ビュー | 担当者行ごとに日別の担当タスク数をヒートマップ表示。既存の assignee データで描画を足すだけ |
| B | ベースライン | 計画時点の日付をフロントマターに保存し、現在のバーの下に薄く重ねる。進捗線と組み合わせて遅れを可視化 |
| B | Obsidian Bases ビュー対応 | Bases のカスタムビュー API で「Base → ガント表示」。フォルダ横断の集計（README の既知の制限）を解消する。`minAppVersion` を 1.10 以上へ引き上げる必要あり |
| C | テンプレートからの新規作成 | フォルダごとに雛形ノートを指定。Templater とも連携しやすい |
| C | 休日・非稼働日 | タイムラインでの網掛けと、期間計算からの除外オプション |
| C | エクスポート | PNG / SVG（タイムライン）、CSV（テーブル） |
| C | 仮想スクロール | 大規模ボードで `rerender` の全 DOM 再構築コストを削減する。性能の報告が来てから |

---
---

# task-gantt Refactoring & Feature Roadmap

> Written: 2026-09-26 / Baseline: 2.9.1 (`ec2e33a`) / Revised: 2026-09-26 (after a code review)
> For hand-off to another agent. Use the vocabulary in `CONTEXT.md` (Task / Board / Group / Subtask / Inline edit / Custom field, etc.).

## 0. Baseline

- Tests: `npm test` → 51 passed / 0 failed. Type check (`tsc -noEmit -skipLibCheck`) is clean.
- The logic layer (`src/model.ts` / `src/timeline.ts` / `src/gcal/map.ts`) is pure and tested.
- The main issue is concentration in `src/view.ts` (2,881 lines): rendering, filter matching, undo, drag & drop, the detail panel, cell editing and popovers all live in one class (`GanttView`).
- `src/i18n.ts` (1,868 lines) holds all 8 languages inline. Missing keys are already type errors via `Record<Lang, Strings>`.
- CI (`.github/workflows/release.yml`) only builds on tag push, using `npm install`; no tests or type check run in CI.
- `obsidian` is `"latest"` in `package.json` (the lock resolves it to 1.13.0).

### Ground rules (all phases)

- Code comments are bilingual, "Japanese / English", matching existing style.
- Refactors must preserve behavior. `npm run build` and `npm test` must pass after each step.
- Permanent spec: every column the table can show supports Inline edit. A new column ships with both its renderer and its editor. The one exception is `name` (click opens the detail panel; renaming lives in the panel title).
- Verify manually by copying the plugin into the local test vault `Obsidian-Dev/` (never committed).
- Roughly one step per PR.

### Recommended order

Phase 1 → Redo (1-5) → Phase 2 (column registry → custom fields) → multi-select & bulk edit → FS auto-scheduling → Phase 3 → Bases view (v3.0)

## Phase 1 (v2.9.x): Foundations and undo fixes

1. **CI**: add `.github/workflows/ci.yml` running `npm ci` → `npm run build` → `npm test` on push to main and on pull requests. Switch `release.yml` from `npm install` to `npm ci` and run `npm test` before building.
2. **Pin dependencies**: pin `obsidian` to `1.13.0`, matching the lock (dropping to 1.7.2 types could break the build). Note the types are newer than `minAppVersion` 1.7.2, so check `@since` before using a new API. Optionally add `eslint` + `eslint-plugin-obsidianmd` and `npm run lint` in CI.
3. **Extract `src/filter.ts`**: move `GanttView.matchFilter` (~L1054) and `processTasks` (~L1091) into pure functions that take statuses, filters, match mode, groupBy, flat and the none-label as arguments.
   - Add `test/filter.test.mjs` covering all text ops, the `""` unset sentinel, unknown status ids as unset, AND/OR, and tag duplication.
   - Wire it into the `test` script and `.gitignore` the generated `test/filter.mjs`.
4. **Undo (highest priority, bug-like)**:
   - `pushUndo` (~L1139) snapshots *every* task file on the board per operation.
   - Not undoable as of 2.9.1: in the detail panel — `saveField` (status, assignee), the progress slider, the GCal sync checkbox, title rename, body edits, tag add/remove; in cells — progress (`commitProgress`), status, assignee, tag add/remove in the popover; plus `createTask` and `deleteTask`. Only dates, dependency add/remove, tag-by-drop and reparent/move are undoable today.
   - Entry shape (implemented): `{ label, files: Map<path, before | null>, moves }`. `null` means "didn't exist before": undoing a create trashes the file, undoing a delete re-creates it at the same path with the same contents (the trashed copy stays in the trash). `moves` are replayed in reverse.
   - Funnel every write through `mutate(label, paths, fn)`. For SS/FF cascades, enumerate the transitive successors *before* writing with a pure, testable `successorClosure(tasks, rootPath)`.
   - Outside renames (file explorer etc.) of this board's tasks or folders are recorded as ops of their own (2.9.3), so undo walks back in order and older entries never hold stale paths; a folder rename's per-file events fold into one entry. This replaced the original path-remapping approach, which undid older ops without undoing the rename. A missing file is re-created only when undoing a delete or redoing a create — never when it was deleted outside the board.
   - Changes made outside Obsidian (Windows Explorer, macOS Finder, sync tools) are out of scope: they reach Obsidian as `delete` + `create`, not `rename`. Guessing renames from such pairs was rejected as too error-prone; the README says so.
   - Acceptance: every inline-edit column, every detail-panel field, rename and create revert with Ctrl/Cmd+Z; per-op reads are limited to affected files; an outside rename is undone by one undo, and the next undo reaches the op before it.
5. **Redo**: on undo, push the current contents of the affected files (and reversed `moves`) onto a redo stack; clear it on any new op. Shortcut Ctrl/Cmd+Shift+Z (and Ctrl+Y). This makes the previously rejected frontmatter-diff command pattern unnecessary.

## Phase 2 (v2.10): Column registry → Custom fields

1. **Column registry**: replace the scattered `ColumnId` / `COLUMN_ORDER` / `OPTIONAL_COLUMNS` / `COLUMN_WIDTHS` (L56–59), `colLabel`, `renderCell`, `paint*Cell` / `edit*Cell` and `taskComparator` with one `ColumnDef { id, label, width, paint, edit?, compare, optional }`. `edit` is required for every column except `name`. Define the `BoardContext` type here (`app`, `settings`, `tasks`, `ppd`, `range`, `mutate`, `refresh`, `rerender`) and pass it to `paint`/`edit`, so Phase 3 doesn't have to rewrite them. Settings keep plain id strings for compatibility.
   - **Done** (`src/columns.ts` / `src/board.ts`), with these changes: `ColumnDef` is a `NameColumn | CellColumn` union — the view draws the name column's tree itself, and only `CellColumn` carries the required `paint` / `edit` / `editAria`. `paint` returning `false` marks a cell read-only (rolled-up dates, a milestone's start); the view attaches editors uniformly. Sorting uses a `sortKey` instead of `compare`; `visibleColumns` / `columnWidth` / `taskComparator` are pure and tested in `test/columns.test.mjs`. `BoardContext` leaves out `ppd` / `range` until a part needs them, and carries the in-cell UI helpers (`inlineInput`, `openPopover`, `openRangePicker`, …) instead. Cell painting and editing moved into `columns.ts`, so Phase 3-1's `cells.ts` is largely done.
2. **Custom field columns** (defined in `CONTEXT.md`, not yet implemented):
   - `GanttSettings.customFields: { key, label, type: "text" | "number" | "date" }[]`, with add/remove UI in the settings tab.
   - Read into `Task.custom` in `collectTasks`.
   - Register as dynamic columns with display, sort and Inline edit (through `mutate`, so undoable); date fields reuse the existing picker.
   - Filters are optional.
   - Add new strings in all 8 languages.
   - **Done** (filters not yet). Changes from the plan: each `CustomField` has a stable `id` and its column id is `cf:<id>`, so renaming the key keeps the column's visibility, width and sort; deleting a field tidies `visibleColumns` / `columnWidths` / `sortBy`. `Task.custom` is keyed by field id; a text list stays an array (shown comma-joined, written back as a list); dates keep the date part only. Fields with an empty key, a key the plugin already reads (`settings.keys` values and `tags`), or a duplicate key don't become columns, and the settings tab says so (`customFieldIssues`). Date editing reuses the range calendar through a new single-date mode (`openRangePicker`'s `single` argument).

## Phase 3 (v2.11): Split view.ts and persist per-board state

1. **Split `src/view.ts`** into `src/view/{GanttView,filterBar,detailPanel,cells,timelineSvg,dnd,popover}.ts`, sharing state through the `BoardContext` from Phase 2-1. Line numbers are approximate as of 2.9.1.
2. **Per-board view state**: `groupBy` / `colorBy` / `flat` / `rollup` / `progressLine` / `showEmptyFolders` / `collapsed` currently last only while the view is open, and filters are one global set. Persist them under `settings.boards[key]` (plus `getState` / `setState`) with keys like `folder:<path>` (leaving room for `base:<id>`), follow folder renames via `vault.on("rename")`, and migrate the current globals as defaults.
3. **Split i18n** (low priority, optional) into `src/i18n/<lang>.ts`. Missing keys are already type errors, so this is only for readability.

## Phase 4 (v3.0): Larger features

| Priority | Feature | Notes |
|---|---|---|
| A | Multi-select & bulk edit | Shift/Ctrl-click rows; bulk status, assignee, date shift and tags via `mutate` with many paths |
| B | FS auto-scheduling + critical path | FS push and the Duration column are done (issue #4: `src/schedule.ts`, push-only, on by default, workday-based). Still to do: highlight the critical path, building on the existing violation check |
| B | Workload view by assignee | A per-assignee heatmap of daily task counts, drawn from existing assignee data |
| B | Baseline | Save the planned dates in frontmatter and draw them as a faint bar under the current one; pairs with the progress line |
| B | Obsidian Bases view | Offer the Gantt as a Bases custom view, removing the cross-folder limitation in the README. Requires raising `minAppVersion` to 1.10+ |
| C | New task from a template | Per-folder template note; plays well with Templater |
| C | Non-working days | Shade on the timeline; optionally exclude from duration math |
| C | Export | PNG / SVG (timeline), CSV (table) |
| C | Virtual scrolling | Cut the full-DOM rebuild cost of `rerender` on large boards, once performance reports come in |
