import fs from "node:fs/promises";
import path from "node:path";
import yahooFinance from "./yahooClient.js";
import pLimit from "p-limit";
import { getNseUniverse } from "./nseUniverse.js";
import { filterByMarketCap } from "./marketCap.js";
import { computeIndicators } from "./indicators.js";
import { computeStreak } from "./streak.js";
import { fetchWeeklyCandlesUpstox } from "./upstoxData.js";
import { getFirstSeenDate } from "./historyDb.js";
import {
  RSI_BUY_LEVEL,
  WEEKLY_LOOKBACK_WEEKS,
  HISTORY_CONCURRENCY,
  DATA_DIR,
  GRACE_WEEKS,
  MAX_SIGNAL_AGE_DAYS,
} from "../config.js";

function weeksAgoDate(weeks) {
  const d = new Date();
  d.setDate(d.getDate() - weeks * 7);
  return d;
}

const CANDLES_CACHE_FILE = path.join(DATA_DIR, "weekly-candles-cache.json");
// the current (still-forming) week's candle changes as the week progresses,
// so this trades a bit of intra-week staleness for skipping ~1400 network
// round-trips on repeat refreshes within the window
const CANDLES_TTL_MS = 45 * 60 * 1000;

let candlesCache = null;
let candlesCacheDirty = false;

async function loadCandlesCache() {
  if (candlesCache) return candlesCache;
  try {
    candlesCache = JSON.parse(await fs.readFile(CANDLES_CACHE_FILE, "utf-8"));
  } catch {
    candlesCache = {};
  }
  return candlesCache;
}

export async function persistCandlesCache() {
  if (!candlesCacheDirty) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CANDLES_CACHE_FILE, JSON.stringify(candlesCache));
  candlesCacheDirty = false;
}

// Upstox is the official, licensed feed and is tried first whenever it's
// connected; Yahoo (unofficial, no SLA, has broken schema-validated mid
// this project already) is the automatic fallback — this way a stale/
// expired Upstox login this morning degrades the data quality slightly
// instead of breaking the screener outright.
export async function fetchWeeklyCandles(symbol) {
  const cache = await loadCandlesCache();
  const entry = cache[symbol];
  if (entry && Date.now() - entry.fetchedAt < CANDLES_TTL_MS) {
    return entry.candles;
  }

  let candles = null;
  try {
    candles = await fetchWeeklyCandlesUpstox(symbol, WEEKLY_LOOKBACK_WEEKS);
  } catch {
    candles = null; // fall through to Yahoo below
  }

  if (!candles) {
    const result = await yahooFinance.chart(symbol, {
      period1: weeksAgoDate(WEEKLY_LOOKBACK_WEEKS),
      interval: "1wk",
    });
    const quotes = (result?.quotes ?? []).filter(
      (q) => q.close != null && q.high != null && q.low != null
    );
    candles = quotes.map((q) => ({
      date: q.date,
      open: q.open,
      high: q.high,
      low: q.low,
      close: q.close,
      volume: q.volume,
    }));
  }

  cache[symbol] = { fetchedAt: Date.now(), candles };
  candlesCacheDirty = true;
  return candles;
}

function qualifiesAt(candles, indicators, idx) {
  const rsi = indicators.rsi[idx];
  const bb = indicators.bb[idx];
  const macd = indicators.macd[idx];
  if (rsi == null || bb == null || macd == null) return false;
  if (macd.MACD == null || macd.signal == null) return false;
  return (
    rsi > RSI_BUY_LEVEL &&
    candles[idx].close > bb.upper &&
    macd.MACD > macd.signal
  );
}

// The validated 20-year backtest only ever bought a stock the week RSI
// SPECIFICALLY crossed above 60 (previous week's RSI was at or below 60) —
// never a week where RSI was already elevated and it was the Bollinger Band
// or MACD condition that flipped true. This is the exact gate the backtest
// used; qualifiesAt alone (used below for the ongoing streak) is looser and
// will match on any of the three conditions turning true.
function isFreshRsiCross(candles, indicators, idx) {
  if (idx < 1) return false;
  const rsiPrev = indicators.rsi[idx - 1];
  if (rsiPrev == null || rsiPrev > RSI_BUY_LEVEL) return false;
  return qualifiesAt(candles, indicators, idx);
}

// A stock stays a "buy" candidate for as long as it keeps satisfying all three
// conditions (RSI>60, close above upper BB, MACD bullish), not just the single
// week it first crossed. weeksInCriteria counts that streak, and stopLoss/
// signalDate anchor to the week the streak began (the original breakout) —
// but only if that streak actually began with a genuine RSI cross. A streak
// that started because BB or MACD flipped true while RSI was already above
// 60 was never something the backtest would have bought, so it's excluded
// entirely rather than shown as a signal with no validated basis.
function evaluateBuySignal(candles, indicators) {
  const lastIdx = candles.length - 1;
  const streak = computeStreak(lastIdx, (idx) =>
    qualifiesAt(candles, indicators, idx)
  );
  if (!streak) return null;
  if (!isFreshRsiCross(candles, indicators, streak.streakStart)) return null;

  // entry strength = how far the breakout week's close sat above the upper
  // Bollinger Band, as a %. This is the same ranking used throughout the
  // validated 20-year backtest to decide which signal gets priority when
  // capital is limited — the strongest breakout, not just the most recent
  // or the biggest 1-week mover, goes first.
  const breakoutIdx = streak.streakStart;
  const breakoutBB = indicators.bb[breakoutIdx];
  const strengthPct = breakoutBB
    ? ((candles[breakoutIdx].close - breakoutBB.upper) / breakoutBB.upper) * 100
    : null;

  return {
    signalDate: candles[breakoutIdx].date,
    stopLoss: candles[breakoutIdx].low,
    priceAtSignal: candles[breakoutIdx].close,
    weeksInCriteria: streak.weeksInState,
    rsi: indicators.rsi[lastIdx],
    strengthPct,
  };
}

// Keep the homepage small and close to genuinely fresh: only show a signal
// within MAX_SIGNAL_AGE_DAYS calendar days of its original breakout.
// `effectiveDateStr` is the earliest date we actually observed this exact
// signal (see getFirstSeenDate) when we have that history, since the raw
// week-start signalDate only says which week a breakout happened in, not
// which day — falling back to signalDate itself when we've never seen it.
function isActionableNow(effectiveDateStr) {
  const signalTime = new Date(effectiveDateStr).getTime();
  if (Number.isNaN(signalTime)) return false;
  const daysSinceSignal = (Date.now() - signalTime) / (24 * 60 * 60 * 1000);
  return daysSinceSignal <= MAX_SIGNAL_AGE_DAYS;
}

// If you buy now instead of on the fresh breakout week, the grace period
// should still end GRACE_WEEKS after the ORIGINAL signal, not GRACE_WEEKS
// after today — otherwise a late entry gets extra, unvalidated protection
// time it was never backtested with.
function remainingGraceWeeks(weeksInCriteria) {
  return Math.max(0, GRACE_WEEKS - (weeksInCriteria - 1));
}

export function pctChange(candles, weeksBack) {
  const lastIdx = candles.length - 1;
  const refIdx = lastIdx - weeksBack;
  if (refIdx < 0) return null;
  const last = candles[lastIdx].close;
  const ref = candles[refIdx].close;
  if (!ref) return null;
  return ((last - ref) / ref) * 100;
}

export async function runScreener({ limit, onProgress } = {}) {
  const universe = await getNseUniverse();
  const capFiltered = await filterByMarketCap(universe);
  if (capFiltered.length === 0) {
    throw new Error(
      "Market cap filtering returned 0 candidates — likely a Yahoo Finance API failure, not a real market condition"
    );
  }
  const candidates = limit ? capFiltered.slice(0, limit) : capFiltered;

  const limiter = pLimit(HISTORY_CONCURRENCY);
  let done = 0;
  const results = [];

  await Promise.all(
    candidates.map((stock) =>
      limiter(async () => {
        try {
          const candles = await fetchWeeklyCandles(stock.symbol);
          if (candles.length > 30) {
            const indicators = computeIndicators(candles);
            const signal = evaluateBuySignal(candles, indicators);
            const currentPrice = candles[candles.length - 1].close;
            if (signal) {
              const plainSymbol = stock.symbol.replace(/\.NS$/, "");
              let firstSeenDate = null;
              try {
                firstSeenDate = await getFirstSeenDate(plainSymbol, signal.signalDate);
              } catch {
                // history lookup failing shouldn't break the screener — just
                // fall back to the week-start date below
              }
              const effectiveDateStr = firstSeenDate ?? signal.signalDate;

              if (isActionableNow(effectiveDateStr)) {
                results.push({
                  symbol: plainSymbol,
                  name: stock.name,
                  price: currentPrice,
                  marketCap: stock.marketCap,
                  change1w: pctChange(candles, 1),
                  change1m: pctChange(candles, 4),
                  stopLoss: signal.stopLoss,
                  signalDate: signal.signalDate,
                  firstSeenDate: firstSeenDate,
                  priceAtSignal: signal.priceAtSignal,
                  weeksInCriteria: signal.weeksInCriteria,
                  strengthPct: signal.strengthPct,
                  graceWeeksIfBoughtNow: remainingGraceWeeks(signal.weeksInCriteria),
                });
              }
            }
          }
        } catch {
          // skip symbols yahoo fails to return history for
        } finally {
          done += 1;
          if (onProgress) onProgress(done, candidates.length);
        }
      })
    )
  );

  await persistCandlesCache();

  // Order of preference: strongest breakout first (highest % above the
  // upper Bollinger Band at signal) — matches the priority ranking used
  // throughout the validated backtest, not just whichever stock happened
  // to move the most this week.
  results.sort((a, b) => (b.strengthPct ?? -Infinity) - (a.strengthPct ?? -Infinity));
  results.forEach((r, i) => { r.rank = i + 1; });
  return results;
}
