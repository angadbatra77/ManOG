import fs from "node:fs/promises";
import path from "node:path";
import yahooFinance from "./yahooClient.js";
import pLimit from "p-limit";
import { getNseUniverse } from "./nseUniverse.js";
import { filterByMarketCap } from "./marketCap.js";
import { computeIndicators } from "./indicators.js";
import {
  RSI_BUY_LEVEL,
  WEEKLY_LOOKBACK_WEEKS,
  HISTORY_CONCURRENCY,
  DATA_DIR,
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

export async function fetchWeeklyCandles(symbol) {
  const cache = await loadCandlesCache();
  const entry = cache[symbol];
  if (entry && Date.now() - entry.fetchedAt < CANDLES_TTL_MS) {
    return entry.candles;
  }

  const result = await yahooFinance.chart(symbol, {
    period1: weeksAgoDate(WEEKLY_LOOKBACK_WEEKS),
    interval: "1wk",
  });
  const quotes = (result?.quotes ?? []).filter(
    (q) => q.close != null && q.high != null && q.low != null
  );
  const candles = quotes.map((q) => ({
    date: q.date,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume,
  }));

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

// A stock stays a "buy" candidate for as long as it keeps satisfying all three
// conditions (RSI>60, close above upper BB, MACD bullish), not just the single
// week it first crossed. weeksInCriteria counts that streak, and stopLoss/
// signalDate anchor to the week the streak began (the original breakout).
function evaluateBuySignal(candles, indicators) {
  const lastIdx = candles.length - 1;
  if (lastIdx < 1) return null;

  if (!qualifiesAt(candles, indicators, lastIdx)) return null;

  let streakStart = lastIdx;
  while (
    streakStart - 1 >= 0 &&
    qualifiesAt(candles, indicators, streakStart - 1)
  ) {
    streakStart -= 1;
  }

  return {
    signalDate: candles[streakStart].date,
    stopLoss: candles[streakStart].low,
    weeksInCriteria: lastIdx - streakStart + 1,
    rsi: indicators.rsi[lastIdx],
  };
}

function pctChange(candles, weeksBack) {
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
            if (signal) {
              results.push({
                symbol: stock.symbol.replace(/\.NS$/, ""),
                name: stock.name,
                price: candles[candles.length - 1].close,
                change1w: pctChange(candles, 1),
                change1m: pctChange(candles, 4),
                stopLoss: signal.stopLoss,
                signalDate: signal.signalDate,
                weeksInCriteria: signal.weeksInCriteria,
              });
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

  results.sort((a, b) => (b.change1w ?? 0) - (a.change1w ?? 0));
  return results;
}
