// Builds weekly candles from daily candles, Monday-anchored, exactly the way
// the validated 20-year backtest built every week it ever evaluated (see
// scripts/backtest.js, which used to define this logic itself). The live
// screener now imports this same module instead of trusting a data vendor's
// own "weekly" aggregation — one implementation, shared, so backtest and
// production can never silently drift apart on what a "week" actually is.

export function isoWeekStart(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Monday=1..Sunday=7
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

// Groups daily candles into weekly buckets (Mon-start), each built only from
// whichever real trading days fell in that week — a holiday-shortened week
// is built from fewer days, never padded to a fixed 5. open = first day's
// open, close = last day's close, high/low across the week, volume summed.
export function groupIntoWeeks(dailyCandles) {
  const byWeek = new Map();
  for (const c of dailyCandles) {
    const key = isoWeekStart(new Date(c.date));
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key).push(c);
  }
  const weekKeys = [...byWeek.keys()].sort();
  return weekKeys.map((key) => {
    const days = byWeek.get(key).sort((a, b) => new Date(a.date) - new Date(b.date));
    return {
      weekStart: key,
      days,
      candle: {
        date: days[0].date,
        open: days[0].open,
        high: Math.max(...days.map((d) => d.high)),
        low: Math.min(...days.map((d) => d.low)),
        close: days[days.length - 1].close,
        volume: days.reduce((s, d) => s + (d.volume ?? 0), 0),
      },
    };
  });
}

export function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// NSE closes 3:30 PM IST. Before that, today's daily candle is still live —
// its close keeps moving with the market, which is exactly what caused a
// signal to appear and vanish within the same day when refreshed mid-session.
// The backtest never faced this: every day it ever looked at was already
// over. This is the live app's equivalent of "already over" for today.
export function isTodaysSessionSettled(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour > 15 || (hour === 15 && minute >= 30);
}

// Drops today's own daily candle from the series whenever NSE hasn't closed
// yet, so the current week's candle is only ever built from fully settled
// days — never a live, still-moving intraday price. Once the market closes
// for the day, today's candle is settled and gets included like any other.
export function excludeUnsettledToday(dailyCandles) {
  if (isTodaysSessionSettled()) return dailyCandles;
  const today = todayIST();
  return dailyCandles.filter((c) => {
    const candleDateIST = new Date(c.date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    return candleDateIST !== today;
  });
}
