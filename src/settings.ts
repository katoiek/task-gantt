import { App, Notice, Platform, PluginSettingTab, Setting, TextComponent } from "obsidian";
// 宣言的設定の型（@since 1.13.0）。型のみの参照で実行時 API は呼ばないため、
// minAppVersion 1.11.4 のままでも no-unsupported-api には触れない。
// declarative-settings types (@since 1.13.0); type-only references call no runtime API,
// so they don't trip no-unsupported-api while minAppVersion stays at 1.11.4.
import type { SettingDefinitionItem, SettingDefinitionList, SettingGroupItem } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, StatusGroup, STATUS_GROUPS, ZoomMode, DateFormat, Filter, FilterMatch, FilterPreset, CustomField, CustomFieldType } from "./types";
import { collectAllTags, customFieldIssues, filesWithFrontmatterKey, newStatus, renameFrontmatterKey } from "./model";
import { ColumnDef, allColumns, columnList, moveColumn, toggleColumn } from "./columns";
import { AutoFired, autoStatusTargets, renameAutoStatusId } from "./schedule";
import { ChoiceModal, ConfirmModal, PickModal } from "./modals";
import { obsidianTagColor, toHex } from "./colors";
import { pickColor } from "./popover";
import { t as tr, statusGroupLabel } from "./i18n";
import { LEADS, leadLabel, sendTestNotification } from "./notify";
import { connectGoogle, disconnectGoogle, isConnected } from "./gcal/auth";
import { listCalendars } from "./gcal/api";
import { syncGcal } from "./gcal/sync";
import { getClientSecret, setClientSecret } from "./gcal/secrets";

// タイムゾーン一覧（実在するオフセットのみ・代表都市付き）/ timezone list (real offsets only, with representative cities)
const TZ_CITIES: [string, string][] = [
  ["-12:00", "Baker Island"],
  ["-11:00", "Midway, Niue"],
  ["-10:00", "Honolulu (Hawaii)"],
  ["-09:30", "Marquesas Islands"],
  ["-09:00", "Anchorage (Alaska)"],
  ["-08:00", "Los Angeles, Vancouver"],
  ["-07:00", "Denver, Phoenix"],
  ["-06:00", "Chicago, Mexico City"],
  ["-05:00", "New York, Toronto, Lima"],
  ["-04:00", "Halifax, Santiago, La Paz"],
  ["-03:30", "St. John's (Newfoundland)"],
  ["-03:00", "São Paulo, Buenos Aires"],
  ["-02:00", "South Georgia"],
  ["-01:00", "Azores, Cape Verde"],
  ["+00:00", "London, Lisbon, UTC"],
  ["+01:00", "Paris, Berlin, Rome, Madrid"],
  ["+02:00", "Cairo, Athens, Kyiv"],
  ["+03:00", "Moscow, Istanbul, Riyadh"],
  ["+03:30", "Tehran"],
  ["+04:00", "Dubai, Baku, Tbilisi"],
  ["+04:30", "Kabul"],
  ["+05:00", "Karachi, Tashkent"],
  ["+05:30", "New Delhi, Mumbai, Colombo"],
  ["+05:45", "Kathmandu"],
  ["+06:00", "Dhaka, Almaty"],
  ["+06:30", "Yangon"],
  ["+07:00", "Bangkok, Jakarta, Hanoi"],
  ["+08:00", "Beijing, Singapore, Hong Kong, Taipei"],
  ["+08:45", "Eucla"],
  ["+09:00", "Tokyo, Osaka, Seoul"],
  ["+09:30", "Adelaide, Darwin"],
  ["+10:00", "Sydney, Melbourne, Guam"],
  ["+10:30", "Lord Howe Island"],
  ["+11:00", "Nouméa, Solomon Islands"],
  ["+12:00", "Auckland, Fiji"],
  ["+12:45", "Chatham Islands"],
  ["+13:00", "Apia (Samoa), Nuku'alofa (Tonga)"],
  ["+14:00", "Kiritimati"],
];

// プラグイン設定 / Plugin settings
export interface GanttSettings {
  rootFolder: string; // 集計する親フォルダ / parent folder to aggregate
  recurse: boolean; // サブフォルダを再帰的に辿るか / recurse into subfolders
  statuses: StatusDef[];
  defaultZoom: ZoomMode;
  dateFormat: DateFormat; // 表示用の日付フォーマット / display-only date format
  // 時刻の表示/保存に使うタイムゾーン。"system"=端末、または "+09:00" 等の固定 GMT オフセット
  // timezone for displaying/saving times: "system" (device) or a fixed GMT offset like "+09:00"
  tz: string;
  // 休日の曜日（0=日 … 6=土）。Duration と依存の連動は稼働日で数える
  // non-working weekdays (0 = Sun … 6 = Sat); durations and dependency cascades count workdays only
  nonWorkingDays: number[];
  // 先行が遅れて FS の後続と重なったら後続を押し出す / push FS successors when a slipping predecessor overlaps them
  autoScheduleFS: boolean;
  // 日付で自動的にステータスを進める（既定 OFF）。空の id・空の一覧は既定（組み込みの in-progress / done、最初の「進行中」グループのステータス）。
  // fired は決まりが当たった日付（ノートのパスごと。その日付のあいだは、取り消しても手で戻しても当て直さない）
  // move statuses on by date (off by default); an empty id or list means the default (the built-in in-progress / done, the first active status).
  // `fired` holds the date each rule fired for, per note path (not applied again while that date stands, even if undone or set back by hand)
  autoStatus: { enabled: boolean; started: string; finished: string; notStarted: string[]; fired: AutoFired };
  detailWidth: number; // 詳細パネルの幅(px) / detail panel width (px)
  visibleColumns: string[]; // 表示する任意列（name は常時表示）/ optional columns shown (name is always shown)
  // 任意列の並び（列 id。無い列は定義順で後ろ）/ the optional columns' order (column ids; missing ones follow in definition order)
  columnOrder: string[];
  columnWidths: Record<string, number>; // 列幅の上書き(px)。未設定列は既定幅 / per-column width overrides (px); unset = default
  sortBy: string; // ソート列 id（name/start/end/progress/assignee/status/tags、Custom field は cf:<id>）/ sort column id (custom fields: cf:<id>)
  sortDir: "asc" | "desc"; // ソート方向 / sort direction
  // Custom field（任意のフロントマターキーをテーブルの列にする）/ custom fields: arbitrary frontmatter keys as table columns
  customFields: CustomField[];
  // 統合フィルタ（ステータス/担当者/タグ/開始日/期限日）と結合方法 / unified filters + combine mode
  filters: Filter[];
  filterMatch: FilterMatch; // all=すべてに一致(AND) / any=いずれかに一致(OR)
  filterPresets: FilterPreset[]; // ユーザー定義のフィルタプリセット / user-defined filter presets
  progressLineColor: string; // 稲妻線の色 / progress line color
  // タグの既定色。空文字＝Obsidian 本体のタグ色に従う / default tag color; empty = follow Obsidian's own tag color
  defaultTagColor: string;
  // 色を指定したタグだけを保持する（載っている＝色を指定している）。色は常に具体値
  // only tags with an explicit colour are listed (listed ⇔ coloured); the colour is never empty
  tagColors: { name: string; color: string }[];
  folderColors: { name: string; color: string }[];
  assigneeColors: { name: string; color: string }[]; // 担当者の表示名ごとの色 / colours keyed by an assignee's display name
  // グループ見出しのアイコン（キーは "<グループ化の軸>:<見出し名>"）/ group heading icons, keyed "<group-by axis>:<heading>"
  icons: Record<string, string>;
  // ボードごとの表示。キーは "folder:<パス>"（"folder:" は Vault ルート。将来の Bases 用に "base:<id>" を空けておく）
  // each board's view setup, keyed "folder:<path>" ("folder:" = vault root; "base:<id>" is left free for Bases boards)
  boards: Record<string, BoardState>;
  // 通知（Discord / Slack の Incoming Webhook）/ notifications via incoming webhooks
  notify: {
    discordWebhook: string; // 空欄で無効 / empty disables
    slackWebhook: string;
    teamsWebhook: string; // Power Automate Workflows の Webhook / Power Automate Workflows webhook
    notifyStart: boolean; // 開始を通知するか / notify for start
    notifyEnd: boolean; // 期限を通知するか / notify for due
    leads: string[]; // 有効なリードタイムID（1w/1d/1h/10m/0）/ enabled lead ids
    sent: Record<string, number>; // 送信済みキー→送信時刻（二重通知防止）/ sent keys → timestamp (dedupe)
  };
  // Google カレンダー双方向同期 / Google Calendar two-way sync
  gcal: {
    clientId: string; // ユーザー自身の GCP OAuth クライアント / the user's own GCP OAuth client
    // クライアントシークレットとリフレッシュトークンは SecretStorage に置く（gcal/secrets.ts）
    // the client secret and refresh token live in SecretStorage (gcal/secrets.ts)
    calendarId: string; // 同期先カレンダー / target calendar
    calendarName: string; // 表示用 / display only
    pushEnabled: boolean; // タスク → GCal / task → GCal
    pullEnabled: boolean; // GCal → タスク / GCal → task
    optInOnly: boolean; // true=フロントマターにフラグのあるタスクのみ / only tasks carrying the opt-in flag
    scopeFolder: string; // 空=既定フォルダに従う / empty = follow the default folder
    pullIntervalMin: number; // Pull の間隔（分）/ pull interval in minutes
    deleteEventOnTaskDelete: boolean;
    onEventDeleted: "unlink" | "clearDates"; // GCal 側で削除されたときの挙動 / behavior when the event is deleted remotely
    syncToken: string; // 増分 Pull 用 / incremental pull token
    lastSync: number; // 最終成功時刻 (epoch ms) / last successful sync
    lastError: string; // 直近のエラー（設定画面に表示）/ latest error, shown in settings
    state: Record<string, GcalSyncState>; // パス → 同期スナップショット / path → sync snapshot
  };
  // フロントマターのキー名（プロジェクトに合わせて変更可）/ frontmatter key names
  keys: {
    start: string;
    end: string;
    status: string;
    assignee: string;
    after: string;
    progress: string;
    milestone: string;
    parent: string;
    gcalId: string; // イベント ID の保存先 / where the event id is stored
    gcal: string; // オプトインフラグ / the opt-in flag
    canvas: string; // キャンバス型タスクの .canvas へのリンク / a canvas task's link to its .canvas
    priority: string; // 優先度（urgent で割り込みの急ぎ仕事）/ priority (urgent marks interrupting work)
  };
}

// この端末の利用者の名前（「自分の仕事」用。端末ごとで同期しない）/ this device's user name (for "My work"; per device, never synced)
export const ME_KEY = "task-gantt-me";

// ボードの表示の組み立て（開き直しても保つ）/ a board's view setup, kept across reopening
export interface BoardState {
  groupBy: "folder" | "status" | "assignee" | "tag";
  colorBy: "status" | "assignee";
  flat: boolean;
  rollup: boolean;
  progressLine: boolean;
  showEmptyFolders: boolean;
  showDeps: boolean; // 依存の矢印を描くか / whether dependency arrows are drawn
  showTags: boolean; // バーにタグを出すか / whether tags show on the bars
  collapsed: string[];
  expanded?: string[]; // 開いた親タスク（パス。親は既定で畳む）/ expanded parent tasks (paths; parents start collapsed)
  order?: string[]; // 手で決めた行の並び（タスクのパス）/ the manual row order (task paths)
  disabled?: string[]; // 止めたタスク（パス。ノートには書かない）/ disabled tasks (paths; nothing is written to the notes)
}

// タスク1件分の同期スナップショット（ループ防止と差分検出に使う）
// per-task sync snapshot (drives loop prevention and change detection)
export interface GcalSyncState {
  id: string; // イベント ID / event id
  hash: string; // 最終同期時のローカル内容ハッシュ / local fingerprint at last sync
  etag: string; // 最終同期時のイベント etag（エコー判定）/ event etag at last sync (echo detection)
  at: number; // 同期時刻 / synced at (epoch ms)
  link?: string; // イベントの htmlLink / the event's htmlLink
}

export const DEFAULT_SETTINGS: GanttSettings = {
  rootFolder: "",
  recurse: true,
  statuses: [
    { id: "todo", label: "To do", color: "#9aa0a6", group: "active" },
    { id: "in-progress", label: "In progress", color: "#3b82f6", group: "active" },
    // 手が止まっている状態なので Wrike の Deferred に置く / stalled work maps to Wrike's Deferred
    { id: "blocked", label: "Blocked", color: "#ef4444", group: "deferred" },
    { id: "done", label: "Done", color: "#22c55e", group: "completed" },
  ],
  defaultZoom: "Week",
  dateFormat: "YYYY/MM/DD",
  tz: "system",
  nonWorkingDays: [0, 6],
  autoScheduleFS: true,
  autoStatus: { enabled: false, started: "", finished: "", notStarted: [], fired: {} },
  detailWidth: 380,
  // 一目で要るもの：担当・ステータス・進捗・期限（開始はバーが示す）/ what a glance needs: assignee, status, progress, due (the bar shows the start)
  visibleColumns: ["assignee", "status", "progress", "end"],
  columnOrder: ["assignee", "status", "progress", "end", "start", "duration", "tags"], // 誰が・どの状態・どこまで・いつまで / who, what state, how far, by when
  columnWidths: {},
  sortBy: "start",
  sortDir: "asc",
  customFields: [],
  filters: [],
  filterMatch: "all",
  filterPresets: [],
  progressLineColor: "#f59e0b", // 既定はバー色と重なりにくい橙 / amber, unlikely to clash with bar colors
  defaultTagColor: "", // 空＝Obsidian 本体のタグ色 / empty = Obsidian's own tag color
  tagColors: [],
  folderColors: [],
  assigneeColors: [],
  icons: {},
  boards: {},
  notify: {
    discordWebhook: "",
    slackWebhook: "",
    teamsWebhook: "",
    notifyStart: true,
    notifyEnd: true,
    leads: ["1d", "1h", "10m"],
    sent: {},
  },
  gcal: {
    clientId: "",
    calendarId: "",
    calendarName: "",
    pushEnabled: true,
    pullEnabled: true,
    optInOnly: true,
    scopeFolder: "",
    pullIntervalMin: 5,
    deleteEventOnTaskDelete: true,
    onEventDeleted: "unlink",
    syncToken: "",
    lastSync: 0,
    lastError: "",
    state: {},
  },
  keys: {
    start: "start",
    end: "end",
    status: "status",
    assignee: "assignee",
    after: "after",
    progress: "progress",
    milestone: "milestone",
    parent: "parent",
    gcalId: "gcalId",
    gcal: "gcal",
    canvas: "canvas",
    priority: "priority",
  },
};

// 設定タブは宣言的な getSettingDefinitions()（1.13 以降）で描き、それより前の Obsidian では同じ定義を
// display() が従来の Setting で描く（両方とも definitions() から作るのでずれない）。
// The settings tab renders declaratively through getSettingDefinitions() (1.13+); older Obsidian falls back to
// display(), which draws the same definitions with classic Settings (both come from definitions(), so they can't drift).
export class GanttSettingTab extends PluginSettingTab {
  plugin: GanttPlugin;

  // 宣言版で描画されているか。getSettingDefinitions() は 1.13 以降でしか呼ばれないので、
  // これが true なら再描画は update()、false なら display() 側の draw() を使う。
  // whether the tab renders declaratively: getSettingDefinitions() is only called on 1.13+,
  // so true means redraw via update(), false means redraw via the display()-side draw().
  private declarative = false;


  constructor(app: App, plugin: GanttPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private save(): void {
    void this.plugin.saveSettings();
  }

  // 設定画面の外（表の右クリックなど）から色を変えたときに、開いていれば描き直す
  // redraw from outside the tab (e.g. a right-click in the table) when it happens to be open
  refreshIfOpen(): void {
    if (this.declarative) this.updateDeclarative();
    else if (this.containerEl.firstChild) this.draw();
  }

  // 構造が変わる操作のあとの描き直し。描画経路に応じて振り分ける
  // redraw after a change that alters the structure, routed by which renderer is in use
  private redraw(): void {
    if (this.declarative) this.updateDeclarative();
    else this.draw();
  }

  // update() は @since 1.13.0。minAppVersion 1.11.4 を保つため型付きの直接呼び出しを避け、
  // 実行時に存在するときだけ呼ぶ（1.12 以下では declarative が false なのでそもそも通らない）。
  // update() is @since 1.13.0; to keep minAppVersion at 1.11.4 we avoid a typed direct call and
  // invoke it only when it exists at runtime (on 1.12 and older, `declarative` is never true).
  private updateDeclarative(): void {
    (this as unknown as { update?: () => void }).update?.();
  }

  // ===== 各入力欄の組み立て（推奨の getSettingDefinitions と display() フォールバックで共有）=====
  // ===== control builders shared by getSettingDefinitions and the display() fallback =====
  private ctlRootFolder(setting: Setting): void {
    const s = this.plugin.settings;
    // 打ち終えたとき（確定時）にだけ保存する（打ちかけのフォルダでボードを読み直さない）/ saved on commit only, so boards don't reload on a half-typed folder
    setting.addText((t) => {
      t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(s.rootFolder);
      t.inputEl.addEventListener("change", () => {
        s.rootFolder = t.getValue().trim();
        this.save();
      });
    });
  }

  private ctlRecurse(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addToggle((t) => t.setValue(s.recurse).onChange((v) => { s.recurse = v; this.save(); }));
  }

  private ctlZoom(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((d) =>
      d.addOptions({ Day: tr().zoomDay, Week: tr().zoomWeek, Month: tr().zoomMonth, Fit: tr().zoomFit }).setValue(s.defaultZoom).onChange((v) => {
        s.defaultZoom = v as ZoomMode;
        this.save();
      })
    );
  }

  private ctlDateFormat(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((d) =>
      d
        .addOptions({ "YYYY/MM/DD": "YYYY/MM/DD", "DD/MM/YYYY": "DD/MM/YYYY", "MM/DD/YYYY": "MM/DD/YYYY" })
        .setValue(s.dateFormat)
        .onChange((v) => { s.dateFormat = v as DateFormat; this.save(); })
    );
  }

  private ctlTimezone(setting: Setting): void {
    const s = this.plugin.settings;
    const opts: Record<string, string> = { system: tr().setTimezoneSystem };
    // 代表都市付きで一覧化 / list offsets with representative cities
    for (const [v, cities] of TZ_CITIES) opts[v] = `GMT${v} — ${cities}`;
    // 旧バージョンで保存した一覧外のオフセットも選択肢に残す / keep a saved offset selectable even if it left the list
    if (s.tz !== "system" && !opts[s.tz]) opts[s.tz] = `GMT${s.tz}`;
    setting.addDropdown((d) => d.addOptions(opts).setValue(s.tz).onChange((v) => { s.tz = v; this.save(); }));
  }

  // 休日の曜日（よくある組み合わせから選ぶ。一覧外の保存値もそのまま残す）
  // non-working weekdays, picked from common patterns (a saved value outside the list stays selectable)
  private ctlNonWorkingDays(setting: Setting): void {
    const s = this.plugin.settings;
    // キーは数字だけにしない（整数風のキーはオブジェクトの先頭へ並び替わり、選択肢の順が崩れる）
    // keys aren't bare digits: integer-like keys get hoisted to the front of an object and reorder the options
    const presets: Record<string, number[]> = { satSun: [0, 6], friSat: [5, 6], sun: [0], none: [] };
    const opts: Record<string, string> = {
      satSun: tr().setWeekendSatSun,
      friSat: tr().setWeekendFriSat,
      sun: tr().setWeekendSun,
      none: tr().setWeekendNone,
    };
    const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x) => b.includes(x));
    let cur = Object.keys(presets).find((k) => same(presets[k], s.nonWorkingDays));
    if (!cur) {
      cur = "custom";
      opts.custom = [...s.nonWorkingDays].sort((a, b) => a - b).join(",");
      presets.custom = [...s.nonWorkingDays];
    }
    setting.addDropdown((d) =>
      d.addOptions(opts).setValue(cur).onChange((v) => {
        s.nonWorkingDays = [...(presets[v] ?? [])];
        this.save();
      })
    );
  }

  private ctlAutoScheduleFS(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addToggle((t) => t.setValue(s.autoScheduleFS).onChange((v) => { s.autoScheduleFS = v; this.save(); }));
  }

  // ===== 日付による自動ステータス / automatic status by date =====
  private ctlAutoStatus(setting: Setting): void {
    const a = this.plugin.settings.autoStatus;
    setting.addToggle((t) => t.setValue(a.enabled).onChange((v) => {
      a.enabled = v;
      this.save();
    }));
  }

  // 開始後（「進行中」グループ）・完了後（「完了」グループ）のステータス。表示する値は既定を解決したもの
  // the started (active group) or finished (completed group) status; the shown value is the resolved default
  private ctlAutoStatusTarget(setting: Setting, which: "started" | "finished"): void {
    const s = this.plugin.settings;
    const group = which === "started" ? "active" : "completed";
    const cur = autoStatusTargets(s.statuses, s.autoStatus)[which];
    setting.addDropdown((d) => {
      if (!cur) d.addOption("", "—"); // 当てはまるステータスがまだ無い / no matching status yet
      for (const st of s.statuses.filter((x) => x.group === group)) d.addOption(st.id, st.label);
      d.setValue(cur ?? "").onChange((v) => {
        s.autoStatus[which] = v;
        this.save();
        if (which === "started") this.redraw(); // 未着手の候補が変わる / the not-started choices change
      });
    });
  }

  // 未着手とみなすステータス（「進行中」グループのうち開始後以外）。最後の 1 つは外せない（空は既定に戻ってしまうため）
  // the statuses that count as not started (active ones other than the started target); the last one can't be unticked (empty means the default)
  private ctlAutoStatusNotStarted(setting: Setting): void {
    const s = this.plugin.settings;
    const { started, notStarted } = autoStatusTargets(s.statuses, s.autoStatus);
    const host = setting.controlEl.createDiv({ cls: "ogantt-setting-checks" });
    const boxes: HTMLInputElement[] = [];
    for (const st of s.statuses.filter((x) => x.group === "active" && x.id !== started)) {
      const item = host.createEl("label");
      const cb = item.createEl("input", { type: "checkbox", value: st.id });
      cb.checked = notStarted.includes(st.id);
      item.appendText(st.label);
      boxes.push(cb);
      cb.addEventListener("change", () => {
        s.autoStatus.notStarted = boxes.filter((b) => b.checked).map((b) => b.value);
        sync();
        this.save();
      });
    }
    const sync = () => {
      const on = boxes.filter((b) => b.checked);
      for (const b of boxes) b.disabled = on.length === 1 && b.checked;
    };
    sync();
  }

  // ===== 表の列 / table columns =====

  // 列 1 行：表に表示・上下の矢印・幅。隠した列は一覧の下に薄く並び、同じように操作できる（幅などの設定は消えない）
  // one column row: show in the table, up/down arrows and the width; hidden columns sit dimmed at the bottom and work the same (their settings are kept)
  private ctlColumnRow(setting: Setting, col: ColumnDef, on: boolean, canUp: boolean, canDown: boolean): void {
    const s = this.plugin.settings;
    setting.setName(col.label()).setClass("ogantt-col-row");
    if (!on) setting.setClass("ogantt-col-off");
    setting.addToggle((t) => {
      t.setValue(on).onChange((v) => this.changeColumns(`${col.id}|0`, () => Object.assign(s, toggleColumn(allColumns(this.plugin.settings), s.visibleColumns, s.columnOrder, col.id, v))));
      t.toggleEl.setAttr("aria-label", `${tr().setColumnShown}: ${col.label()}`);
      t.toggleEl.dataset.col = `${col.id}|0`;
    });
    for (const dir of [-1, 1] as const) {
      setting.addButton((b) => {
        b.setIcon(dir < 0 ? "arrow-up" : "arrow-down")
          .setTooltip(dir < 0 ? tr().colMoveUp(col.label()) : tr().colMoveDown(col.label()))
          .setDisabled(dir < 0 ? !canUp : !canDown)
          .onClick(() => this.changeColumns(`${col.id}|${dir}`, () => {
            s.columnOrder = moveColumn(allColumns(this.plugin.settings), s.visibleColumns, s.columnOrder, col.id, dir) ?? s.columnOrder;
          }));
        b.buttonEl.addClass("clickable-icon");
        b.buttonEl.dataset.col = `${col.id}|${dir}`;
      });
    }
    // 幅（空欄＝既定幅）。隠した列も変えられる / the width (blank = the default); hidden columns can be changed too
    setting.addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "40";
      t.inputEl.addClass("ogantt-col-width");
      t.inputEl.setAttr("aria-label", `${tr().setColumnWidth}: ${col.label()}`);
      const w = s.columnWidths[col.id];
      t.setPlaceholder(String(col.width)).setValue(w != null ? String(w) : "").onChange((v) => {
        const n = Math.round(Number(v));
        if (!v.trim()) delete s.columnWidths[col.id];
        else if (n >= 40) s.columnWidths[col.id] = n;
        else return;
        this.save();
      });
    });
  }

  // 列の表示・並びを変えて描き直し、フォーカスを同じ操作へ戻す（端で押せなくなった矢印なら反対向きへ）
  // change the columns' visibility or order, redraw, and put focus back on the same control (on the other arrow once one is disabled at an end)
  private changeColumns(focus: string, change: () => void): void {
    change();
    this.save();
    this.redraw();
    window.setTimeout(() => {
      const el = this.containerEl.querySelector<HTMLElement>(`[data-col="${CSS.escape(focus)}"]`);
      const row = el?.closest(".setting-item");
      (el?.matches(":disabled") ? row?.querySelector<HTMLElement>("button:not(:disabled)") : el)?.focus();
    }, 0);
  }

  // 色の選択欄：色見本のボタンでパレット（＋カスタム）を開く / a colour control: a swatch button that opens the palette (+ custom)
  private ctlColor(setting: Setting, get: () => string, set: (color: string) => void): Setting {
    return setting.addButton((b) => {
      b.buttonEl.addClass("ogantt-swatch");
      b.buttonEl.setAttr("aria-label", tr().setStatusColor);
      b.buttonEl.style.background = get();
      b.onClick(() => pickColor(b.buttonEl, get(), (c) => {
        set(c);
        b.buttonEl.style.background = c;
        this.save();
      }));
    });
  }

  // 稲妻線の色（パレット＋既定に戻すボタン）/ progress line color (palette + reset to default)
  // この端末の名前は data.json ではなく端末のローカルストレージへ（共有の Vault で人ごとに違う）/ this device's name lives in local storage, not data.json (it differs per person in a shared vault)
  private ctlMe(setting: Setting): void {
    const app = this.plugin.app;
    setting.addText((t) => t.setValue((app.loadLocalStorage(ME_KEY) as string | null) ?? "").onChange((v) => app.saveLocalStorage(ME_KEY, v.trim() || null)));
  }

  private ctlProgressLineColor(setting: Setting): void {
    const s = this.plugin.settings;
    this.ctlColor(setting, () => s.progressLineColor || DEFAULT_SETTINGS.progressLineColor, (c) => (s.progressLineColor = c))
      .addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip(tr().setResetTooltip).onClick(() => {
          s.progressLineColor = DEFAULT_SETTINGS.progressLineColor;
          this.save();
          this.redraw(); // ピッカーの表示値を戻す / refresh the picker's shown value
        })
      );
  }

  // 一覧の列名。行には名前欄が無く id/ラベル/グループ/色が並ぶだけなので、どれが何かを見出しで示す。
  // 列はグリッド（.ogantt-status-row）が決めるので、見出しの 4 つとコントロールの 4 つが同じ列に載る
  // column names for the list: a row is just id/label/group/color with no name field, so say which is
  // which. The grid on .ogantt-status-row places the columns, so the four labels land on the four
  // controls regardless of how wide each control renders
  private ctlStatusHeader(setting: Setting): void {
    setting.setClass("ogantt-setting-row").setClass("ogantt-status-row").setClass("ogantt-setting-head");
    const c = setting.controlEl;
    c.createSpan({ text: tr().setStatusId });
    c.createSpan({ text: tr().setStatusLabel });
    c.createSpan({ text: tr().setStatusGroup });
    c.createSpan({ text: tr().setStatusColor });
  }

  // ステータス 1 行（削除ボタンまで含む）。宣言版の onDelete は使わず行に持たせることで、
  // 一覧の先頭に列見出しの行を差し込んでも削除の対象がずれない
  // one status row, delete button included: keeping deletion on the row instead of the framework's
  // onDelete means a column-header row at the top of the list can't throw off which row gets removed
  private ctlStatusRow(setting: Setting, st: StatusDef): void {
    setting
      .addText((t) => {
        // id は打ち終えたとき（確定時）にだけ変えて保存する（打ちかけの id で自動ステータスが動かないように）。自動ステータスの行き先・未着手の一覧もついて行く
        // the id changes and saves only on commit (so automatic status never runs on a half-typed id); the automatic-status targets follow it
        t.setPlaceholder(tr().setStatusId).setValue(st.id);
        t.inputEl.addEventListener("change", () => {
          const was = st.id;
          st.id = t.getValue().trim();
          renameAutoStatusId(this.plugin.settings.autoStatus, was, st.id);
          this.save();
        });
      })
      .addText((t) => {
        t.setPlaceholder(tr().setStatusLabel).setValue(st.label).onChange((v) => { st.label = v; this.save(); });
        // 名前で覚えている見出しのアイコン・畳み状態は、打ち終えたとき（確定時）にまとめて付け替える / the heading icon and collapse state kept by name move once, on commit
        let was = st.label;
        t.inputEl.addEventListener("change", () => {
          this.plugin.renameStatusKeys(was, st.label);
          was = st.label;
          this.save();
        });
      })
      // グループ（完了/未完了の判定に使う。種類は Wrike と同じ 4 固定）
      // the group behind the completed/incomplete distinction; the four are fixed, as in Wrike
      .addDropdown((d) => {
        for (const g of STATUS_GROUPS) d.addOption(g, statusGroupLabel(g));
        d.setValue(st.group)
          .onChange((v) => {
            const warned = this.statusGroupWarning() !== undefined;
            st.group = v as StatusGroup;
            this.save();
            // 注意書きの有無が変わったときだけ描き直す（毎回だと入力中のフォーカスが飛ぶ）
            // redraw only when the advisory appears or disappears; doing it always steals focus
            if (warned !== (this.statusGroupWarning() !== undefined)) this.redraw();
          })
          .selectEl.setAttr("aria-label", tr().setStatusGroup);
      });
    this.ctlColor(setting, () => st.color, (c) => (st.color = c))
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
          // 番号ではなく行そのものを探して消す（描画後に並びが変わっていても巻き込まない）
          // locate the row by identity, not by index, so a reordered list can't take out the wrong one
          const live = this.plugin.settings.statuses;
          const at = live.indexOf(st);
          if (at >= 0) live.splice(at, 1);
          renameAutoStatusId(this.plugin.settings.autoStatus, st.id, null);
          this.save();
          this.redraw();
        })
      );
  }

  // Custom field 一覧の列見出し（キー / 表示名 / 種類）/ column names for the custom field list (key / label / type)
  private ctlCustomFieldHeader(setting: Setting): void {
    setting.setClass("ogantt-setting-row").setClass("ogantt-cf-row").setClass("ogantt-setting-head");
    const c = setting.controlEl;
    c.createSpan({ text: tr().setCfKey });
    c.createSpan({ text: tr().setCfLabel });
    c.createSpan({ text: tr().setCfType });
  }

  // Custom field 1 行（キー・表示名・種類・削除）。キーは打つたびではなく確定時（Enter・フォーカス外れ）に反映する。
  // 打ち替えの途中で列が別のプロパティを読んで空になるのを防ぎ、ノート側のキー変更も確定時に尋ねるため
  // one custom field row (key, label, type, delete). The key applies on commit (Enter / blur), not per keystroke,
  // so the column doesn't read some half-typed property and go blank, and renaming it in notes is asked once
  private ctlCustomFieldRow(setting: Setting, f: CustomField): void {
    setting
      .addText((t) => {
        t.setPlaceholder(tr().setCfKey).setValue(f.key);
        t.inputEl.addEventListener("change", () => this.commitCustomFieldKey(f, t));
      })
      .addText((t) => t.setPlaceholder(tr().setCfLabel).setValue(f.label).onChange((v) => { f.label = v; this.save(); }))
      .addDropdown((d) => {
        d.addOption("text", tr().cfTypeText).addOption("number", tr().cfTypeNumber).addOption("date", tr().cfTypeDate);
        d.setValue(f.type)
          .onChange((v) => { f.type = v as CustomFieldType; this.save(); })
          .selectEl.setAttr("aria-label", tr().setCfType);
      })
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
          // 列の表示・幅・並べ替えの設定も片付ける（ノートの値には触れない）
          // tidy up the column's visibility, width and sort (the values in notes are left alone)
          const s = this.plugin.settings;
          const at = s.customFields.indexOf(f);
          if (at >= 0) s.customFields.splice(at, 1);
          const col = `cf:${f.id}`;
          s.visibleColumns = s.visibleColumns.filter((c) => c !== col);
          s.columnOrder = s.columnOrder.filter((c) => c !== col);
          delete s.columnWidths[col];
          if (s.sortBy === col) {
            s.sortBy = "start";
            s.sortDir = "asc";
          }
          this.save();
          this.redraw();
        })
      );
  }

  // キーの確定。旧キーの値を持つノートがあれば、ノート側のキーも変えるか尋ねる（設定画面に取り消しは無いので確認を挟む）。
  // 新旧どちらかが組み込みキー・他フィールドと重複するときは、ノートに触れず設定だけ変える
  // commit a key change. If notes hold values under the old key, ask whether to rename it there too (the settings
  // tab has no undo, hence the dialog). When either key clashes with a built-in or another field, only the setting changes
  private commitCustomFieldKey(f: CustomField, input: TextComponent): void {
    const s = this.plugin.settings;
    const oldKey = f.key.trim();
    const newKey = input.getValue().trim();
    if (oldKey === newKey) return;
    const apply = (): void => {
      const before = this.customFieldWarnings().join("|");
      f.key = newKey;
      this.save();
      // 注意書きの有無・中身が変わったときだけ描き直す（確定時なので入力中のフォーカスは奪わない）
      // redraw only when the advisory changes (this runs on commit, so no typing is interrupted)
      if (this.customFieldWarnings().join("|") !== before) this.redraw();
    };
    const reserved = new Set([...Object.values(s.keys), "tags"]);
    const clashes = (key: string): boolean => reserved.has(key) || s.customFields.some((o) => o !== f && o.key.trim() === key);
    const files = oldKey && newKey && !clashes(oldKey) && !clashes(newKey) ? filesWithFrontmatterKey(this.app, oldKey) : [];
    if (files.length === 0) {
      apply();
      return;
    }
    new ChoiceModal(this.app, {
      title: tr().cfRenameTitle,
      body: tr().cfRenameBody(files.length, oldKey, newKey),
      sub: tr().cfRenameSub,
      choices: [
        { text: tr().cfRenameSettingOnly, onPick: apply },
        {
          text: tr().cfRenameInNotes,
          cta: true,
          onPick: () => void (async () => {
            const r = await renameFrontmatterKey(this.app, files, oldKey, newKey);
            apply();
            new Notice(tr().cfRenamed(r.renamed) + (r.skipped ? `\n${tr().cfRenameSkipped(r.skipped, newKey)}` : ""));
          })(),
        },
      ],
      // 選ばずに閉じたら元のキーへ / closing without a choice reverts the key
      onDismiss: () => {
        input.setValue(oldKey);
      },
    }).open();
  }

  // Custom field を 1 件追加。id は不変（キーを変えても列の設定が外れない）。追加した列は最初から表示する
  // add a custom field; its id never changes (renaming the key keeps the column's settings), and its column starts out visible
  private addCustomField(): void {
    const s = this.plugin.settings;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    s.customFields.push({ id, key: "", label: "", type: "text" });
    s.visibleColumns = [...s.visibleColumns, `cf:${id}`];
    this.save();
    this.redraw();
  }

  // Custom field の注意書き（空キー・組み込みキーとの衝突・重複）。何も無ければ空配列＝行を置かない。
  // 行を置いて隠すだけだと、宣言版では外枠（空のグループ）が残るため
  // the custom field advisory (empty keys, clashes with built-in keys, duplicates); empty means no row at all —
  // placing a row and hiding it leaves an empty group frame behind in the declarative tab
  private customFieldWarnings(): string[] {
    const s = this.plugin.settings;
    const issues = customFieldIssues(s);
    const lines = new Set<string>();
    for (const f of s.customFields) {
      const issue = issues.get(f.id);
      if (issue === "empty") lines.add(tr().setCfEmpty);
      else if (issue === "reserved") lines.add(tr().setCfReserved(f.key.trim()));
      else if (issue === "duplicate") lines.add(tr().setCfDuplicate(f.key.trim()));
    }
    return [...lines];
  }

  // 注意書きの行の中身（1 件 1 行）/ fill the advisory row, one line per issue
  private ctlCustomFieldWarning(setting: Setting, lines: string[]): void {
    setting.setClass("ogantt-setting-warn");
    for (const line of lines) setting.descEl.createDiv({ text: line });
  }

  // 「完了」が空だと完了プリセットが常に 0 件になるので、その旨だけ伝える（禁止はしない）
  // an empty Completed group makes the completed preset always empty; say so without forbidding it
  private statusGroupWarning(): string | undefined {
    return this.plugin.settings.statuses.some((s) => s.group === "completed")
      ? undefined
      : tr().setNoCompletedStatus;
  }

  // 色を指定したタグの1行。行が存在する＝色を指定している、なので色は常に具体値を持つ
  // one row per explicitly coloured tag; a row exists only when a colour is set, so it's never empty
  private ctlTagColorRow(setting: Setting, tc: { name: string; color: string }): void {
    setting.addText((t) => t.setValue(tc.name).setDisabled(true));
    this.ctlColor(setting, () => tc.color, (c) => (tc.color = c))
      .addExtraButton((b) =>
        b.setIcon("x").setTooltip(tr().confirmDropTagColorOk).onClick(() => this.confirmRemoveTagColor(tc))
      );
  }

  // 一覧の並び。順序に意味は無く、追加元が2箇所あって挿入順が予測できないのでタグ名の昇順で固定する
  // display order: the list is a lookup table with no meaningful order, and rows arrive from two
  // different places, so insertion order is unpredictable — sort by tag name instead
  private sortedTagColors(): { name: string; color: string }[] {
    return this.plugin.settings.tagColors.slice().sort((a, b) => a.name.localeCompare(b.name));
  }

  // 色指定を解除する（＝一覧から外す）。設定画面には取り消しが無いので確認を挟む
  // drop a colour override, which removes the row; the settings tab has no undo, so confirm first
  private confirmRemoveTagColor(tc: { name: string; color: string }): void {
    new ConfirmModal(this.plugin.app, {
      title: tr().confirmDropTagColorTitle,
      body: tr().confirmDropTagColorBody(tc.name),
      sub: tr().confirmDropTagColorSub,
      confirmText: tr().confirmDropTagColorOk,
      cancelText: tr().cancel,
      onConfirm: () => {
        const live = this.plugin.settings.tagColors;
        const at = live.indexOf(tc);
        if (at >= 0) live.splice(at, 1);
        this.save();
        this.redraw();
      },
    }).open();
  }

  // 色を付けるタグを Vault の一覧から選ぶ（手入力だと名前を間違えて色が効かない）
  // pick the tag to colour from the vault's own list; typing it by hand invites a silent typo
  private pickTagToColor(): void {
    const s = this.plugin.settings;
    const taken = new Set(s.tagColors.map((c) => c.name));
    const choices = collectAllTags(this.plugin.app).filter((tag) => !taken.has(tag));
    if (choices.length === 0) {
      new Notice(tr().setNoTagsToColor);
      return;
    }
    new PickModal(this.plugin.app, choices, (tag) => tag, tr().setPickTagPlaceholder, (tag) => {
      // 既定色を初期値にして、そこから変えてもらう / seed with the default so the user edits from there
      s.tagColors.push({ name: tag, color: toHex(s.defaultTagColor || obsidianTagColor()) });
      this.save();
      this.redraw();
    }).open();
  }

  // タグの既定色（空＝名前から自動生成）/ default tag color (empty = auto from the name)
  private ctlDefaultTagColor(setting: Setting): void {
    const s = this.plugin.settings;
    this.ctlColor(setting, () => s.defaultTagColor || obsidianTagColor(), (c) => (s.defaultTagColor = c))
      .addExtraButton((b) =>
        b.setIcon("rotate-ccw").setTooltip(tr().setDefaultTagColorAuto).onClick(() => {
          s.defaultTagColor = ""; // Obsidian 本体のタグ色へ戻す / back to Obsidian's own tag color
          this.save();
          this.redraw();
        })
      );
  }

  private ctlKeyRow(setting: Setting, k: keyof GanttSettings["keys"]): void {
    const s = this.plugin.settings;
    setting.addText((t) => t.setValue(s.keys[k]).onChange((v) => { s.keys[k] = v.trim() || k; this.save(); }));
  }

  private ctlWebhook(setting: Setting, key: "discordWebhook" | "slackWebhook" | "teamsWebhook", placeholder: string): void {
    const n = this.plugin.settings.notify;
    setting.addText((t) => t.setPlaceholder(placeholder).setValue(n[key]).onChange((v) => { n[key] = v.trim(); this.save(); }));
  }

  private ctlNotifyToggle(setting: Setting, key: "notifyStart" | "notifyEnd"): void {
    const n = this.plugin.settings.notify;
    setting.addToggle((t) => t.setValue(n[key]).onChange((v) => { n[key] = v; this.save(); }));
  }

  private ctlLeadToggle(setting: Setting, id: string): void {
    const n = this.plugin.settings.notify;
    setting.addToggle((t) =>
      t.setValue(n.leads.includes(id)).onChange((v) => {
        n.leads = v ? [...new Set([...n.leads, id])] : n.leads.filter((x) => x !== id);
        this.save();
      })
    );
  }

  // ===== Google カレンダー同期の各行 / the Google Calendar sync rows =====
  // display() と getSettingDefinitions() の両方から使うため、行ごとにヘルパー化する
  // one helper per row, shared by display() and getSettingDefinitions() so the two can't drift
  private ctlGcalClientId(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addText((t) => t.setValue(g.clientId).onChange((v) => { g.clientId = v.trim(); this.save(); }));
  }

  // 入力値は data.json ではなく SecretStorage へ保存 / saved to SecretStorage, not data.json
  private ctlGcalClientSecret(setting: Setting): void {
    setting.addText((t) => {
      t.inputEl.type = "password";
      t.setValue(getClientSecret(this.plugin)).onChange((v) => setClientSecret(this.plugin, v.trim()));
    });
  }

  // 接続 / 切断（押すと接続状態が変わるので、完了後に描き直す）/ connect / disconnect, redrawn once the state flips
  private ctlGcalAccount(setting: Setting): void {
    setting.addButton((b) => {
      if (isConnected(this.plugin)) {
        // setDestructive() は @since 1.13.0 で minAppVersion 1.11.4 と両立しない（no-unsupported-api エラー）。
        // 非推奨の setWarning() も避け、それが付けるのと同じ mod-warning クラスを直接付ける。
        // setDestructive() requires @since 1.13.0, incompatible with minAppVersion 1.11.4 (trips no-unsupported-api);
        // instead of the deprecated setWarning(), add the same mod-warning class it applies.
        b.buttonEl.addClass("mod-warning");
        b.setButtonText(tr().setGcalDisconnect).onClick(() => void (async () => {
          await disconnectGoogle(this.plugin);
          this.redraw();
        })());
      } else {
        b.setButtonText(tr().setGcalConnect).setCta().onClick(() => void (async () => {
          const ok = await connectGoogle(this.plugin);
          if (ok) this.redraw();
        })());
      }
    });
  }

  // 同期先カレンダー（一覧は非同期で取得して差し込む）/ target calendar (the list loads asynchronously)
  private ctlGcalCalendar(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addDropdown((d) => {
      if (g.calendarId) d.addOption(g.calendarId, g.calendarName || g.calendarId);
      else d.addOption("", "—");
      d.setValue(g.calendarId);
      // 宣言版は未接続でも（非表示の）行を描くので、接続中だけ一覧を取りに行く / the declarative tab renders hidden rows too, so only fetch while connected
      if (!isConnected(this.plugin)) return;
      void listCalendars(this.plugin)
        .then((cals) => {
          d.selectEl.empty();
          if (!g.calendarId) d.addOption("", "—");
          for (const c of cals) d.addOption(c.id, c.summary + (c.primary ? " ★" : ""));
          d.setValue(g.calendarId);
          d.onChange((v) => {
            g.calendarId = v;
            g.calendarName = cals.find((c) => c.id === v)?.summary ?? v;
            // カレンダーを替えたら同期状態はリセット / switching calendars resets the sync state
            g.syncToken = "";
            g.state = {};
            this.save();
          });
        })
        .catch((e) => console.error("Task Gantt: calendar list failed", e));
    });
  }

  private ctlGcalToggle(setting: Setting, key: "pushEnabled" | "pullEnabled" | "optInOnly" | "deleteEventOnTaskDelete"): void {
    const g = this.plugin.settings.gcal;
    setting.addToggle((t) => t.setValue(g[key]).onChange((v) => { g[key] = v; this.save(); }));
  }

  private ctlGcalScope(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    // 打ち終えたとき（確定時）にだけ保存する（打ちかけのフォルダで同期の範囲が変わらない）/ saved on commit only, so a half-typed folder never becomes the sync scope
    setting.addText((t) => {
      t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(g.scopeFolder);
      t.inputEl.addEventListener("change", () => {
        g.scopeFolder = t.getValue().trim();
        this.save();
      });
    });
  }

  private ctlGcalInterval(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addDropdown((d) => {
      for (const m of [1, 5, 10, 30, 60]) d.addOption(String(m), String(m));
      d.setValue(String(g.pullIntervalMin)).onChange((v) => { g.pullIntervalMin = Number(v); this.save(); });
    });
  }

  private ctlGcalOnDeleted(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addDropdown((d) =>
      d
        .addOptions({ unlink: tr().gcalUnlinkOption, clearDates: tr().gcalClearDatesOption })
        .setValue(g.onEventDeleted)
        .onChange((v) => { g.onEventDeleted = v as "unlink" | "clearDates"; this.save(); })
    );
  }

  private ctlGcalSyncNow(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addButton((b) =>
      b.setButtonText(tr().setGcalSyncNow).onClick(() => void (async () => {
        const ok = await syncGcal(this.plugin, { pull: true });
        new Notice(ok ? tr().gcalSyncDone : `⚠️ ${g.lastError || "(console)"}`);
        this.redraw(); // 最終同期時刻・エラー表示を更新 / refresh the last-sync time and any error
      })())
    );
  }

  // 「今すぐ同期」行の説明（最終同期時刻 or 直近のエラー）/ the sync-now row's description
  private gcalStatusDesc(): string {
    const g = this.plugin.settings.gcal;
    if (g.lastError) return `⚠️ ${g.lastError}`;
    return g.lastSync ? tr().gcalLastSync(new Date(g.lastSync).toLocaleString()) : "";
  }

  // ===== getSettingDefinitions()（@since 1.13.0・宣言的設定）=====
  // 1.13 以降はこちらが使われ、display() は呼ばれない。1.12 以下は本メソッドを知らないので
  // display() にフォールバックする（公式の Path B）。行の中身は ctl* ヘルパーを両経路で共有し、
  // 二重管理によるズレを防ぐ。ここでは 1.13 専用の実行時 API を一切呼ばない。
  // ===== getSettingDefinitions() (@since 1.13.0, declarative settings) =====
  // Used from 1.13 on, where display() is skipped; older versions don't know this method and fall
  // back to display() (the official Path B). Row contents come from the shared ctl* helpers so the
  // two paths can't drift. No 1.13-only runtime API is called from here.
  getSettingDefinitions(): SettingDefinitionItem[] {
    this.declarative = true; // 再描画の経路を update() 側へ / route redraws to update()
    return this.definitions();
  }

  // 設定項目の定義（宣言版と display() の両方がここから描く）/ the setting definitions both renderers draw from
  private definitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const connected = (): boolean => Platform.isDesktop && isConnected(this.plugin);

    const statusWarn = this.statusGroupWarning();
    const cfWarnings = this.customFieldWarnings();

    const items: SettingDefinitionItem[] = [
      { name: tr().setDefaultFolderName, desc: tr().setDefaultFolderDesc, render: (x) => this.ctlRootFolder(x) },
      { name: tr().setRecurseName, desc: tr().setRecurseDesc, render: (x) => this.ctlRecurse(x) },
      { name: tr().setDefaultZoomName, render: (x) => this.ctlZoom(x) },
      { name: tr().setDateFormatName, render: (x) => this.ctlDateFormat(x) },
      { name: tr().setMeName, desc: tr().setMeDesc, render: (x) => this.ctlMe(x) },
      { name: tr().setTimezoneName, desc: tr().setTimezoneDesc, render: (x) => this.ctlTimezone(x) },
      { name: tr().setNonWorkingDaysName, desc: tr().setNonWorkingDaysDesc, render: (x) => this.ctlNonWorkingDays(x) },
      { name: tr().setAutoScheduleFSName, desc: tr().setAutoScheduleFSDesc, render: (x) => this.ctlAutoScheduleFS(x) },
      {
        name: tr().setProgressLineColorName,
        desc: tr().setProgressLineColorDesc,
        render: (x) => this.ctlProgressLineColor(x),
      },
      // 日付による自動ステータス（見つけやすいよう、全般の設定のすぐ後）/ automatic status by date (right after the general settings, easy to find)
      {
        type: "group",
        heading: tr().setAutoStatusHeading,
        items: [
          { name: tr().setAutoStatusName, desc: tr().setAutoStatusDesc, render: (x) => this.ctlAutoStatus(x) },
          // 行き先は OFF のうちから選べる（ON にした最初の実行から選んだとおりに動く）/ the targets can be picked while it's off, so the first run already follows them
          { name: tr().setAutoStatusStarted, render: (x) => this.ctlAutoStatusTarget(x, "started") },
          { name: tr().setAutoStatusNotStarted, render: (x) => this.ctlAutoStatusNotStarted(x) },
          { name: tr().setAutoStatusFinished, render: (x) => this.ctlAutoStatusTarget(x, "finished") },
        ],
      },
      // ステータス（追加はフレームワークの list、削除は行内のゴミ箱）/ statuses (the list owns add; rows own delete)
      {
        type: "list",
        heading: tr().setStatusesHeading,
        // name を空にして行ラベルを出さない（id/ラベル欄と二重表示になるため）。
        // 行のクラスは render 内で付ける（定義側に cls が無いため）。
        // 先頭は列見出しの行。onDelete を使わない＝どの行にも削除ボタンが付かないので、
        // 見出し行が一覧に混ざっても消せてしまう心配がない
        // an empty name keeps the row label out (it would duplicate the id/label fields);
        // the row class goes on inside render, since definitions have no `cls` field.
        // The first entry is the column-header row: with no onDelete, the framework adds no delete
        // buttons at all, so a header sitting among the rows can't be deleted by mistake
        items: [
          { name: "", render: (x) => this.ctlStatusHeader(x) },
          ...s.statuses.map((st): SettingGroupItem => ({
            name: "",
            render: (x) => {
              x.setClass("ogantt-setting-row").setClass("ogantt-status-row");
              this.ctlStatusRow(x, st);
            },
          })),
        ],
        addItem: {
          name: tr().setAddStatus,
          action: () => {
            // 凡例からの追加と同じ決まり（重ならない id・まだ使っていない色）/ the same rule as adding from the legend (a unique id, an unused colour)
            s.statuses.push(newStatus(s.statuses, "New"));
            this.save();
            this.redraw(); // 1.13 より前の設定画面も描き直す / the pre-1.13 settings tab redraws too
          },
        },
      },
      // 「完了」グループが空のときだけ出る注意書き。一覧の直後に置くと文脈が伝わる
      // shown only when the Completed group is empty; right after the list, where it reads in context
      ...(statusWarn
        ? [{ name: "", desc: statusWarn, render: (x: Setting) => { x.setClass("ogantt-setting-warn"); } }]
        : []),
      // Custom field（説明→列見出し→行、追加はフレームワークの list、削除は行内のゴミ箱）
      // custom fields: description, column header, rows; the list owns add, rows own delete
      {
        type: "list",
        heading: tr().setCustomFieldsHeading,
        items: [
          { name: "", desc: tr().setCustomFieldsDesc, render: () => {} },
          ...(s.customFields.length > 0 ? [{ name: "", render: (x: Setting) => this.ctlCustomFieldHeader(x) }] : []),
          ...s.customFields.map((f): SettingGroupItem => ({
            name: "",
            render: (x) => {
              x.setClass("ogantt-setting-row").setClass("ogantt-cf-row");
              this.ctlCustomFieldRow(x, f);
            },
          })),
        ],
        addItem: { name: tr().setAddCustomField, action: () => this.addCustomField() },
      },
      // 注意書きがあるときだけ置く / the advisory, only when there is something to say
      ...(cfWarnings.length > 0 ? [{ name: "", render: (x: Setting) => this.ctlCustomFieldWarning(x, cfWarnings) }] : []),
      // 表の列：表示中の列を表の順に、その下に隠した列 / table columns: the shown ones in table order, the hidden ones below
      {
        type: "group",
        heading: tr().setColumnsHeading,
        items: [
          { name: "", desc: tr().setColumnsDesc, render: () => {} }, // render が無いと宣言版は名前の無い行を描かない / without a render the declarative tab skips a nameless row
          ...columnList(allColumns(this.plugin.settings), s.visibleColumns, s.columnOrder).map(({ col, on }, i, list): SettingGroupItem => ({
            name: "",
            render: (x) => this.ctlColumnRow(x, col, on, list[i - 1]?.on === on, list[i + 1]?.on === on),
          })),
        ],
      },
      // タグの色（フォルダの色は表で右クリック）/ tag colors (folder colors via right-click in the table)
      // 見出しの無い単独項目は直前のグループ（ステータス）に吸い寄せられて見えるので、
      // 既定色は「タグの色」見出しを持つグループの中に置く
      // a headingless item reads as part of the preceding group (statuses), so the default color
      // lives inside a group that carries the "Tag colors" heading
      {
        type: "group",
        heading: tr().setTagColorsHeading,
        items: [
          {
            name: tr().setDefaultTagColorName,
            desc: tr().setDefaultTagColorDesc,
            render: (x) => this.ctlDefaultTagColor(x),
          },
        ],
      },
      {
        type: "list",
        heading: tr().setTagColorsPerTag,
        emptyState: tr().setNoTagColors,
        // 削除は行内の × に確認付きで持たせるので、フレームワークの onDelete は使わない
        // deletion lives on the row's own × with a confirm, so the framework's onDelete is not used
        items: this.sortedTagColors().map((tc): SettingGroupItem => ({
          name: "",
          render: (x) => { x.setClass("ogantt-setting-row"); this.ctlTagColorRow(x, tc); },
        })),
        addItem: { name: tr().setAddTagColor, action: () => this.pickTagToColor() },
      },
      // 通知 / notifications
      {
        type: "group",
        heading: tr().setNotifyHeading,
        items: [
          { name: tr().setNotifyHeading, desc: tr().setNotifyDesc },
          {
            name: "Discord webhook URL",
            desc: tr().setWebhookDesc,
            render: (x) => this.ctlWebhook(x, "discordWebhook", "https://discord.com/api/webhooks/…"),
          },
          {
            name: "Slack webhook URL",
            desc: tr().setWebhookDesc,
            render: (x) => this.ctlWebhook(x, "slackWebhook", "https://hooks.slack.com/services/…"),
          },
          {
            name: "Microsoft Teams webhook URL (Workflows)",
            desc: tr().setWebhookDesc,
            render: (x) => this.ctlWebhook(x, "teamsWebhook", "https://….logic.azure.com/workflows/…"),
          },
          // テスト送信＝Webhook 設定の即時確認 / send-a-test button for instant webhook verification
          { name: tr().setNotifyTestName, action: () => void sendTestNotification(this.plugin) },
          { name: tr().setNotifyStartName, render: (x) => this.ctlNotifyToggle(x, "notifyStart") },
          { name: tr().setNotifyEndName, render: (x) => this.ctlNotifyToggle(x, "notifyEnd") },
        ],
      },
      {
        type: "group",
        heading: tr().setLeadsName,
        items: LEADS.map((lead): SettingGroupItem => ({
          name: leadLabel(lead.id),
          render: (x) => this.ctlLeadToggle(x, lead.id),
        })),
      },
      // Google カレンダー同期。接続後にだけ意味を持つ行は visible で出し分ける
      // Google Calendar sync; rows that only matter once connected are gated with `visible`
      {
        type: "group",
        heading: tr().setGcalHeading,
        items: [
          // モバイルはループバック認証が使えないため案内のみ。同名の行を 2 つ置くと宣言版でキーが重複するので 1 行で出し分ける
          // mobile can't do loopback auth, so it gets a note instead; one row switches its text, as two rows of one name share a key
          { name: tr().setGcalHeading, desc: Platform.isDesktop ? tr().setGcalDesc : tr().gcalDesktopOnly },
          {
            name: tr().setGcalClientIdName,
            desc: tr().setGcalCredsDesc,
            visible: () => Platform.isDesktop,
            render: (x) => this.ctlGcalClientId(x),
          },
          {
            name: tr().setGcalClientSecretName,
            visible: () => Platform.isDesktop,
            render: (x) => this.ctlGcalClientSecret(x),
          },
          {
            name: tr().setGcalAccountName,
            desc: isConnected(this.plugin) ? tr().gcalStatusConnected : tr().gcalStatusNotConnected,
            visible: () => Platform.isDesktop,
            render: (x) => this.ctlGcalAccount(x),
          },
          { name: tr().setGcalCalendarName, visible: connected, render: (x) => this.ctlGcalCalendar(x) },
          { name: tr().setGcalPushName, visible: connected, render: (x) => this.ctlGcalToggle(x, "pushEnabled") },
          { name: tr().setGcalPullName, visible: connected, render: (x) => this.ctlGcalToggle(x, "pullEnabled") },
          {
            name: tr().setGcalOptInName,
            desc: tr().setGcalOptInDesc(s.keys.gcal),
            visible: connected,
            render: (x) => this.ctlGcalToggle(x, "optInOnly"),
          },
          {
            name: tr().setGcalScopeName,
            desc: tr().setGcalScopeDesc,
            visible: connected,
            render: (x) => this.ctlGcalScope(x),
          },
          { name: tr().setGcalPullIntervalName, visible: connected, render: (x) => this.ctlGcalInterval(x) },
          {
            name: tr().setGcalDeleteEventName,
            visible: connected,
            render: (x) => this.ctlGcalToggle(x, "deleteEventOnTaskDelete"),
          },
          { name: tr().setGcalOnEventDeletedName, visible: connected, render: (x) => this.ctlGcalOnDeleted(x) },
          {
            name: tr().setGcalSyncNow,
            desc: this.gcalStatusDesc(),
            visible: connected,
            render: (x) => this.ctlGcalSyncNow(x),
          },
        ],
      },
      // フロントマターのキー名 / frontmatter key names
      {
        type: "group",
        heading: tr().setKeysHeading,
        items: (Object.keys(s.keys) as (keyof GanttSettings["keys"])[]).map(
          (k): SettingGroupItem => ({ name: k, render: (x) => this.ctlKeyRow(x, k) })
        ),
      },
    ];
    return items;
  }

  // ===== display()（1.13 未満向けのフォールバック）=====
  // 1.13 以降は getSettingDefinitions() が使われ、このメソッドは呼ばれない。minAppVersion 1.11.4 を
  // 保つ間は 1.12.x のために残す必要があり、公式ガイドもこの併設（Path B）を案内している。
  // 非推奨 API の「呼び出し」を避けるため、再描画は this.draw() に委譲し this.display() は内部から呼ばない。
  // ===== display(): the fallback for Obsidian older than 1.13 =====
  // From 1.13 on, getSettingDefinitions() renders the tab and this method is never called. It has to
  // stay for 1.12.x while minAppVersion is 1.11.4; the official guide calls this dual setup "Path B".
  // To avoid invoking the deprecated API, redraws go via this.draw(); we never call this.display() ourselves.
  display(): void {
    this.draw();
  }

  // 宣言版と同じ定義を従来の Setting で描く（使っているのは行・グループ・リストだけ）。手書きの 2 系統がずれないように
  // draws the same definitions with classic Settings (only rows, groups and lists are used), so two hand-written paths can't drift
  private draw(): void {
    const el = this.containerEl;
    el.empty();
    const shown = (v?: boolean | (() => boolean)): boolean => (typeof v === "function" ? v() : v ?? true);
    const draw = (d: SettingDefinitionItem, i: number): void => {
      if ("type" in d) {
        if (d.type === "page" || !shown(d.visible)) return;
        if (d.heading) new Setting(el).setName(d.heading).setHeading();
        d.items?.forEach(draw);
        if (d.type !== "list") return;
        const list = d as SettingDefinitionList;
        if (!d.items?.length && list.emptyState) new Setting(el).setDesc(list.emptyState);
        const add = list.addItem;
        if (add) new Setting(el).addButton((b) => b.setButtonText(add.name).onClick(add.action));
        return;
      }
      if (!shown(d.visible)) return;
      const row = new Setting(el).setName(d.name);
      if (d.desc) row.setDesc(d.desc);
      if (d.render) (d.render as (s: Setting) => unknown)(row); // ここの描画は SettingGroup を使わない / our renders never use the SettingGroup
      const act = d.action;
      if (act) row.addButton((b) => b.setButtonText(d.name).onClick(() => act(i)));
    };
    this.definitions().forEach(draw);
  }
}
