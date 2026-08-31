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

// Calendar date (YYYY-MM-DD) of a timestamp as seen in IST — the convention
// used everywhere a "trading day" needs a single, unambiguous date key
// (this module's own settlement check, and the daily_candles store's
// primary key).
export function toISTDateString(date = new Date()) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function todayIST() {
  return toISTDateString();
}

// Saturday or Sunday IST — NSE's Mon-Fri trading week is necessarily over
// by then, even though the ISO week (Mon-anchored) doesn't roll over until
// the following Monday.
export function isWeekendIST(now = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(now);
  return weekday === "Sat" || weekday === "Sun";
}

// The app now runs on a weekly cadence: a fresh list gets generated once,
// and the SAME list should keep showing all week until the next refresh —
// never a partially-formed "current week" that quietly changes shape as
// more trading days land in it. This drops the entire in-progress week
// (not just today) whenever it could still gain more trading days, so
// every refresh — whenever it happens to run — resolves to the same
// answer: the most recently FULLY COMPLETED week, exactly what the
// validated backtest itself only ever evaluated.
//
// Monday-Friday: this week isn't done yet (more days could still land in
// it today or later this week) — drop it entirely, fall back to last
// week's complete candle.
// Saturday/Sunday: the week that just ended has no more trading days
// coming — safe to include it as-is.
export function keepOnlyCompletedWeeks(dailyCandles, now = new Date()) {
  if (isWeekendIST(now)) return dailyCandles;
  const currentWeekStart = isoWeekStart(now);
  return dailyCandles.filter((c) => isoWeekStart(new Date(c.date)) !== currentWeekStart);
}
