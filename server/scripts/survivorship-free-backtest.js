// The strategy, run against every stock that ACTUALLY TRADED on each date
// — including the ~1,100 companies that no longer exist — instead of only
// the survivors visible in a present-day symbol list.
//
// Runs the same universe twice so the difference IS the survivorship bias:
//   SURVIVORS ONLY  — restricted to stocks still listed today
//   FULL UNIVERSE   — everything that traded, delisted names included
// Same data source, same gate, same rules; only the universe differs. That
// isolation is what makes the comparison meaningful — the survivors-only
// number here is a control, not a re-run of scored-signals-pit.
//
// Entry and exit rules are lifted verbatim from generate-scored-signals-pit.js
// and use the production indicators, so this is measuring the universe, not
// re-litigating the strategy.
//
// Delisting is modelled three ways, because "you sold at the last printed
// price" is optimistic — a compulsory delisting often means you couldn't
// sell at all. The total-loss column is the honest worst case.
//
// Result as of Sept 2026: 527 later-delisted companies produced 1,561 buy
// signals (18.9% of all signals), and the strategy still came out ahead —
// 1,505 of those exited on the ratcheting stop long before the company
// died. Even marking every delisting to zero, CAGR held at 23.43% vs
// 23.33% survivors-only. The bias was not inflating the backtest.
//
// Run with: node scripts/survivorship-free-backtest.js

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeIndicators } from "../src/services/indicators.js";
import { groupIntoWeeks } from "../src/services/weeklyResample.js";
import { RSI_BUY_LEVEL, GRACE_WEEKS, PCT_OF_EQUITY_PER_TRADE, MAX_TRADE_VALUE } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const PARSED = path.resolve(__dirname, arg("data", "."));
const TURNOVER_WINDOW = 60;
const WARMUP_WEEKS = 35;
const ALIVE_CUTOFF = arg("alive", "2026-08-01");
const STARTING_CAPITAL = Number(arg("capital", "1000000"));

// --from restricts which SIGNALS count, not which price history is loaded.
// Indicators still warm up on the full 20 years, so a 5-year window tests
// "what would the strategy have done since 2021" rather than "what if the
// market began in 2021" — truncating the data would leave the first ~35
// weeks of every symbol with no usable RSI/BB/MACD at all.
const FROM = arg("from", null);

// daily = the validated assumption (live stop order, filled at the stop).
// weekly-close = what the app can actually observe today.
const STOP_MODE = arg("stop-mode", "daily");
const YEARS = FROM
  ? (Date.now() - new Date(FROM + "T00:00:00Z").getTime()) / (365.25 * 24 * 3600 * 1000)
  : Number(arg("years", "20"));

let TURNOVER_PCTILE = 0.605;
try {
  TURNOVER_PCTILE = JSON.parse(await fs.readFile(path.join(PARSED, "gate-calibration.json"), "utf-8")).percentile;
} catch {
  console.log("No gate-calibration.json — falling back to the last calibrated 60.5%");
}

const man = JSON.parse(await fs.readFile(path.join(PARSED, "bhav-daily-240mo.json.manifest.json"), "utf-8"));
const median = (s) => { const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function weeklyTurnover(weeks, bars) {
  const out = [];
  let di = 0;
  for (const w of weeks) {
    const endDate = w.days[w.days.length - 1].date;
    while (di < bars.length && bars[di].date <= endDate) di++;
    const vals = bars.slice(Math.max(0, di - TURNOVER_WINDOW), di).map((b) => b.value).filter((v) => v > 0).sort((a, b) => a - b);
    out.push(vals.length ? median(vals) : 0);
  }
  return out;
}

// Pass 1: the gate is cross-sectional — a stock qualifies by being liquid
// RELATIVE TO the rest of the market that week — so every symbol's turnover
// has to be known before any of them can be judged.
console.log("pass 1: building point-in-time liquidity gate...");
const perWeek = new Map();
const cached = new Map();

for (let i = 0; i < man.chunkCount; i++) {
  const chunk = JSON.parse(await fs.readFile(path.join(PARSED, `bhav-daily-240mo.json.part${i}.json`), "utf-8"));
  for (const [key, bars] of Object.entries(chunk)) {
    if (bars.length < 200) continue;
    const weeks = groupIntoWeeks(bars);
    if (weeks.length < WARMUP_WEEKS + 5) continue;
    const turn = weeklyTurnover(weeks, bars);
    cached.set(key.replace(/\.NS$/, ""), { weeks, turn, lastDate: bars[bars.length - 1].date });
    for (let w = 0; w < weeks.length; w++) {
      const k = weeks[w].candle.date;
      let arr = perWeek.get(k);
      if (!arr) { arr = []; perWeek.set(k, arr); }
      if (turn[w] > 0) arr.push(turn[w]);
    }
  }
}

const threshold = new Map();
for (const [wk, arr] of perWeek) {
  arr.sort((a, b) => a - b);
  threshold.set(wk, arr[Math.floor(arr.length * (1 - TURNOVER_PCTILE))] ?? 0);
}
perWeek.clear();
console.log(`  ${cached.size} symbols with usable history across ${threshold.size} weeks\n`);

function qualifies(c, ind, i) {
  const rsi = ind.rsi[i], bb = ind.bb[i], macd = ind.macd[i];
  if (rsi == null || bb == null || macd == null) return false;
  if (macd.MACD == null || macd.signal == null) return false;
  return rsi > RSI_BUY_LEVEL && c[i].close > bb.upper && macd.MACD > macd.signal;
}
function freshTrigger(c, ind, i) {
  if (i < 1) return false;
  const prev = ind.rsi[i - 1];
  if (prev == null || prev > RSI_BUY_LEVEL) return false;
  return qualifies(c, ind, i);
}

function run(symbols, label) {
  const trades = [];
  for (const sym of symbols) {
    const rec = cached.get(sym);
    if (!rec) continue;
    const { weeks, turn, lastDate } = rec;
    const candles = weeks.map((w) => w.candle);
    const ind = computeIndicators(candles);
    let pos = null;

    for (let idx = WARMUP_WEEKS; idx < weeks.length; idx++) {
      const week = weeks[idx];
      if (pos == null) {
        if (turn[idx] >= (threshold.get(week.candle.date) ?? Infinity) && freshTrigger(candles, ind, idx)) {
          const buyDay = week.days[week.days.length - 1];
          const bb = ind.bb[idx];
          pos = {
            buyDate: buyDay.date, buyPrice: buyDay.close, stopLoss: week.candle.low,
            entryWeekIdx: idx, strengthPct: ((week.candle.close - bb.upper) / bb.upper) * 100,
          };
        }
        continue;
      }

      if (idx - pos.entryWeekIdx >= GRACE_WEEKS) {
        let stopped = false;
        if (STOP_MODE === "daily") {
          // What the strategy was validated on: a live stop order, watched
          // every day, filled AT the stop price the moment it's touched.
          for (const day of week.days) {
            if (day.low <= pos.stopLoss) {
              trades.push({ symbol: sym, ...pos, sellDate: day.date, sellPrice: pos.stopLoss, reason: "stop_loss" });
              pos = null; stopped = true; break;
            }
          }
        } else {
          // What the app can actually tell you today: it compares the
          // WEEKLY CLOSE to the stop, so you find out after the week ends
          // and sell at that close, not at the stop. In a fast drop that is
          // materially worse, and since ~99.9% of exits here are stops,
          // this assumption carries almost the whole result.
          if (week.candle.close <= pos.stopLoss) {
            trades.push({ symbol: sym, ...pos, sellDate: week.candle.date, sellPrice: week.candle.close, reason: "stop_loss" });
            pos = null; stopped = true;
          }
        }
        if (stopped) continue;
        const macd = ind.macd[idx];
        if (macd && macd.MACD != null && macd.signal != null && macd.MACD < macd.signal) {
          trades.push({ symbol: sym, ...pos, sellDate: week.candle.date, sellPrice: week.candle.close, reason: "macd" });
          pos = null; continue;
        }
      }
      if (week.candle.low > pos.stopLoss) pos.stopLoss = week.candle.low;
    }

    // Position still open when the data ends: either we're still holding it
    // today, or the company stopped trading underneath us.
    if (pos) {
      const alive = lastDate >= ALIVE_CUTOFF;
      trades.push({
        symbol: sym, ...pos, sellDate: lastDate,
        sellPrice: candles[candles.length - 1].close,
        reason: alive ? "open" : "delisted",
      });
    }
  }
  return { label, trades };
}

const allSyms = [...cached.keys()];
const survivors = allSyms.filter((s) => cached.get(s).lastDate >= ALIVE_CUTOFF);
console.log(`universe: ${allSyms.length} total | ${survivors.length} still listed | ${allSyms.length - survivors.length} delisted\n`);

const runs = [run(survivors, "SURVIVORS ONLY (survivorship-biased control)"), run(allSyms, "FULL UNIVERSE (bias-free)")];
for (const t of runs[1].trades) t.everDelisted = cached.get(t.symbol).lastDate < ALIVE_CUTOFF;

if (FROM) {
  for (const r of runs) r.trades = r.trades.filter((t) => String(t.buyDate).slice(0, 10) >= FROM);
  console.log(`window: signals from ${FROM} onward only (${YEARS.toFixed(2)} years)\n`);
}

// Capital-constrained replay. Sells settle by DATE — note that
// position-sized-simulation.js shifts a FIFO queue that was never sorted by
// sellDate, which can strand cash behind a later-selling position.
function replay(trades, capital, delistingHaircut) {
  const byDay = new Map();
  for (const t of trades) {
    const k = String(t.buyDate).slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  const exitPrice = (p) => (p.reason === "delisted" ? p.sellPrice * (1 - delistingHaircut) : p.sellPrice);
  let cash = capital;
  const open = [];
  let taken = 0;
  for (const d of [...byDay.keys()].sort()) {
    const today = new Date(d);
    for (let i = open.length - 1; i >= 0; i--) {
      if (new Date(open[i].sellDate) <= today) { cash += open[i].shares * exitPrice(open[i]); open.splice(i, 1); }
    }
    for (const t of byDay.get(d).slice().sort((a, b) => b.strengthPct - a.strengthPct)) {
      // The app's own sizing rule: min(PCT% of current equity, MAX_TRADE_VALUE).
      // It compounds, unlike a fixed rupee cap, which is the difference
      // between a CAGR that decays with account size and one that doesn't.
      const equity = cash + open.reduce((s, p) => s + p.shares * p.buyPrice, 0);
      const budget = Math.min(equity * (PCT_OF_EQUITY_PER_TRADE / 100), MAX_TRADE_VALUE, cash);
      const sh = Math.floor(budget / t.buyPrice);
      if (sh < 1) continue;
      cash -= sh * t.buyPrice;
      taken++;
      open.push({ ...t, shares: sh });
    }
  }
  for (const p of open) cash += p.shares * exitPrice(p);
  return { cagr: (Math.pow(cash / capital, 1 / YEARS) - 1) * 100, finalEquity: cash, taken };
}

const line = "=".repeat(78);
console.log(line);
for (const r of runs) {
  const closed = r.trades.filter((t) => t.reason !== "open");
  const rets = closed.map((t) => ((t.sellPrice - t.buyPrice) / t.buyPrice) * 100);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const byReason = {};
  for (const t of r.trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  console.log(`\n${r.label}`);
  console.log(`  signals ${r.trades.length} | mean return ${mean.toFixed(2)}% | win rate ${(rets.filter((x) => x > 0).length / rets.length * 100).toFixed(1)}%`);
  console.log(`  exits: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  const base = replay(r.trades, STARTING_CAPITAL, 0);
  console.log(`  Rs ${(STARTING_CAPITAL / 100000).toFixed(0)}L replay: CAGR ${base.cagr.toFixed(2)}%  final Rs ${Math.round(base.finalEquity).toLocaleString("en-IN")}  (${base.taken} trades)`);
}

const full = runs[1];
console.log("\nDelisting exit assumptions (full universe):");
for (const [label, haircut] of [["sold at last traded price", 0], ["50% haircut", 0.5], ["TOTAL LOSS, could not sell at all", 1]]) {
  const r = replay(full.trades, STARTING_CAPITAL, haircut);
  console.log(`  ${label.padEnd(36)} CAGR ${r.cagr.toFixed(2)}%   Rs ${Math.round(r.finalEquity).toLocaleString("en-IN")}`);
}

const closedFull = full.trades.filter((t) => t.reason !== "open");
const delisted = closedFull.filter((t) => t.everDelisted);
const cohort = (a) => {
  const r = a.map((t) => ((t.sellPrice - t.buyPrice) / t.buyPrice) * 100).sort((x, y) => x - y);
  return `n=${a.length} mean=${(r.reduce((x, y) => x + y, 0) / r.length).toFixed(2)}% win=${(r.filter((x) => x > 0).length / r.length * 100).toFixed(1)}% worst=${r[0].toFixed(1)}%`;
};
console.log("\nWhat the biased backtest could never see:");
console.log(`  signals from companies that later delisted: ${delisted.length} (${(delisted.length / closedFull.length * 100).toFixed(1)}% of all signals), across ${new Set(delisted.map((t) => t.symbol)).size} companies`);
console.log(`  those trades:      ${cohort(delisted)}`);
console.log(`  survivor trades:   ${cohort(closedFull.filter((t) => !t.everDelisted))}`);

await fs.writeFile(path.join(PARSED, "survivorship-free-result.json"), JSON.stringify({ survivors: runs[0].trades, full: full.trades }));
console.log(`\n${line}\nfull trade list written to survivorship-free-result.json`);
