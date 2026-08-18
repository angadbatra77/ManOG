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

/**
 * holdings: array of {id, symbol, name, quantity, avgBuyPrice}
 * Returns each holding annotated with live price, MACD bullish/bearish state,
 * and whether a sell signal (MACD crossed below signal this week) just fired.
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

          return { ...holding, price, macdBullish, sellSignal, signalDate };
        } catch {
          return {
            ...holding,
            price: null,
            macdBullish: null,
            sellSignal: false,
            signalDate: null,
            error: true,
          };
        }
      })
    )
  );

  await persistCandlesCache();
  return evaluated;
}
