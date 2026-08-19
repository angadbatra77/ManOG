import pLimit from "p-limit";
import { fetchWeeklyCandles, persistCandlesCache } from "./screener.js";
import { computeIndicators } from "./indicators.js";
import { getHistoricalStopLoss } from "./historyDb.js";

const HOLDINGS_CONCURRENCY = 5;
// how far the entered stop loss can deviate from what we last recorded for
// this stock in the screener before it's flagged as a likely mistake
const STOP_LOSS_DEVIATION_THRESHOLD = 0.25;

// Ratchets the stop loss up to the highest weekly low seen since purchase,
// never down — mathematically equivalent to raising it week over week
// whenever a new week's low exceeds the current trailing value.
function computeTrailingStopLoss(candles, initialStopLoss, purchaseDate) {
  if (initialStopLoss == null) return null;

  let trailing = initialStopLoss;
  const purchaseTime = purchaseDate ? new Date(purchaseDate).getTime() : null;
  for (const candle of candles) {
    if (purchaseTime != null && new Date(candle.date).getTime() < purchaseTime) {
      continue;
    }
    if (candle.low > trailing) trailing = candle.low;
  }
  return trailing;
}

async function checkStopLossDeviation(symbol, stopLoss) {
  if (stopLoss == null) return null;
  const historical = await getHistoricalStopLoss(symbol);
  if (!historical || !historical.stopLoss) return null;

  const deviation = Math.abs(stopLoss - historical.stopLoss) / historical.stopLoss;
  if (deviation <= STOP_LOSS_DEVIATION_THRESHOLD) return null;

  return { historicalStopLoss: historical.stopLoss, scanDate: historical.scanDate };
}

/**
 * holdings: array of {id, symbol, name, quantity, avgBuyPrice, stopLoss, purchaseDate}
 *
 * The Signal column is deliberately based on only two things, nothing else:
 * (1) price closing at/below the trailing stop loss — capital-preservation
 *     exit, and (2) MACD line currently below signal line (sustained bearish
 *     state, not just the exact crossing week) — momentum-fading exit.
 */
export async function evaluateHoldings(holdings) {
  const limiter = pLimit(HOLDINGS_CONCURRENCY);

  const evaluated = await Promise.all(
    holdings.map((holding) =>
      limiter(async () => {
        const ySymbol = `${holding.symbol}.NS`;
        try {
          const candles = await fetchWeeklyCandles(ySymbol);
          const price = candles.length
            ? candles[candles.length - 1].close
            : null;

          let macdBullish = null;
          if (candles.length > 30) {
            const indicators = computeIndicators(candles);
            const lastMacd = indicators.macd[indicators.macd.length - 1];
            if (lastMacd && lastMacd.MACD != null && lastMacd.signal != null) {
              macdBullish = lastMacd.MACD > lastMacd.signal;
            }
          }

          const trailingStopLoss = computeTrailingStopLoss(
            candles,
            holding.stopLoss,
            holding.purchaseDate
          );

          const stopLossHit =
            trailingStopLoss != null && price != null && price <= trailingStopLoss;
          const macdSell = macdBullish === false;

          let sellReason = null;
          if (stopLossHit) sellReason = "stop_loss";
          else if (macdSell) sellReason = "macd";

          const stopLossWarning = await checkStopLossDeviation(
            holding.symbol,
            holding.stopLoss
          );

          return {
            ...holding,
            price,
            macdBullish,
            trailingStopLoss,
            sellSignal: sellReason != null,
            sellReason,
            stopLossWarning,
          };
        } catch {
          return {
            ...holding,
            price: null,
            macdBullish: null,
            trailingStopLoss: holding.stopLoss ?? null,
            sellSignal: false,
            sellReason: null,
            stopLossWarning: null,
            error: true,
          };
        }
      })
    )
  );

  await persistCandlesCache();
  return evaluated;
}
