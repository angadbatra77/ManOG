import yahooFinance from "./yahooClient.js";
import pLimit from "p-limit";
import { getNseUniverse } from "./nseUniverse.js";
import { filterByMarketCap } from "./marketCap.js";
import { computeIndicators } from "./indicators.js";
import {
  RSI_BUY_LEVEL,
  WEEKLY_LOOKBACK_WEEKS,
  HISTORY_CONCURRENCY,
} from "../config.js";

function weeksAgoDate(weeks) {
  const d = new Date();
  d.setDate(d.getDate() - weeks * 7);
  return d;
}

export async function fetchWeeklyCandles(symbol) {
  const result = await yahooFinance.chart(symbol, {
    period1: weeksAgoDate(WEEKLY_LOOKBACK_WEEKS),
    interval: "1wk",
  });
  const quotes = (result?.quotes ?? []).filter(
    (q) => q.close != null && q.high != null && q.low != null
  );
  return quotes.map((q) => ({
    date: q.date,
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    volume: q.volume,
  }));
}

function evaluateBuySignal(candles, indicators) {
  const lastIdx = candles.length - 1;
  const prevIdx = lastIdx - 1;
  if (prevIdx < 0) return null;

  const rsiNow = indicators.rsi[lastIdx];
  const rsiPrev = indicators.rsi[prevIdx];
  const bbNow = indicators.bb[lastIdx];
  const macdNow = indicators.macd[lastIdx];

  if (rsiNow == null || rsiPrev == null || bbNow == null || macdNow == null) {
    return null;
  }
  if (macdNow.MACD == null || macdNow.signal == null) return null;

  const rsiCrossedAbove = rsiPrev <= RSI_BUY_LEVEL && rsiNow > RSI_BUY_LEVEL;
  const closeAboveUpperBB = candles[lastIdx].close > bbNow.upper;
  const macdBullish = macdNow.MACD > macdNow.signal;

  if (!(rsiCrossedAbove && closeAboveUpperBB && macdBullish)) return null;

  return {
    signalDate: candles[lastIdx].date,
    stopLoss: candles[lastIdx].low,
    rsi: rsiNow,
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

  results.sort((a, b) => (b.change1w ?? 0) - (a.change1w ?? 0));
  return results;
}
