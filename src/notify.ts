import { Notice, requestUrl } from "obsidian";
import type GanttPlugin from "./main";
import { collectTasks, toInstant } from "./model";
import { formatDate } from "./timeline";
import { t as tr } from "./i18n";

// リードタイム定義（分）/ lead time presets in minutes
export const LEADS: { id: string; minutes: number }[] = [
  { id: "1w", minutes: 7 * 24 * 60 },
  { id: "1d", minutes: 24 * 60 },
  { id: "1h", minutes: 60 },
  { id: "10m", minutes: 10 },
  { id: "0", minutes: 0 },
];

// リードタイムIDの表示名 / display label for a lead id
export function leadLabel(id: string): string {
  const s = tr();
  switch (id) {
    case "1w": return s.leadWeek;
    case "1d": return s.leadDay;
    case "1h": return s.leadHour;
    case "10m": return s.lead10m;
    default: return s.leadNow;
  }
}

// (from, to] に入った通知トリガーを送信。時刻ありのタスクのみ対象（日付のみは通知しない）
// send triggers that fell within (from, to]; only tasks with a time of day are notified
export async function checkNotifications(plugin: GanttPlugin, fromMs: number, toMs: number): Promise<void> {
  const s = plugin.settings;
  const n = s.notify;
  if (!n.discordWebhook && !n.slackWebhook && !n.teamsWebhook) return;
  if (!n.leads.length || (!n.notifyStart && !n.notifyEnd)) return;
  // 既定フォルダ設定に関係なく Vault 全体を対象にする（時刻ありタスクのみ通知されるのでノイズは出ない）
  // scan the whole vault regardless of the default-folder setting (only timed tasks notify, so no noise)
  const tasks = collectTasks(plugin.app, { ...s, recurse: true }, "");
  let dirty = false;
  for (const t of tasks) {
    const ends: { kind: "start" | "end"; date?: string; time?: string; on: boolean }[] = [
      { kind: "start", date: t.start, time: t.startTime, on: n.notifyStart && !t.milestone },
      { kind: "end", date: t.end, time: t.endTime, on: n.notifyEnd },
    ];
    for (const e of ends) {
      if (!e.on || !e.date || !e.time) continue;
      const instant = toInstant(e.date, e.time, s.tz);
      for (const lead of LEADS) {
        if (!n.leads.includes(lead.id)) continue;
        const trigger = instant - lead.minutes * 60000;
        if (trigger <= fromMs || trigger > toMs) continue;
        // 二重送信防止（再起動を跨いで保持）/ dedupe across restarts
        const key = `${t.path}|${e.kind}|${lead.id}|${instant}`;
        if (n.sent[key]) continue;
        n.sent[key] = Date.now();
        dirty = true;
        const at = `${formatDate(e.date, s.dateFormat)} ${e.time}`;
        await sendWebhooks(n, tr().notifyLine(t.name, e.kind, at, leadLabel(lead.id)));
      }
    }
  }
  // 古い送信済みキーを掃除（14日）/ prune sent keys older than 14 days
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [k, ts] of Object.entries(n.sent)) {
    if (ts < cutoff) {
      delete n.sent[k];
      dirty = true;
    }
  }
  if (dirty) await plugin.saveData(plugin.settings);
}

// 設定画面の「テスト送信」。結果を Notice で表示 / "send a test message" from settings; result shown as a Notice
export async function sendTestNotification(plugin: GanttPlugin): Promise<void> {
  const n = plugin.settings.notify;
  if (!n.discordWebhook && !n.slackWebhook && !n.teamsWebhook) {
    new Notice(tr().setWebhookDesc); // URL 未設定 / no webhook configured
    return;
  }
  const ok = await sendWebhooks(n, tr().notifyTestMsg);
  new Notice(ok ? "✅" : "⚠️ (console)");
}

// Teams（Power Automate Workflows）は Adaptive Card 形式の JSON を要求する
// Teams (Power Automate Workflows) expects an Adaptive Card payload
function teamsCard(msg: string): string {
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [{ type: "TextBlock", text: msg, wrap: true }],
        },
      },
    ],
  });
}

// 設定済みの Webhook へ送信。1つの失敗が他やループを止めないように個別に握る
// post to the configured webhooks; one failure must not block the others or the loop
async function sendWebhooks(
  n: { discordWebhook: string; slackWebhook: string; teamsWebhook: string },
  msg: string
): Promise<boolean> {
  let ok = true;
  const targets: { url: string; body: string; label: string }[] = [
    { url: n.discordWebhook, body: JSON.stringify({ content: msg }), label: "Discord" },
    { url: n.slackWebhook, body: JSON.stringify({ text: msg }), label: "Slack" },
    { url: n.teamsWebhook, body: teamsCard(msg), label: "Teams" },
  ];
  for (const t of targets) {
    if (!t.url) continue;
    try {
      await requestUrl({ url: t.url, method: "POST", contentType: "application/json", body: t.body });
    } catch (e) {
      ok = false;
      console.error(`Task Gantt: ${t.label} notification failed`, e);
    }
  }
  return ok;
}
