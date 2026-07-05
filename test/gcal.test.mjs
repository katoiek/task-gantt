// タスク ⇄ Google カレンダーイベント変換（map.ts）の検証
// Tests for the task ⇄ Google Calendar event mapping (map.ts)
import { addDays, rfc3339, eventTimes, buildEvent, fromEvent, taskHash, hasDates } from "./gcal-map.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok  -", name);
  } else {
    fail++;
    console.error("FAIL  -", name);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 日付演算 / date math
check("addDays(+1)", addDays("2026-06-30", 1) === "2026-07-01");
check("addDays(-1 年またぎ)", addDays("2026-01-01", -1) === "2025-12-31");
check("addDays(うるう年)", addDays("2028-02-28", 1) === "2028-02-29");

// RFC3339（秒付き）/ RFC3339 with seconds
check("rfc3339(+09:00)", rfc3339("2026-06-12", "09:30", "+09:00") === "2026-06-12T09:30:00+09:00");
check("rfc3339(-05:00)", rfc3339("2026-06-12", "09:30", "-05:00") === "2026-06-12T09:30:00-05:00");

// 同期対象判定 / syncable check
check("hasDates(両方なし)=false", hasDates({ path: "a.md", name: "a", milestone: false }) === false);
check("hasDates(end のみ)=true", hasDates({ path: "a.md", name: "a", end: "2026-06-12", milestone: true }) === true);

// 終日イベント（end は排他的で +1 日）/ all-day events (exclusive end, +1 day)
const ranged = { path: "p/a.md", name: "a", start: "2026-06-12", end: "2026-06-14", milestone: false };
check(
  "eventTimes(終日)=end+1日",
  same(eventTimes(ranged, "+09:00"), {
    start: { date: "2026-06-12", dateTime: null },
    end: { date: "2026-06-15", dateTime: null },
  })
);

// 時刻付き（両端に時刻があるときだけ）/ timed only when both ends carry a time
const timed = { ...ranged, startTime: "09:00", endTime: "17:30" };
check(
  "eventTimes(時刻あり)",
  same(eventTimes(timed, "+09:00"), {
    start: { dateTime: "2026-06-12T09:00:00+09:00", date: null },
    end: { dateTime: "2026-06-14T17:30:00+09:00", date: null },
  })
);
check(
  "eventTimes(片側だけ時刻)=終日扱い",
  same(eventTimes({ ...ranged, startTime: "09:00" }, "+09:00"), {
    start: { date: "2026-06-12", dateTime: null },
    end: { date: "2026-06-15", dateTime: null },
  })
);

// マイルストーン＝1日の終日 or 同時刻 / milestone = one all-day day, or the same instant when timed
const ms = { path: "p/m.md", name: "m", end: "2026-06-20", milestone: true };
check(
  "eventTimes(マイルストーン終日)",
  same(eventTimes(ms, "+09:00"), {
    start: { date: "2026-06-20", dateTime: null },
    end: { date: "2026-06-21", dateTime: null },
  })
);
check(
  "eventTimes(マイルストーン時刻あり)",
  same(eventTimes({ ...ms, endTime: "15:00" }, "+09:00"), {
    start: { dateTime: "2026-06-20T15:00:00+09:00", date: null },
    end: { dateTime: "2026-06-20T15:00:00+09:00", date: null },
  })
);

// イベント本体 / event payload
const ev = buildEvent(timed, "+09:00", "本文の抜粋", "MyVault");
check("buildEvent(summary)", ev.summary === "a");
check("buildEvent(obsidian URI)", ev.description.includes("obsidian://open?vault=MyVault&file=p%2Fa"));
check("buildEvent(抜粋が先頭)", ev.description.startsWith("本文の抜粋"));
check("buildEvent(拡張プロパティ)", ev.extendedProperties.private.tgPath === "p/a.md" && ev.extendedProperties.private.tgVault === "MyVault");

// イベント → ローカル（終日は排他的 end を戻す）/ event → local (inclusive end restored)
check(
  "fromEvent(終日)",
  same(fromEvent({ id: "x", start: { date: "2026-06-12" }, end: { date: "2026-06-15" } }, "+09:00"), {
    start: "2026-06-12",
    end: "2026-06-14",
  })
);
check(
  "fromEvent(終日1日)",
  same(fromEvent({ id: "x", start: { date: "2026-06-20" }, end: { date: "2026-06-21" } }, "+09:00"), {
    start: "2026-06-20",
    end: "2026-06-20",
  })
);
check(
  "fromEvent(時刻あり・TZ換算)",
  same(
    fromEvent(
      { id: "x", start: { dateTime: "2026-06-12T00:00:00Z" }, end: { dateTime: "2026-06-12T08:30:00Z" } },
      "+09:00"
    ),
    { start: "2026-06-12", end: "2026-06-12", startTime: "09:00", endTime: "17:30" }
  )
);
check("fromEvent(start なし)=null", fromEvent({ id: "x" }, "+09:00") === null);

// 往復（push した値を pull すると同じ日付・時刻に戻る）/ round-trip: pushing then pulling restores the same values
const rt = fromEvent({ id: "x", ...eventTimes(timed, "+09:00") }, "+09:00");
check("往復(時刻あり)", same(rt, { start: "2026-06-12", end: "2026-06-14", startTime: "09:00", endTime: "17:30" }));
const rtAllDay = fromEvent({ id: "x", ...eventTimes(ranged, "+09:00") }, "+09:00");
check("往復(終日)", same(rtAllDay, { start: "2026-06-12", end: "2026-06-14" }));

// ハッシュ（差分検出）/ fingerprint for change detection
const h = taskHash(ranged, "body");
check("taskHash(同一)", taskHash({ ...ranged }, "body") === h);
check("taskHash(日付変更で変わる)", taskHash({ ...ranged, end: "2026-06-15" }, "body") !== h);
check("taskHash(本文変更で変わる)", taskHash(ranged, "body2") !== h);
check("taskHash(名前変更で変わる)", taskHash({ ...ranged, name: "b" }, "body") !== h);

console.log(`\ngcal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
