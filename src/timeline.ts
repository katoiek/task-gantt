import { ZoomMode, Task } from "./types";

const MS_PER_DAY = 86400000;

// 'YYYY-MM-DD' を UTC の通日番号へ / parse to a UTC day index
export function dayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / MS_PER_DAY);
}

// 通日番号を 'YYYY-MM-DD' へ / day index back to date string
export function dayToStr(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function todayIndex(): number {
  return Math.floor(Date.now() / MS_PER_DAY);
}

// ズームごとの 1 日あたりピクセル / pixels per day per zoom
export function pxPerDay(zoom: ZoomMode): number {
  switch (zoom) {
    case "Day":
      return 36;
    case "Week":
      return 16;
    case "Month":
      return 5;
  }
}

export interface DateRange {
  min: number; // 開始日（通日）/ first day index
  max: number; // 終了日（通日）/ last day index
}

// タスク群から表示範囲を決める（前後に余白）/ compute the visible range with padding
export function computeRange(tasks: Task[]): DateRange {
  const days: number[] = [];
  for (const t of tasks) {
    if (t.start) days.push(dayIndex(t.start));
    if (t.end) days.push(dayIndex(t.end));
  }
  if (days.length === 0) {
    const today = todayIndex();
    return { min: today - 7, max: today + 30 };
  }
  return { min: Math.min(...days) - 3, max: Math.max(...days) + 7 };
}

export interface Tick {
  x: number;
  label: string;
  major: boolean; // 月境界など / month boundary
}

// 上部の日付軸の目盛りを生成 / generate header ticks
export function buildTicks(range: DateRange, zoom: ZoomMode, ppd: number): Tick[] {
  const ticks: Tick[] = [];
  const wk = ["日", "月", "火", "水", "木", "金", "土"];
  for (let day = range.min; day <= range.max; day++) {
    const d = new Date(day * MS_PER_DAY);
    const x = (day - range.min) * ppd;
    const isMonthStart = d.getUTCDate() === 1;
    if (zoom === "Day") {
      ticks.push({ x, label: `${d.getUTCDate()} ${wk[d.getUTCDay()]}`, major: isMonthStart });
    } else if (zoom === "Week") {
      if (d.getUTCDay() === 1 || isMonthStart) {
        ticks.push({ x, label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, major: isMonthStart });
      }
    } else {
      if (isMonthStart) ticks.push({ x, label: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`, major: true });
    }
  }
  return ticks;
}
