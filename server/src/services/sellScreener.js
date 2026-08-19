import pLimit from "p-limit";
import { fetchWeeklyCandles, persistCandlesCache } from "./screener.js";
import { computeIndicators } from "./indicators.js";

const HOLDINGS_CONCURRENCY = 5;

function evaluateSellSignal(candles, indicators) {
  const lastIdx = candles.length - 1;
  const prevIdx = lastIdx - 1;
  if (prevIdx < 0) return null;

  const macdNow = indicators.macd[lastIdx];
  const macdPrev = indicators.macd[prevIdx];
  if (
    !macdNow ||
    !macdPrev ||
    macdNow.MACD == null ||
    macdNow.signal == null ||
    macdPrev.MACD == null ||
    macdPrev.signal == null
  ) {
    return null;
  }

  const crossedBelow =
    macdPrev.MACD >= macdPrev.signal && macdNow.MACD < macdNow.signal;
  if (!crossedBelow) return null;

  return { signalDate: candles[lastIdx].date };
}

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

/**
 * holdings: array of {id, symbol, name, quantity, avgBuyPrice, stopLoss, purchaseDate}
 * Returns each holding annotated with live price, MACD bullish/bearish state,
 * whether a sell signal (MACD crossed below signal this week) just fired, and
 * the current trailing stop loss.
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
          let sellSignal = false;
          let signalDate = null;

          if (candles.length > 30) {
            const indicators = computeIndicators(candles);
            const lastMacd = indicators.macd[indicators.macd.length - 1];
            if (lastMacd && lastMacd.MACD != null && lastMacd.signal != null) {
              macdBullish = lastMacd.MACD > lastMacd.signal;
            }
            const signal = evaluateSellSignal(candles, indicators);
            if (signal) {
              sellSignal = true;
              signalDate = signal.signalDate;
            }
          }

          const trailingStopLoss = computeTrailingStopLoss(
            candles,
            holding.stopLoss,
            holding.purchaseDate
          );

          return {
            ...holding,
            price,
            macdBullish,
            sellSignal,
            signalDate,
            trailingStopLoss,
          };
        } catch {
          return {
            ...holding,
            price: null,
            macdBullish: null,
            sellSignal: false,
            signalDate: null,
            trailingStopLoss: holding.stopLoss ?? null,
            error: true,
          };
        }
      })
    )
  );

  await persistCandlesCache();
  return evaluated;
}
