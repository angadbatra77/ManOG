import pLimit from "p-limit";
import { fetchWeeklyCandles, persistCandlesCache } from "./screener.js";
import { computeIndicators } from "./indicators.js";
import { getHistoricalStopLoss } from "./historyDb.js";
import { GRACE_WEEKS } from "../config.js";

const HOLDINGS_CONCURRENCY = 5;
// how far the entered stop loss can deviate from what we last recorded for
// this stock in the screener before it's flagged as a likely mistake
const STOP_LOSS_DEVIATION_THRESHOLD = 0.25;
const GRACE_DAYS = GRACE_WEEKS * 7;

// Validated exit rule: for GRACE_WEEKS after purchase, neither the stop-loss
// nor the MACD check is allowed to fire — the position is given room to
// prove itself before it can be judged. The trailing stop still ratchets up
// underneath during grace (so it's ready the moment grace ends), it just
// can't trigger a sell yet.
function computeGraceStatus(purchaseDate) {
  const purchaseTime = purchaseDate ? new Date(purchaseDate).getTime() : null;
  if (purchaseTime == null || Number.isNaN(purchaseTime)) {
    return { inGracePeriod: false, graceEndsDate: null, daysRemainingInGrace: 0, weeksRemainingInGrace: 0 };
  }
  const graceEndsTime = purchaseTime + GRACE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const daysRemaining = Math.max(0, Math.ceil((graceEndsTime - now) / (24 * 60 * 60 * 1000)));
  return {
    inGracePeriod: now < graceEndsTime,
    graceEndsDate: new Date(graceEndsTime).toISOString().slice(0, 10),
    daysRemainingInGrace: daysRemaining,
    weeksRemainingInGrace: Math.ceil(daysRemaining / 7),
  };
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

async function checkStopLossDeviation(symbol, stopLoss) {
  if (stopLoss == null) return null;
  const historical = await getHistoricalStopLoss(symbol);
  if (!historical || !historical.stopLoss) return null;

  const deviation = Math.abs(stopLoss - historical.stopLoss) / historical.stopLoss;
  if (deviation <= STOP_LOSS_DEVIATION_THRESHOLD) return null;

  return { historicalStopLoss: historical.stopLoss, scanDate: historical.scanDate };
}

/**
 * holdings: array of {id, symbol, name, quantity, avgBuyPrice, stopLoss, purchaseDate, signalDate}
 *
 * The Signal column is deliberately based on only two things, nothing else:
 * (1) price closing at/below the trailing stop loss — capital-preservation
 *     exit, and (2) MACD line currently below signal line (sustained bearish
 *     state, not just the exact crossing week) — momentum-fading exit.
 * Neither can fire during the GRACE_WEEKS window after the ORIGINAL signal
 * date (not purchaseDate, if they differ) — the biggest validated
 * improvement from backtesting was giving a position that long to prove
 * itself before either check is allowed to sell it. Anchoring to signalDate
 * means buying a signal a few weeks late doesn't earn extra, unvalidated
 * grace time beyond what the backtest actually gave it.
 */
export async function evaluateHoldings(holdings) {
  const limiter = pLimit(HOLDINGS_CONCURRENCY);

  const evaluated = await Promise.all(
    holdings.map((holding) =>
      limiter(async () => {
        const ySymbol = `${holding.symbol}.NS`;
        const graceAnchor = holding.signalDate ?? holding.purchaseDate;
        const grace = computeGraceStatus(graceAnchor);
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
            graceAnchor
          );

          const stopLossHit =
            trailingStopLoss != null && price != null && price <= trailingStopLoss;
          const macdSell = macdBullish === false;

          let sellReason = null;
          if (!grace.inGracePeriod) {
            if (stopLossHit) sellReason = "stop_loss";
            else if (macdSell) sellReason = "macd";
          }

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
            ...grace,
            // what the exit checks would say right now, ignoring grace —
            // shown to the UI as an early-warning "watch" state, not a sell
            wouldSellReason: grace.inGracePeriod ? (stopLossHit ? "stop_loss" : macdSell ? "macd" : null) : null,
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
            ...grace,
            wouldSellReason: null,
            error: true,
          };
        }
      })
    )
  );

  await persistCandlesCache();
  return evaluated;
}
