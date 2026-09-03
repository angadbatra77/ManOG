import pLimit from "p-limit";
import { fetchWeeklyCandles, persistCandlesCache } from "./screener.js";
import { computeIndicators } from "./indicators.js";
import { getHistoricalStopLoss } from "./historyDb.js";
import { getStoredDailyCandles } from "./dailyCandlesDb.js";
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

// Ratchets the stop up to the highest weekly CLOSE since entry, never down.
//
// This used to trail the highest weekly LOW. Trailing the close instead sits
// higher, so it cuts sooner, and it tested better in both decades
// independently — 68.13% vs 50.56% over 2006-16 and 60.92% vs 36.23% over
// 2016-26, worth about six points a year over the full period. Looser
// variants were monotonically worse (10%, 15%, 20% trailing all lost in both
// halves), so this is a direction rather than a fitted peak: the strategy
// earns by recycling capital quickly, not by giving losers room.
//
// The initial stop is still the breakout week's low, and the ratchet only
// considers weeks AFTER the signal week — the breakout week's own close is
// not part of it. That is exactly how the variant was backtested.
function computeTrailingStopLoss(candles, initialStopLoss, anchorDate) {
  if (initialStopLoss == null) return null;

  let trailing = initialStopLoss;
  const anchorTime = anchorDate ? new Date(anchorDate).getTime() : null;
  for (const candle of candles) {
    if (anchorTime != null && new Date(candle.date).getTime() <= anchorTime) {
      continue;
    }
    if (candle.close > trailing) trailing = candle.close;
  }
  return trailing;
}

// Did any DAILY low go through the stop? The daily candles are already in
// Supabase for every symbol the screener has ever fetched, so this costs a
// single read and needs no new data source.
//
// The window starts when the stop actually goes live — the later of grace
// ending and the purchase date — never at the signal. Scanning from the
// signal week reports a breach on every position the moment it is added,
// because the initial stop IS that week's low, so a day inside it touches
// the level by definition. You also cannot be stopped out of something you
// had not yet bought.
//
// Within that window it scans every day rather than just the latest: a
// breach three days ago still means the position should be gone, and if no
// GTT was resting at the broker nothing else would ever tell you.
async function findDailyBreach(symbol, stopLoss, graceEndsDate, purchaseDate) {
  if (stopLoss == null || !graceEndsDate) return null;
  const liveFrom = [graceEndsDate, purchaseDate]
    .filter(Boolean)
    .map((d) => String(d).slice(0, 10))
    .sort()
    .pop();
  if (!liveFrom || liveFrom > new Date().toISOString().slice(0, 10)) return null;
  try {
    const daily = await getStoredDailyCandles(symbol, liveFrom);
    for (const d of daily) {
      if (d.low != null && d.low <= stopLoss) {
        return { date: d.date, low: d.low, close: d.close };
      }
    }
  } catch {
    // Supabase unavailable — fall back to reporting no breach rather than
    // inventing one. The GTT at the broker is the real protection; this
    // check is a safety net, and a silent net is better than a false alarm.
  }
  return null;
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

          // The stop is breached the moment any DAILY low touches it, not
          // when a weekly close finishes below it. That distinction is the
          // whole strategy: backtested with a resting broker order filling
          // at the trigger it returns ~36% a year, and on a weekly-close
          // check ~4%. Checking the weekly close here would quietly report
          // a position as safe for days after the stop had actually gone.
          const dailyBreach = await findDailyBreach(
            holding.symbol,
            trailingStopLoss,
            grace.graceEndsDate,
            holding.purchaseDate
          );
          const stopLossHit = dailyBreach != null;
          const macdSell = macdBullish === false;
          // During grace no stop is live, so there is nothing to scan for.
          // This cheaper check drives the early-warning state only.
          const wouldBreachNow =
            trailingStopLoss != null && price != null && price <= trailingStopLoss;

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
            // The number to actually place at the broker, and the date it
            // becomes live. The app cannot enforce a stop itself — a web
            // page can't watch the market — so its job is to hand you the
            // right figure on the right day.
            gttTrigger: trailingStopLoss,
            gttDueDate: grace.graceEndsDate,
            gttLive: !grace.inGracePeriod,
            // The stop only moves when a weekly candle completes, so this
            // says whether the GTT needs changing at all this week.
            stopRatchetedAbove: trailingStopLoss != null && holding.stopLoss != null
              ? trailingStopLoss > holding.stopLoss : false,
            // Set when a daily low has already gone through the stop. If a
            // GTT is in place this is history; if one isn't, it is a missed
            // exit and needs acting on now.
            dailyBreach,
            // what the exit checks would say right now, ignoring grace —
            // shown to the UI as an early-warning "watch" state, not a sell
            wouldSellReason: grace.inGracePeriod ? (wouldBreachNow ? "stop_loss" : macdSell ? "macd" : null) : null,
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
