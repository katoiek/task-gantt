# Obsidian Gantt

プロジェクト管理ツールのようなタスク管理 UI を Obsidian で実現するプラグイン。1 ファイル = 1 タスクとし、フォルダ配下を「表＋タイムライン」ガントで表示・編集する。

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
Task 間の先行 / 後続関係。フロントマターの `after`（先行 Task への wikilink 配列）で表し、タイムライン上に矢印として描く。Subtask（親子）とは別概念。
_Avoid_: Link, Relation, Blocker, Predecessor

**Subtask**:
親 Task を持つ Task。フロントマターの `parent`（親 Task への単一 wikilink）で表し、表では親 Task の直下に入れ子表示する（サブサブ＝任意の深さ）。子は親と同じ Group（フォルダ）に同居し、ドラッグ＆ドロップで親へ寄せると親のフォルダへ移動する。Dependency（先行/後続）や Group（フォルダ）とは別の階層軸。
_Avoid_: Child, Sub-item, Nested task

**Rollup**:
親 Task の配下（子孫 Task）の期間を集約して 1 本のサマリーバーで示す表示。ボード全体のトグル（既定 OFF）で切替え、対象は親 Task のバーのみ。OFF のとき親 Task は自分の日付で描く。Group（フォルダ）行のサマリーバーは常時集約で、このトグルの対象外。
_Avoid_: Summary, Aggregate, Parent bar

**Assignee**:
Task の担当者。
_Avoid_: Owner, Member, Person

**Status**:
Task の進行状態（例: To do / In progress / Done）。設定で定義し、バー色に反映する。
_Avoid_: State, Phase

**Status group**:
Status が属する 4 種の分類（アクティブ / 完了 / 延期 / キャンセル）。Wrike に倣った**固定の 4 種**でユーザーは増やせず、各 Status はちょうど 1 つに属する。「完了 / 未完了」の判定はこのグループだけを根拠にし、Status の id やラベルからは推測しない。フロントマターには持たず、設定の Status 定義から都度引く。
_Avoid_: Category, Bucket, Phase

**Inline edit**:
テーブルのセルをダブルクリックして、その場で値を編集する操作。**テーブルに表示できる列はすべて Inline edit に対応する**（列を追加するときは表示用の描画とエディタをセットで実装する）。Enter／フォーカス外れで保存、Esc で取消し、値が変わっていなければ書き込まない。編集可能セルはシングルクリックを飲み込むため、詳細パネルを開く導線はタスク名セル（および Bar のダブルクリック）が担う。
_Avoid_: Quick edit, Cell edit, Direct edit

**Custom field**:
ユーザーが設定で宣言する任意のフロントマターキー（`key` / 表示ラベル / 型 text・number・date）。テーブルの列として表示・ソートできる。ビルトイン列（開始・期限・担当者・ステータス）と同じ「列定義」の仕組みに乗る。
_Avoid_: Property, Attribute, Metadata

**Tag**:
Obsidian ネイティブのタグ（フロントマター `tags:` ＋ 本文 `#tag`）。多値で、フィルタ・グループ化・タグ列に使う。Group（フォルダ＝排他・1か所）に対し、タグは**追加的な複数所属**（タググループへの D&D で付与、グループ化時は複数グループへ重複表示）。読み取りは本文 `#tag` も含むが、追加・削除はフロントマター `tags:` に対して行う。
_Avoid_: Label, Category, Keyword
