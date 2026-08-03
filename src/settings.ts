import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
// 宣言的設定の型（@since 1.13.0）。型のみの参照で実行時 API は呼ばないため、
// minAppVersion 1.7.2 のままでも no-unsupported-api には触れない。
// declarative-settings types (@since 1.13.0); type-only references call no runtime API,
// so they don't trip no-unsupported-api while minAppVersion stays at 1.7.2.
import type { SettingDefinitionItem, SettingGroupItem } from "obsidian";
import type GanttPlugin from "./main";
import { StatusDef, StatusGroup, STATUS_GROUPS, ZoomMode, DateFormat, Filter, FilterMatch, FilterPreset } from "./types";
import { collectAllTags } from "./model";
import { ConfirmModal, TagSuggestModal } from "./modals";
import { obsidianTagColor, toHex } from "./colors";
import { t as tr, statusGroupLabel } from "./i18n";
import { LEADS, leadLabel, sendTestNotification } from "./notify";
import { connectGoogle, disconnectGoogle, isConnected } from "./gcal/auth";
import { listCalendars } from "./gcal/api";
import { syncGcal } from "./gcal/sync";

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
  detailWidth: number; // 詳細パネルの幅(px) / detail panel width (px)
  visibleColumns: string[]; // 表示する任意列（name は常時表示）/ optional columns shown (name is always shown)
  columnWidths: Record<string, number>; // 列幅の上書き(px)。未設定列は既定幅 / per-column width overrides (px); unset = default
  sortBy: string; // ソート列 id（name/start/end/progress/assignee/status/tags）/ sort column id
  sortDir: "asc" | "desc"; // ソート方向 / sort direction
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
    clientSecret: string;
    refreshToken: string; // 空=未接続。data.json に平文保存（README で開示）/ empty = not connected; stored in plain text
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
  };
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
  detailWidth: 380,
  visibleColumns: ["start", "end"],
  columnWidths: {},
  sortBy: "start",
  sortDir: "asc",
  filters: [],
  filterMatch: "all",
  filterPresets: [],
  progressLineColor: "#f59e0b", // 既定はバー色と重なりにくい橙 / amber, unlikely to clash with bar colors
  defaultTagColor: "", // 空＝Obsidian 本体のタグ色 / empty = Obsidian's own tag color
  tagColors: [],
  folderColors: [],
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
    clientSecret: "",
    refreshToken: "",
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
  },
};

// 設定タブは従来の display() で描画する。後継の getSettingDefinitions() は Obsidian 1.13.0
// （現在 Early Access）専用で、採用すると安定版 1.12.x では設定タブが表示されなくなるため、
// 1.13.0 が正式版になるまで移行しない（この警告は非ブロッキングなので許容する）。
// The settings tab uses the classic display(). Its successor getSettingDefinitions() needs
// Obsidian 1.13.0 (currently Early Access) and would blank the tab on the stable 1.12.x line,
// so we don't migrate until 1.13.0 is GA (the resulting lint warning is non-blocking).
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

  // update() は @since 1.13.0。minAppVersion 1.7.2 を保つため型付きの直接呼び出しを避け、
  // 実行時に存在するときだけ呼ぶ（1.12 以下では declarative が false なのでそもそも通らない）。
  // update() is @since 1.13.0; to keep minAppVersion at 1.7.2 we avoid a typed direct call and
  // invoke it only when it exists at runtime (on 1.12 and older, `declarative` is never true).
  private updateDeclarative(): void {
    (this as unknown as { update?: () => void }).update?.();
  }

  // ===== 各入力欄の組み立て（推奨の getSettingDefinitions と display() フォールバックで共有）=====
  // ===== control builders shared by getSettingDefinitions and the display() fallback =====
  private ctlRootFolder(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addText((t) =>
      t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(s.rootFolder).onChange((v) => {
        s.rootFolder = v.trim();
        this.save();
      })
    );
  }

  private ctlRecurse(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addToggle((t) => t.setValue(s.recurse).onChange((v) => { s.recurse = v; this.save(); }));
  }

  private ctlZoom(setting: Setting): void {
    const s = this.plugin.settings;
    setting.addDropdown((d) =>
      d.addOptions({ Day: "Day", Week: "Week", Month: "Month", Fit: "Fit" }).setValue(s.defaultZoom).onChange((v) => {
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

  // 稲妻線の色（色ピッカー＋既定に戻すボタン）/ progress line color (picker + reset to default)
  private ctlProgressLineColor(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .addColorPicker((c) =>
        c.setValue(s.progressLineColor || DEFAULT_SETTINGS.progressLineColor).onChange((v) => {
          s.progressLineColor = v;
          this.save();
        })
      )
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
      .addText((t) => t.setPlaceholder(tr().setStatusId).setValue(st.id).onChange((v) => { st.id = v.trim(); this.save(); }))
      .addText((t) => t.setPlaceholder(tr().setStatusLabel).setValue(st.label).onChange((v) => { st.label = v; this.save(); }))
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
      })
      .addColorPicker((c) => c.setValue(st.color).onChange((v) => { st.color = v; this.save(); }))
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip(tr().setDeleteTooltip).onClick(() => {
          // 番号ではなく行そのものを探して消す（描画後に並びが変わっていても巻き込まない）
          // locate the row by identity, not by index, so a reordered list can't take out the wrong one
          const live = this.plugin.settings.statuses;
          const at = live.indexOf(st);
          if (at >= 0) live.splice(at, 1);
          this.save();
          this.redraw();
        })
      );
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
    setting
      .addText((t) => t.setValue(tc.name).setDisabled(true))
      .addColorPicker((c) => c.setValue(toHex(tc.color)).onChange((v) => { tc.color = v; this.save(); }))
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
    new TagSuggestModal(this.plugin.app, choices, tr().setPickTagPlaceholder, (tag) => {
      // 既定色を初期値にして、そこから変えてもらう / seed with the default so the user edits from there
      s.tagColors.push({ name: tag, color: toHex(s.defaultTagColor || obsidianTagColor()) });
      this.save();
      this.redraw();
    }).open();
  }

  // タグの既定色（空＝名前から自動生成）/ default tag color (empty = auto from the name)
  private ctlDefaultTagColor(setting: Setting): void {
    const s = this.plugin.settings;
    setting
      .addColorPicker((c) =>
        c.setValue(toHex(s.defaultTagColor || obsidianTagColor())).onChange((v) => { s.defaultTagColor = v; this.save(); })
      )
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

  private ctlGcalClientSecret(setting: Setting): void {
    const g = this.plugin.settings.gcal;
    setting.addText((t) => {
      t.inputEl.type = "password";
      t.setValue(g.clientSecret).onChange((v) => { g.clientSecret = v.trim(); this.save(); });
    });
  }

  // 接続 / 切断（押すと接続状態が変わるので、完了後に描き直す）/ connect / disconnect, redrawn once the state flips
  private ctlGcalAccount(setting: Setting): void {
    setting.addButton((b) => {
      if (isConnected(this.plugin)) {
        // setDestructive() は @since 1.13.0 で minAppVersion 1.7.2 と両立しない（no-unsupported-api エラー）。
        // setWarning() は @deprecated だが「非推奨」は Recommendation（非ブロッキング）に留まるため、こちらを使う。
        // setDestructive() requires @since 1.13.0, incompatible with minAppVersion 1.7.2 (trips no-unsupported-api).
        // setWarning() is @deprecated but only a non-blocking Recommendation, so it's kept here instead.
        b.setButtonText(tr().setGcalDisconnect).setWarning().onClick(() => void (async () => {
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
    setting.addText((t) =>
      t.setPlaceholder(tr().setDefaultFolderPlaceholder).setValue(g.scopeFolder).onChange((v) => {
        g.scopeFolder = v.trim();
        this.save();
      })
    );
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

  // ===== Google カレンダー同期のセクション（display() 用の組み立て）=====
  // ===== the Google Calendar sync section, composed for display() =====
  private drawGcal(containerEl: HTMLElement): void {
    new Setting(containerEl).setName(tr().setGcalHeading).setDesc(tr().setGcalDesc).setHeading();

    // モバイルでは案内のみ表示（ループバック認証が使えない）/ mobile gets a note only (no loopback auth)
    if (!Platform.isDesktop) {
      new Setting(containerEl).setDesc(tr().gcalDesktopOnly);
      return;
    }

    // 認証情報（シークレットは伏せ字入力）/ credentials (the secret uses a password input)
    this.ctlGcalClientId(new Setting(containerEl).setName(tr().setGcalClientIdName).setDesc(tr().setGcalCredsDesc));
    this.ctlGcalClientSecret(new Setting(containerEl).setName(tr().setGcalClientSecretName));
    this.ctlGcalAccount(
      new Setting(containerEl)
        .setName(tr().setGcalAccountName)
        .setDesc(isConnected(this.plugin) ? tr().gcalStatusConnected : tr().gcalStatusNotConnected)
    );

    if (!isConnected(this.plugin)) return; // 以降の項目は接続後のみ / the rest only makes sense once connected

    this.ctlGcalCalendar(new Setting(containerEl).setName(tr().setGcalCalendarName));
    this.ctlGcalToggle(new Setting(containerEl).setName(tr().setGcalPushName), "pushEnabled");
    this.ctlGcalToggle(new Setting(containerEl).setName(tr().setGcalPullName), "pullEnabled");
    this.ctlGcalToggle(
      new Setting(containerEl).setName(tr().setGcalOptInName).setDesc(tr().setGcalOptInDesc(this.plugin.settings.keys.gcal)),
      "optInOnly"
    );
    this.ctlGcalScope(new Setting(containerEl).setName(tr().setGcalScopeName).setDesc(tr().setGcalScopeDesc));
    this.ctlGcalInterval(new Setting(containerEl).setName(tr().setGcalPullIntervalName));
    this.ctlGcalToggle(new Setting(containerEl).setName(tr().setGcalDeleteEventName), "deleteEventOnTaskDelete");
    this.ctlGcalOnDeleted(new Setting(containerEl).setName(tr().setGcalOnEventDeletedName));
    this.ctlGcalSyncNow(new Setting(containerEl).setName(tr().setGcalSyncNow).setDesc(this.gcalStatusDesc()));
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
    const s = this.plugin.settings;
    const connected = (): boolean => Platform.isDesktop && isConnected(this.plugin);

    const statusWarn = this.statusGroupWarning();

    const items: SettingDefinitionItem[] = [
      { name: tr().setDefaultFolderName, desc: tr().setDefaultFolderDesc, render: (x) => this.ctlRootFolder(x) },
      { name: tr().setRecurseName, desc: tr().setRecurseDesc, render: (x) => this.ctlRecurse(x) },
      { name: tr().setDefaultZoomName, render: (x) => this.ctlZoom(x) },
      { name: tr().setDateFormatName, render: (x) => this.ctlDateFormat(x) },
      { name: tr().setTimezoneName, desc: tr().setTimezoneDesc, render: (x) => this.ctlTimezone(x) },
      {
        name: tr().setProgressLineColorName,
        desc: tr().setProgressLineColorDesc,
        render: (x) => this.ctlProgressLineColor(x),
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
          { name: "", render: (x) => this.ctlStatusHeader(x) } as SettingGroupItem,
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
            s.statuses.push({ id: "new", label: "New", color: "#888888", group: "active" });
            this.save();
            this.updateDeclarative();
          },
        },
      },
      // 「完了」グループが空のときだけ出る注意書き。一覧の直後に置くと文脈が伝わる
      // shown only when the Completed group is empty; right after the list, where it reads in context
      ...(statusWarn
        ? [{ name: "", desc: statusWarn, render: (x: Setting) => { x.setClass("ogantt-setting-warn"); } }]
        : []),
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
          { name: tr().setGcalHeading, desc: tr().setGcalDesc },
          // モバイルはループバック認証が使えないため案内のみ / mobile can't do loopback auth, so it gets a note
          { name: tr().setGcalHeading, desc: tr().gcalDesktopOnly, visible: () => !Platform.isDesktop },
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
  // 1.13 以降は getSettingDefinitions() が使われ、このメソッドは呼ばれない。minAppVersion 1.7.2 を
  // 保つ間は 1.12.x のために残す必要があり、公式ガイドもこの併設（Path B）を案内している。
  // 非推奨 API の「呼び出し」を避けるため、再描画は this.draw() に委譲し this.display() は内部から呼ばない。
  // ===== display(): the fallback for Obsidian older than 1.13 =====
  // From 1.13 on, getSettingDefinitions() renders the tab and this method is never called. It has to
  // stay for 1.12.x while minAppVersion is 1.7.2; the official guide calls this dual setup "Path B".
  // To avoid invoking the deprecated API, redraws go via this.draw(); we never call this.display() ourselves.
  display(): void {
    this.draw();
  }

  private draw(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    this.ctlRootFolder(new Setting(containerEl).setName(tr().setDefaultFolderName).setDesc(tr().setDefaultFolderDesc));
    this.ctlRecurse(new Setting(containerEl).setName(tr().setRecurseName).setDesc(tr().setRecurseDesc));
    this.ctlZoom(new Setting(containerEl).setName(tr().setDefaultZoomName));
    this.ctlDateFormat(new Setting(containerEl).setName(tr().setDateFormatName));
    this.ctlTimezone(new Setting(containerEl).setName(tr().setTimezoneName).setDesc(tr().setTimezoneDesc));
    this.ctlProgressLineColor(
      new Setting(containerEl).setName(tr().setProgressLineColorName).setDesc(tr().setProgressLineColorDesc)
    );

    // ステータス一覧（列見出し＋ id/ラベル/グループ/色＋削除、末尾に追加ボタン）
    // status list: column header, then id/label/group/color + delete, with an add button at the end
    new Setting(containerEl).setName(tr().setStatusesHeading).setHeading();
    this.ctlStatusHeader(new Setting(containerEl));
    for (const st of s.statuses) {
      this.ctlStatusRow(new Setting(containerEl).setClass("ogantt-setting-row").setClass("ogantt-status-row"), st);
    }
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddStatus).setCta().onClick(() => {
        s.statuses.push({ id: "new", label: "New", color: "#888888", group: "active" });
        this.save();
        this.draw();
      })
    );
    const statusWarn = this.statusGroupWarning();
    if (statusWarn) new Setting(containerEl).setClass("ogantt-setting-warn").setDesc(statusWarn);

    // タグの色（名前＋色＋削除。フォルダの色は表で右クリック）/ tag colors (name + color + delete; folder colors via right-click in the table)
    new Setting(containerEl).setName(tr().setTagColorsHeading).setHeading();
    this.ctlDefaultTagColor(
      new Setting(containerEl).setName(tr().setDefaultTagColorName).setDesc(tr().setDefaultTagColorDesc)
    );
    new Setting(containerEl).setName(tr().setTagColorsPerTag).setHeading();
    if (s.tagColors.length === 0) new Setting(containerEl).setDesc(tr().setNoTagColors);
    for (const tc of this.sortedTagColors()) {
      this.ctlTagColorRow(new Setting(containerEl).setClass("ogantt-setting-row"), tc);
    }
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setAddTagColor).onClick(() => this.pickTagToColor())
    );

    // 通知（Discord / Slack Webhook・リードタイム）/ notifications (webhooks + lead times)
    new Setting(containerEl).setName(tr().setNotifyHeading).setDesc(tr().setNotifyDesc).setHeading();
    this.ctlWebhook(
      new Setting(containerEl).setName("Discord webhook URL").setDesc(tr().setWebhookDesc),
      "discordWebhook",
      "https://discord.com/api/webhooks/…"
    );
    this.ctlWebhook(
      new Setting(containerEl).setName("Slack webhook URL").setDesc(tr().setWebhookDesc),
      "slackWebhook",
      "https://hooks.slack.com/services/…"
    );
    this.ctlWebhook(
      new Setting(containerEl).setName("Microsoft Teams webhook URL (Workflows)").setDesc(tr().setWebhookDesc),
      "teamsWebhook",
      "https://….logic.azure.com/workflows/…"
    );
    // テスト送信＝Webhook 設定の即時確認 / send-a-test button for instant webhook verification
    new Setting(containerEl).addButton((b) =>
      b.setButtonText(tr().setNotifyTestName).onClick(() => void sendTestNotification(this.plugin))
    );
    this.ctlNotifyToggle(new Setting(containerEl).setName(tr().setNotifyStartName), "notifyStart");
    this.ctlNotifyToggle(new Setting(containerEl).setName(tr().setNotifyEndName), "notifyEnd");
    new Setting(containerEl).setName(tr().setLeadsName).setHeading();
    for (const lead of LEADS) {
      this.ctlLeadToggle(new Setting(containerEl).setName(leadLabel(lead.id)), lead.id);
    }

    // Google カレンダー同期 / Google Calendar sync
    this.drawGcal(containerEl);

    // フロントマターのキー名 / frontmatter key names
    new Setting(containerEl).setName(tr().setKeysHeading).setHeading();
    (Object.keys(s.keys) as (keyof GanttSettings["keys"])[]).forEach((k) => {
      this.ctlKeyRow(new Setting(containerEl).setName(k), k);
    });
  }
}
