# Task Gantt

**English** | [日本語](#日本語)

An interactive project-management Gantt for Obsidian. **One Markdown file = one task**; a configured folder is shown and edited as a "table + timeline" Gantt — drag bars to reschedule, link dependencies, set milestones, sort and filter, and move tasks between folders by dragging.

> Requires **Obsidian 1.13.0 or later**.

## Screenshots

Open a folder as a Gantt from the left-column ribbon button, or by right-clicking the folder → **Open as Gantt**:

![Open a folder as a Gantt from the ribbon button or the right-click menu](docs/images/open-as-gantt.png)

The folder opens as a table + timeline, with groups, bars, milestones, and dependency arrows:

![The opened Gantt chart with groups, bars, milestones and dependencies](docs/images/gantt-chart.png)

Click a task to open the detail panel and edit its dates, status, assignee, progress, and body:

![Task detail panel for editing dates, status, assignee, progress and body](docs/images/detail-panel.png)

## Usage

1. In **Settings → Task Gantt**, set the **target folder** (e.g. `Projects/Cleanup`).
2. Open the view from the **"Open Gantt" ribbon icon** in the left column (or the command **"Open Gantt"**). The ribbon opens the Gantt for the folder of the currently open note — or the folder selected in the file explorer — and falls back to the default folder in settings (the **vault root** when none is set). You can also right-click any folder → **Open as Gantt**.
3. Direct subfolders become **groups**, and the `.md` files inside them become **tasks**.
4. **Drag a bar / resize its edges** to write the new dates back to that file's `start`/`end` frontmatter. You can also **double-click a Start/Due cell** in the table to pick a date from a calendar.
5. Click a task in the table — or **double-click its bar** — to slide in a **detail panel** (dates, status, assignee, progress, body) from the right.
6. Use the **＋ New task** button to create a one-day task in the current folder and name it on the spot, and **Today** to scroll the timeline to the current date.
7. Use the **Day / Week / Month / Fit** buttons to change the timeline scale. **Fit** auto-scales to the pane width and re-fits when you resize.

The UI follows Obsidian's display language: Japanese when Obsidian is set to Japanese, English otherwise.

## View options

An options row above the table shapes how the board is displayed.

**Group by** folder, status, or assignee, and **color by** status or assignee (with a legend). Filters narrow the board to a single status or assignee:

![Grouping and color-by options with a legend](docs/images/grouping-en.png)

**Sort** by clicking a column header; click it again to flip ascending/descending (↑/↓):

![Click a column header to sort, with an ↑/↓ indicator](docs/images/sort-en.png)

**Choose columns** with the gear button — show or hide Start, Due, Assignee, and Status. The column layout and sort are remembered across sessions:

![Show or hide table columns from the gear menu](docs/images/column_en.png)

**Flat view** lists every task in one sorted list, ignoring folders and nesting:

![Flat view: all tasks in a single sorted list](docs/images/flatview-en.png)

## Moving tasks between folders

When grouped by folder, **drag a task row** onto a folder to move the task into it (or onto another task to drop it into that task's folder). Links are updated automatically, and the move is **undoable** with **Ctrl/Cmd+Z** or the undo button. Empty folders stay visible as rows so you always have a drop target; the **Show empty folders** toggle (on by default) controls this.

## Creating tasks

Press **＋ New task** to create a dated note in the current folder and rename it immediately. You don't have to start there, though: every note inside the target folder already appears as a row — **including notes with no dates yet** — so you can also click an existing note and set **Start** / **Due** in the detail panel to turn it into a scheduled task.

## Task frontmatter

Each task is a single Markdown file. The schedule lives in frontmatter; the description is the body.

```markdown
---
start: 2026-02-04
end: 2026-02-07
status: in-progress
assignee: kato
progress: 40
after:
  - "[[Sweeping]]"     # predecessor (dependency arrow)
---

# Wiping
The body is the task description (shown in the detail panel).
```

| Frontmatter | Meaning |
|-------------|---------|
| `start` / `end` | Start / end date `YYYY-MM-DD` (bar position and length). |
| `status` | Status ID (defined in settings, reflected in bar color). |
| `assignee` | Assignee (label shown next to the bar). |
| `progress` | Progress 0–100 (fill inside the bar; editable with the detail-panel slider). |
| `after` | Array of wikilinks to predecessors (dependency arrows; violations turn red). |
| `milestone` | `true` for a diamond (zero duration). |

**Milestones:** a task that has only an `end` date (no `start`) is automatically treated as a milestone and drawn as a diamond. Setting `milestone: true` does the same. To turn a milestone back into a ranged task, give it a `start` date.

The task name is the file name (without extension); the group is the parent subfolder name. Frontmatter key names can be changed in settings.

Sample data for a quick try lives in `examples/Cleaning Project お掃除プロジェクト/` (point the target folder at it).

## Dependencies

Drag from a bar's round handle to another bar to create a dependency. The connected ends decide the type: **FS** (finish→start), **SS** (start→start), **FF** (finish→finish). SS/FF successors snap to their predecessor when you reschedule. Click a dependency line to remove it (undo with **Ctrl/Cmd+Z** or the undo button).

## Settings

Open **Settings → Task Gantt** to configure the default folder, subfolder recursion, default zoom, and the **date display format** (`YYYY/MM/DD`, `DD/MM/YYYY`, or `MM/DD/YYYY`; stored dates always stay ISO `YYYY-MM-DD`).

**Statuses are fully customizable** — add, edit, or delete them. Each status has an **id** (matches the `status` frontmatter value), a **label**, and a **color** reflected in the bar.

You can also rename the **frontmatter keys** the plugin reads (start, end, status, assignee, after, progress, milestone) to match your own vault conventions.

![Task Gantt settings: customizable statuses and frontmatter keys](docs/images/settings-en.png)

## Development

```bash
npm install      # install deps
npm run dev      # watch build
npm run build    # type-check + production build
npm test         # headless model tests
```

Copy `main.js` / `manifest.json` / `styles.css` into `<vault>/.obsidian/plugins/task-gantt/` to enable it.

## Design

See [`docs/adr/`](./docs/adr/) for the rationale behind design decisions (latest: ADR-0005) and [`CONTEXT.md`](./CONTEXT.md) for terminology.

## Limitations

Auto-scheduling (critical path), sub-day time granularity, and cross-folder aggregation are not implemented. Subtasks, tags, and custom fields are planned.

## License

MIT — see [`LICENSE`](./LICENSE).

---

# 日本語

[English](#task-gantt) | **日本語**

プロジェクト管理ツールのようなタスク管理 UI を Obsidian で実現するプラグインです。**1 ファイル = 1 タスク**とし、指定フォルダ配下を **「表＋タイムライン」ガント**で表示・編集します。バーのドラッグで日程変更、依存の作成、マイルストーン、ソート・フィルタ、ドラッグでのフォルダ移動などができます。

> **Obsidian 1.13.0 以降**が必要です。

## スクリーンショット

左列のリボンボタン、またはフォルダの右クリック →**「Open as Gantt」**から Gantt として開きます：

![リボンボタンまたは右クリックメニューからフォルダを Gantt として開く](docs/images/open-as-gantt.png)

「表＋タイムライン」で開き、グループ・バー・マイルストーン・依存の矢印が表示されます：

![開いたガントチャート（グループ・バー・マイルストーン・依存）](docs/images/gantt-chart.png)

タスクをクリックすると詳細パネルが開き、日付・状態・担当・進捗・本文を編集できます：

![タスクの詳細パネル（日付・状態・担当・進捗・本文の編集）](docs/images/detail-panel.png)

## 使い方

1. **設定 → Task Gantt** で**対象フォルダ**を指定（例: `Projects/お掃除`）。
2. 左列の **「Gantt を開く」リボンアイコン**（またはコマンド「Gantt を開く」）でビューを開く。リボンは、**現在開いているノートのフォルダ**（またはエクスプローラで選択中のフォルダ）を Gantt 表示し、どちらも無ければ設定の既定フォルダ（未設定なら **Vault ルート**）を開きます。フォルダを右クリック →**「Open as Gantt」**でも開けます。
3. 直下のサブフォルダが**グループ**、その中の `.md` が**タスク**になります。
4. バーを**ドラッグ／端をリサイズ**すると、そのファイルの `start`/`end` に書き戻します。表の**開始・期限セルをダブルクリック**すると、カレンダーから日付を選べます。
5. 表のタスクをクリック、または**バーをダブルクリック**すると、右から**詳細パネル**（日付・ステータス・担当者・進捗・本文）がスライドインします。
6. **＋ 新規タスク**ボタンで現在のフォルダに1日タスクを作ってその場で命名、**今日**ボタンでタイムラインを今日へスクロールできます。
7. **Day / Week / Month / Fit** ボタンで時間軸の拡大率を変更。**Fit** はペイン幅に自動で収め、リサイズにも追従します。

UI 表示は Obsidian の表示言語に追従します（日本語なら日本語、それ以外は英語）。

## 表示オプション

表の上のオプション行で、ボードの見せ方を調整できます。

**グループ化**（フォルダ／ステータス／担当者）と**色分け**（ステータス／担当者・凡例付き）。フィルタで特定のステータス・担当者に絞り込めます：

![グループ化と色分けのオプション（凡例付き）](docs/images/grouping-ja.png)

**ソート**は列ヘッダをクリック。もう一度クリックで昇順／降順を切替（↑/↓）：

![列ヘッダのクリックでソート（↑/↓ 表示）](docs/images/sort-ja.png)

**列の表示**は歯車ボタンから、開始・期限・担当者・ステータスを出し分け。列レイアウトとソートはセッションをまたいで保存されます：

![歯車メニューから列を表示／非表示](docs/images/column_ja.png)

**フラット表示**は、フォルダや入れ子を無視して全タスクを1本のソート済みリストで表示します：

![フラット表示：全タスクを1本のソート済みリストで](docs/images/flatview-ja.png)

## フォルダ間のタスク移動

フォルダでグループ化しているとき、**タスク行をドラッグ**してフォルダにドロップするとそのフォルダへ移動できます（別タスクへドロップすると、そのタスクと同じフォルダへ）。リンクは自動更新され、移動は **Ctrl/Cmd+Z** または取り消しボタンで**元に戻せます**。空のフォルダも行として表示されるので常にドロップ先になります（**空フォルダを表示**トグル＝既定ON で切替）。

## タスクの作成

**＋ 新規タスク**で現在のフォルダに日付付きノートを作り、すぐ名前を付けられます。もちろんそこから始める必要はありません。対象フォルダ内のノートは、**まだ日付が無いものも含めて**そのまま行として表示されるので、既存ノートをクリックして詳細パネルで **開始 / 期限** を入力すれば、そのままスケジュール付きタスクになります。

## タスクの書き方

各タスクは 1 つの Markdown ファイル。スケジュールはフロントマター、説明は本文に書きます。

```markdown
---
start: 2026-02-04
end: 2026-02-07
status: in-progress
assignee: kato
progress: 40
after:
  - "[[掃き掃除]]"     # 先行タスク（依存＝矢印）
---

# 拭き掃除
本文がタスクの説明（詳細パネルに表示）。
```

| フロントマター | 意味 |
|----------------|------|
| `start` / `end` | 開始 / 終了日 `YYYY-MM-DD`（バーの位置と長さ） |
| `status` | ステータス ID（設定で定義、バー色に反映） |
| `assignee` | 担当者（バー脇にラベル表示） |
| `progress` | 進捗 0–100（バー内の塗り。詳細パネルのスライダーで編集） |
| `after` | 先行タスクへの wikilink 配列（依存＝矢印、違反は赤） |
| `milestone` | `true` で菱形（期間ゼロ） |

**マイルストーン：** `end`（終了日）だけがあり `start`（開始日）が無いタスクは、自動的にマイルストーンと判定され菱形で描画されます。`milestone: true` でも同じです。通常タスクに戻すには `start`（開始日）を与えてください。

タスク名はファイル名（拡張子なし）。グループは直上のサブフォルダ名。フロントマターのキー名は設定で変更できます。

`examples/Cleaning Project お掃除プロジェクト/` に動作確認用のサンプルがあります（対象フォルダにそれを指定）。

## 依存関係

バーの丸ハンドルから別のバーへドラッグすると依存を作成します。つないだ端で種類が決まります：**FS**（終了→開始）・**SS**（開始→開始）・**FF**（終了→終了）。SS/FF の後続は、先行の日程変更に追従します。依存線をクリックで切断（**Ctrl/Cmd+Z** または取り消しボタンで戻せます）。

## 設定

**設定 → Task Gantt** から、既定フォルダ・サブフォルダの再帰・既定ズーム・**日付の表示フォーマット**（`YYYY/MM/DD`／`DD/MM/YYYY`／`MM/DD/YYYY`。保存値は常に ISO `YYYY-MM-DD`）を設定できます。

**ステータスは自由に追加・編集・削除**できます。各ステータスは **id**（フロントマターの `status` 値と対応）・**ラベル**・**色**（バー色に反映）を持ちます。

プラグインが読む**フロントマターのキー名**（start / end / status / assignee / after / progress / milestone）も、各自の Vault の慣習に合わせて変更できます。

![Task Gantt の設定：カスタマイズ可能なステータスとフロントマターキー](docs/images/settings-ja.png)

## 開発

```bash
npm install      # 依存をインストール
npm run dev      # 監視ビルド
npm run build    # 型チェック＋本番ビルド
npm test         # ヘッドレスのモデルテスト
```

`main.js` / `manifest.json` / `styles.css` を `<vault>/.obsidian/plugins/task-gantt/` にコピーして有効化。

## 設計

設計判断の経緯は [`docs/adr/`](./docs/adr/)（最新は ADR-0005）、用語は [`CONTEXT.md`](./CONTEXT.md) を参照。

## 既知の制限

自動スケジューリング（クリティカルパス）・時刻粒度・複数フォルダ横断は未実装。サブタスク・タグ・カスタムフィールドは予定。

## ライセンス

MIT ライセンス（[`LICENSE`](./LICENSE) を参照）。
