import pLimit from "p-limit";
import { fetchWeeklyCandles, persistCandlesCache, pctChange } from "./screener.js";
import { fetchQuotesForBatch } from "./marketCap.js";
import { computeIndicators } from "./indicators.js";
import { computeStreak } from "./streak.js";
import { getAllHistoricalSymbols } from "./historyDb.js";
import { QUOTE_BATCH_SIZE, HISTORY_CONCURRENCY } from "../config.js";

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function evaluateSellCriteria(candles, indicators) {
  const lastIdx = candles.length - 1;
  const streak = computeStreak(lastIdx, (idx) => {
    const macd = indicators.macd[idx];
    if (!macd || macd.MACD == null || macd.signal == null) return false;
    return macd.MACD < macd.signal;
  });
  if (!streak) return null;

  return {
    signalDate: candles[streak.streakStart].date,
    weeksInCriteria: streak.weeksInState,
  };
}

/**
 * Scans every stock that has ever appeared as a buy signal in screener_history
 * and flags the ones currently in "sell mode" — MACD line below signal line
 * on the latest weekly candle — so a stock doesn't need to be in the user's
 * manually-tracked Holdings to show up as an exit signal.
 */
export async function scanSellSignals() {
  const historicalSymbols = await getAllHistoricalSymbols();
  if (historicalSymbols.length === 0) return [];

  const ySymbols = historicalSymbols.map((s) => `${s.symbol}.NS`);
  const quoteBatches = chunk(ySymbols, QUOTE_BATCH_SIZE);
  const quoteResults = await Promise.all(
    quoteBatches.map((batch) => fetchQuotesForBatch(batch))
  );
  const marketCapBySymbol = new Map();
  for (const quotes of quoteResults) {
    for (const q of quotes) {
      if (q?.symbol) marketCapBySymbol.set(q.symbol, q.marketCap ?? null);
    }
  }

  const limiter = pLimit(HISTORY_CONCURRENCY);
  const results = [];

  await Promise.all(
    historicalSymbols.map(({ symbol, name }) =>
      limiter(async () => {
        const ySymbol = `${symbol}.NS`;
        try {
          const candles = await fetchWeeklyCandles(ySymbol);
          if (candles.length <= 30) return;

          const indicators = computeIndicators(candles);
          const signal = evaluateSellCriteria(candles, indicators);
          if (!signal) return;

          results.push({
            symbol,
            name,
            price: candles[candles.length - 1].close,
            marketCap: marketCapBySymbol.get(ySymbol) ?? null,
            change1w: pctChange(candles, 1),
            change1m: pctChange(candles, 4),
            signalDate: signal.signalDate,
            weeksInCriteria: signal.weeksInCriteria,
          });
        } catch {
          // skip symbols yahoo fails to return history for
        }
      })
    )
  );

  await persistCandlesCache();

  results.sort((a, b) => b.weeksInCriteria - a.weeksInCriteria);
  return results;
}
