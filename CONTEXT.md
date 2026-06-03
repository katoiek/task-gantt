# Obsidian Gantt

ClickUp / Wrike のようなタスク管理 UI を Obsidian で実現するプラグイン。1 ファイル = 1 タスクとし、フォルダ配下を Wrike 風の「表＋タイムライン」ガントで表示・編集する。

## Language

**Task**:
1 つの Markdown ファイル。スケジュール情報（開始・終了・ステータス・担当・先行タスク）はフロントマターが源泉、本文（Body）がタスク説明。ガント上では 1 本のバー（または菱形＝マイルストーン）と表の 1 行に対応する。
_Avoid_: Event, Item, Issue, Note

**Board**:
設定した親フォルダ配下を集計した、表＋タイムラインのガント画面全体。リボンアイコンから開く専用ビュー。
_Avoid_: Plan, Chart, Timeline, View

**Group**:
親フォルダ直下のサブフォルダ。表とタイムラインで「グループ見出し行」として配下の Task をまとめる。
_Avoid_: Section, Folder, Category, List

**Body**:
Task（ファイル）の本文。フロントマターを除いた Markdown 本体。詳細パネルに表示する。
_Avoid_: Description, Content, Note

**Dependency**:
Task 間の先行 / 後続関係。フロントマターの `after`（先行 Task への wikilink 配列）で表し、タイムライン上に矢印として描く。
_Avoid_: Link, Relation, Blocker, Predecessor

**Assignee**:
Task の担当者。
_Avoid_: Owner, Member, Person

**Status**:
Task の進行状態（例: To do / In progress / Done）。設定で定義し、バー色に反映する。
_Avoid_: State, Phase
