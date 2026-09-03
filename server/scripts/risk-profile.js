// Drawdown, worst year and year-by-year returns for the bias-free
// backtest, at two universe sizes.
//
// Two traps this is built around, both of which produced badly wrong
// numbers before they were caught:
//
//   1. Open positions are marked to MARKET each month, not held at cost.
//      The strategy suspends every exit rule for 12 weeks after entry, so
//      a position can fall a long way while the books show nothing.
//
//   2. The equity curve is sampled on a FIXED monthly calendar, not on
//      days a trade happened. Momentum entries need RSI crossing above 60,
//      which almost never fires in a sustained bear market — so a
//      trade-driven curve skips exactly the months worth measuring. That
//      is how an earlier version reported zero losing years in fifteen.
//
// Run with: node scripts/risk-profile.js

import fs from "node:fs/promises";
import path from "node:path";

const SCRIPTS = "C:/Users/angad/OneDrive/Desktop/ManOG/server/scripts";
const SRV = "file:///C:/Users/angad/OneDrive/Desktop/ManOG/server/src/";
const { computeIndicators } = await import(SRV + "services/indicators.js");
const { groupIntoWeeks } = await import(SRV + "services/weeklyResample.js");
const { RSI_BUY_LEVEL, GRACE_WEEKS, PCT_OF_EQUITY_PER_TRADE, MAX_TRADE_VALUE } = await import(SRV + "config.js");

const TURNOVER_WINDOW = 60, WARMUP_WEEKS = 35, ALIVE_CUTOFF = "2026-08-01";
const man = JSON.parse(await fs.readFile(path.join(SCRIPTS, "bhav-daily-240mo.json.manifest.json"), "utf-8"));
const median = (s) => { const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dnum = (s) => Number(String(s).slice(0, 10).replace(/-/g, ""));

console.log("loading...");
const perWeek = new Map(), cached = new Map();
for (let i = 0; i < man.chunkCount; i++) {
  const chunk = JSON.parse(await fs.readFile(path.join(SCRIPTS, `bhav-daily-240mo.json.part${i}.json`), "utf-8"));
  for (const [key, bars] of Object.entries(chunk)) {
    if (bars.length < 200) continue;
    const weeks = groupIntoWeeks(bars);
    if (weeks.length < WARMUP_WEEKS + 5) continue;
    const turn = []; let di = 0;
    for (const w of weeks) {
      const end = w.days[w.days.length - 1].date;
      while (di < bars.length && bars[di].date <= end) di++;
      const v = bars.slice(Math.max(0, di - TURNOVER_WINDOW), di).map((b) => b.value).filter((x) => x > 0).sort((a, b) => a - b);
      turn.push(v.length ? median(v) : 0);
    }
    const pd = new Int32Array(bars.length), pc = new Float64Array(bars.length);
    for (let j = 0; j < bars.length; j++) { pd[j] = dnum(bars[j].date); pc[j] = bars[j].close; }
    cached.set(key.replace(/\.NS$/, ""), { weeks, turn, pd, pc, lastDate: bars[bars.length - 1].date });
    for (let w = 0; w < weeks.length; w++) {
      const k = weeks[w].candle.date;
      let a = perWeek.get(k); if (!a) { a = []; perWeek.set(k, a); }
      if (turn[w] > 0) a.push(turn[w]);
    }
  }
}
const prepared = new Map();
for (const [sym, rec] of cached) {
  const candles = rec.weeks.map((w) => w.candle);
  prepared.set(sym, { ...rec, candles, ind: computeIndicators(candles) });
}
console.log(`${prepared.size} symbols\n`);

function closeOn(rec, target) {
  const { pd, pc } = rec;
  let lo = 0, hi = pd.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pd[m] <= target) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? pc[ans] : null;
}
function thresholds(p) {
  const th = new Map();
  for (const [wk, arr] of perWeek) { const s = [...arr].sort((a, b) => a - b); th.set(wk, s[Math.floor(s.length * (1 - p))] ?? 0); }
  return th;
}
function qualifies(c, ind, i) {
  const rsi = ind.rsi[i], bb = ind.bb[i], m = ind.macd[i];
  if (rsi == null || bb == null || m == null || m.MACD == null || m.signal == null) return false;
  return rsi > RSI_BUY_LEVEL && c[i].close > bb.upper && m.MACD > m.signal;
}
function freshT(c, ind, i) {
  if (i < 1) return false;
  const p = ind.rsi[i - 1];
  return p != null && p <= RSI_BUY_LEVEL && qualifies(c, ind, i);
}
function run(th) {
  const trades = [];
  for (const [sym, rec] of prepared) {
    const { weeks, turn, lastDate, candles, ind } = rec;
    let pos = null;
    for (let idx = WARMUP_WEEKS; idx < weeks.length; idx++) {
      const week = weeks[idx];
      if (pos == null) {
        if (turn[idx] >= (th.get(week.candle.date) ?? Infinity) && freshT(candles, ind, idx)) {
          const bd = week.days[week.days.length - 1], bb = ind.bb[idx];
          pos = { symbol: sym, buyDate: bd.date, buyPrice: bd.close, stopLoss: week.candle.low, entryWeekIdx: idx,
                  strengthPct: ((week.candle.close - bb.upper) / bb.upper) * 100 };
        }
        continue;
      }
      if (idx - pos.entryWeekIdx >= GRACE_WEEKS) {
        let done = false;
        for (const day of week.days) {
          if (day.low <= pos.stopLoss) { trades.push({ ...pos, sellDate: day.date, sellPrice: pos.stopLoss, reason: "stop" }); pos = null; done = true; break; }
        }
        if (done) continue;
        const m = ind.macd[idx];
        if (m && m.MACD != null && m.signal != null && m.MACD < m.signal) {
          trades.push({ ...pos, sellDate: week.candle.date, sellPrice: week.candle.close, reason: "macd" }); pos = null; continue;
        }
      }
      if (week.candle.low > pos.stopLoss) pos.stopLoss = week.candle.low;
    }
    if (pos) trades.push({ ...pos, sellDate: lastDate, sellPrice: candles[candles.length - 1].close,
                           reason: lastDate >= ALIVE_CUTOFF ? "open" : "delisted" });
  }
  return trades;
}

function replayWithCurve(list, capital, tax, cost, haircut) {
  const byDay = new Map();
  for (const t of list) { const k = String(t.buyDate).slice(0, 10); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
  const px = (p) => (p.reason === "delisted" ? p.sellPrice * (1 - haircut) : p.sellPrice);
  let cash = capital; const open = [];
  const settle = (p) => { const g = p.shares * px(p), c = g * (cost / 100); const gain = g - c - p.shares * p.buyPrice; cash += g - c - (gain > 0 ? gain * (tax / 100) : 0); };
  const buyDays = [...byDay.keys()].sort();
  // Sample on a FIXED monthly calendar, not on buy days. Momentum signals
  // dry up completely in a crash, so a buy-day-driven curve skips exactly
  // the months you most need to measure — which is how an earlier version
  // of this produced "zero losing years in 15".
  const months = [];
  {
    const start = new Date(buyDays[0] + "T00:00:00Z");
    const end = new Date(buyDays[buyDays.length - 1] + "T00:00:00Z");
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++)
      for (let m = 1; m <= 12; m++) {
        const d = new Date(Date.UTC(y, m, 0)); // last day of month m
        if (d >= start && d <= end) months.push(d.toISOString().slice(0, 10));
      }
  }
  const events = [...new Set([...buyDays, ...months])].sort();
  const isMonthEnd = new Set(months);
  const curve = [];
  for (const d of events) {
    const today = new Date(d);
    for (let i = open.length - 1; i >= 0; i--) if (new Date(open[i].sellDate) <= today) { settle(open[i]); open.splice(i, 1); }
    if (byDay.has(d)) {
      for (const t of byDay.get(d).slice().sort((a, b) => b.strengthPct - a.strengthPct)) {
        const eq = cash + open.reduce((s, p) => s + p.shares * p.buyPrice, 0);
        const sh = Math.floor(Math.min(eq * (PCT_OF_EQUITY_PER_TRADE / 100), MAX_TRADE_VALUE, cash) / t.buyPrice);
        if (sh < 1) continue;
        cash -= sh * t.buyPrice * (1 + cost / 100); open.push({ ...t, shares: sh });
      }
    }
    if (isMonthEnd.has(d)) {
      const target = dnum(d);
      let mkt = 0;
      for (const p of open) { const c = closeOn(prepared.get(p.symbol), target); mkt += p.shares * (c ?? p.buyPrice); }
      curve.push({ month: d.slice(0, 7), equity: cash + mkt });
    }
  }
  for (const p of open) settle(p);
  return { finalCash: cash, curve };
}

function stats(curve, capital) {
  let peak = capital, maxDD = 0, ddStart = null, worstFrom = "", worstTo = "", longest = 0, cur = 0;
  for (const pt of curve) {
    if (pt.equity > peak) { peak = pt.equity; ddStart = pt.month; cur = 0; }
    else { cur++; if (cur > longest) longest = cur; }
    const dd = (pt.equity / peak - 1) * 100;
    if (dd < maxDD) { maxDD = dd; worstFrom = ddStart; worstTo = pt.month; }
  }
  const byYear = new Map();
  for (const pt of curve) byYear.set(pt.month.slice(0, 4), pt.equity);
  const years = [...byYear.keys()].sort();
  const rets = [];
  let prev = capital;
  for (const y of years) { const e = byYear.get(y); rets.push({ y, r: (e / prev - 1) * 100 }); prev = e; }
  return { maxDD, worstFrom, worstTo, longest, rets };
}

console.log("=".repeat(100));
for (const [label, pctile] of [["Rs 1,000 Cr universe", 0.648], ["Rs 10,000 Cr universe", 0.268]]) {
  const t = run(thresholds(pctile));
  const { curve } = replayWithCurve(t, 1e6, 20, 0.15, 0.5);
  const s = stats(curve, 1e6);
  const first = curve[0], last = curve[curve.length - 1];
  const span = (new Date(last.month + "-01") - new Date(first.month + "-01")) / (365.25 * 24 * 3600 * 1000);
  console.log(`\n${label}  (net of tax + costs, open positions marked to market monthly)`);
  console.log(`  period              ${first.month} to ${last.month}   (${span.toFixed(1)} years)`);
  console.log(`  CAGR                ${((Math.pow(last.equity / 1e6, 1 / span) - 1) * 100).toFixed(2)}%`);
  console.log(`  max drawdown        ${s.maxDD.toFixed(1)}%   (${s.worstFrom} -> ${s.worstTo})`);
  console.log(`  longest underwater  ${s.longest} months`);
  const neg = s.rets.filter((r) => r.r < 0);
  console.log(`  losing years        ${neg.length} of ${s.rets.length}`);
  console.log(`  worst year          ${Math.min(...s.rets.map((r) => r.r)).toFixed(1)}%   best year ${Math.max(...s.rets.map((r) => r.r)).toFixed(1)}%`);
  console.log("  by year: " + s.rets.map((r) => `${r.y} ${r.r >= 0 ? "+" : ""}${r.r.toFixed(0)}%`).join("  "));
}
console.log("\n" + "=".repeat(100));
