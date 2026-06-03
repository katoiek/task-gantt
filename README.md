# Obsidian Gantt

ClickUp / Wrike のようなタスク管理 UI を Obsidian で実現するプラグインです。**1 ファイル = 1 タスク**とし、指定フォルダ配下を **Wrike 風の「表＋タイムライン」ガント**で表示・編集します。
A ClickUp/Wrike-style Gantt for Obsidian. One Markdown file = one task; a configured folder is shown as a table + timeline.

## 使い方 / Usage

1. 設定 → Gantt で **対象フォルダ**を指定（例: `Projects/お掃除`）。
2. 左端リボンの **棒グラフアイコン**、またはコマンド「Gantt を開く」でビューを開く。
3. 直下のサブフォルダが**グループ**、その中の `.md` が**タスク**になります。
4. バーを**ドラッグ／端をリサイズ**すると、そのファイルのフロントマター `start`/`end` に書き戻します。
5. タスクをクリックすると、右から**詳細パネル**（日付・状態・担当・本文）がスライドインします。

## タスクの書き方 / Task frontmatter

各タスクは 1 つの Markdown ファイル。スケジュールはフロントマター、説明は本文に書きます。

```markdown
---
start: 2026-02-04
end: 2026-02-07
status: in-progress
assignee: kato
after:
  - "[[掃き掃除]]"     # 先行タスク（依存＝矢印）/ predecessor (dependency arrow)
---

# 拭き掃除
本文がタスクの説明（詳細パネルに表示）。
```

| フロントマター | 意味 |
|----------------|------|
| `start` / `end` | 開始 / 終了日 `YYYY-MM-DD`（バーの位置と長さ） |
| `status` | ステータス ID（設定で定義、バー色に反映） |
| `assignee` | 担当者（バー脇にラベル表示） |
| `after` | 先行タスクへの wikilink 配列（依存＝矢印、違反は赤） |
| `progress` | 進捗 0–100（バー内の塗り） |
| `milestone` | `true` で菱形（期間ゼロ） |

タスク名はファイル名（拡張子なし）。グループは直上のサブフォルダ名。
フロントマターのキー名は設定で変更できます。

`examples/お掃除プロジェクト/` に動作確認用のサンプルがあります（対象フォルダにそれを指定）。

## 開発 / Development

```bash
npm install      # 依存をインストール / install deps
npm run dev      # 監視ビルド / watch build
npm run build    # 型チェック＋本番ビルド / type-check + production build
```

`main.js` / `manifest.json` / `styles.css` を `<vault>/.obsidian/plugins/task-gantt/` にコピーして有効化。

## 設計 / Design

設計判断の経緯は [`docs/adr/`](./docs/adr/)（最新方針は ADR-0004）、用語は [`CONTEXT.md`](./CONTEXT.md) を参照。

### 既知の制限 / Limitations (MVP)

自動スケジューリング（クリティカルパス）・時刻粒度・複数フォルダ横断・ボード/テーブルビュー・タスク新規作成 UI は未実装。
