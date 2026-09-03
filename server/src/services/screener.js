import fs from "node:fs/promises";
import path from "node:path";
import yahooFinance from "./yahooClient.js";
import pLimit from "p-limit";
import { getNseUniverse } from "./nseUniverse.js";
import { filterByMarketCap, getMarketCapFreshness } from "./marketCap.js";
import { computeIndicators } from "./indicators.js";
import { computeStreak } from "./streak.js";
import { fetchDailyCandlesUpstox } from "./upstoxData.js";
import { getFirstSeenDate } from "./historyDb.js";
import { getOrFetchSector } from "./sectorDb.js";
import { fetchAndStoreIndexQuotes } from "./indices.js";
import { computeCurrentEquity, findWeakestHolding } from "./equity.js";
import { groupIntoWeeks, keepOnlyCompletedWeeks, toISTDateString } from "./weeklyResample.js";
import {
  getLatestStoredDate,
  getStoredDailyCandles,
  upsertDailyCandles,
} from "./dailyCandlesDb.js";
import {
  RSI_BUY_LEVEL,
  WEEKLY_LOOKBACK_WEEKS,
  HISTORY_CONCURRENCY,
  DATA_DIR,
  GRACE_WEEKS,
  PCT_OF_EQUITY_PER_TRADE,
  MAX_TRADE_VALUE,
} from "../config.js";

const LOOKBACK_DAYS = WEEKLY_LOOKBACK_WEEKS * 7;

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

const CANDLES_CACHE_FILE = path.join(DATA_DIR, "weekly-candles-cache.json");
// The underlying answer only actually changes once a week now
// (keepOnlyCompletedWeeks), so this TTL just avoids redundant Supabase
// round-trips on repeat refresh clicks within the window, not staleness.
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
async function fetchDailyCandlesFromVendors(symbol, lookbackDays) {
  let daily = null;
  try {
    daily = await fetchDailyCandlesUpstox(symbol, lookbackDays);
  } catch {
    daily = null; // fall through to Yahoo below
  }

  if (daily) return daily;

  const result = await yahooFinance.chart(symbol, {
    period1: daysAgoDate(lookbackDays),
    interval: "1d",
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

function daysSince(dateStr) {
  const from = new Date(`${dateStr}T00:00:00Z`);
  return Math.floor((Date.now() - from.getTime()) / (24 * 60 * 60 * 1000));
}

// Weekly candles are built here from DAILY candles, not requested directly
// from either vendor's own "weekly" interval. This matches exactly how the
// validated 20-year backtest constructs weeks (see weeklyResample.js).
//
// The app runs on a weekly cadence: keepOnlyCompletedWeeks always drops
// whatever week is still in progress, so every refresh — whenever it
// actually runs — resolves to the same answer, the most recently FULLY
// COMPLETED week. That's what makes "a fresh list every Monday, the same
// list all week" an actual guarantee rather than a scheduling convention:
// even a manual refresh on a Wednesday still shows last week's complete
// data, never a partial mid-week shape.
//
// The daily history itself is persisted in Supabase (daily_candles), not
// re-downloaded wholesale on every refresh. A symbol we've already seen
// before only needs "yesterday -> today" fetched and appended; only a
// brand-new symbol (or a Supabase outage) pays the full ~2-year fetch.
export async function fetchWeeklyCandles(symbol) {
  const cache = await loadCandlesCache();
  const entry = cache[symbol];
  if (entry && Date.now() - entry.fetchedAt < CANDLES_TTL_MS) {
    return entry.candles;
  }

  const plainSymbol = symbol.replace(/\.NS$/, "");

  let latestStored = null;
  try {
    latestStored = await getLatestStoredDate(plainSymbol);
  } catch {
    latestStored = null; // Supabase hiccup — treat as first-time below
  }

  // A small buffer past the actual gap absorbs weekends/holidays/a missed
  // refresh day or two without needing exact trading-calendar math; capped
  // at the full lookback so a very stale or never-seen symbol just falls
  // back to a full historical fetch instead of an insufficient window.
  const fetchDays = latestStored
    ? Math.min(LOOKBACK_DAYS, Math.max(3, daysSince(latestStored) + 3))
    : LOOKBACK_DAYS;

  const fetched = await fetchDailyCandlesFromVendors(symbol, fetchDays);

  if (fetched.length > 0) {
    try {
      await upsertDailyCandles(plainSymbol, fetched);
    } catch {
      // storage failing shouldn't break the screener — worst case this
      // same slice gets re-fetched next refresh instead of being skipped
    }
  }

  let daily = fetched;
  try {
    const cutoff = toISTDateString(daysAgoDate(LOOKBACK_DAYS));
    const stored = await getStoredDailyCandles(plainSymbol, cutoff);
    if (stored.length > 0) daily = stored;
  } catch {
    // Supabase read failing — fall back to whatever was just fetched over
    // the network (a short window if this symbol already had history)
  }

  const completedDaily = keepOnlyCompletedWeeks(daily);
  const candles = groupIntoWeeks(completedDaily).map((w) => w.candle);

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

// Only stocks that entered criteria in the most recent COMPLETED week.
//
// This used to show anything still qualifying within GRACE_WEEKS, on the
// reasoning that a signal inside its own grace window is still "live". The
// data disagrees. Buying N weeks after the signal, on 20 years:
//
//   0 weeks   100% of signals still qualify   45.72% CAGR
//   1 week     58%                            43.44%
//   2 weeks    35%                            39.24%
//   4 weeks     9%                            28.19%
//   8 weeks     0.2%                           1.17%
//
// It fails in both decades independently, and for two compounding reasons.
// These signals decay fast — after four weeks only 9% still qualify — and
// the survivors are not better: mean return per trade falls from 16.66% to
// 14.03%, because the wait costs you the part of the move you were paid
// for. Meanwhile the trade count collapses from 6,601 to 879, so the
// portfolio cannot stay deployed.
//
// weeksInCriteria is computed from completed weeks only, so it stays at 1
// for the whole week and the list does not empty itself mid-week — the
// failure mode the old day-based window had.
function isWithinBuyWindow(weeksInCriteria) {
  return weeksInCriteria === 1;
}

// If you buy now instead of on the fresh breakout week, the grace period
// should still end GRACE_WEEKS after the ORIGINAL signal, not GRACE_WEEKS
// after today — otherwise a late entry gets extra, unvalidated protection
// time it was never backtested with.
function remainingGraceWeeks(weeksInCriteria) {
  return Math.max(0, GRACE_WEEKS - (weeksInCriteria - 1));
}

// firstSeenDate exists to SHARPEN the week-start date, not to replace it:
// a stock that broke out on the Wednesday reads more truthfully as
// "Wednesday" than as the Monday its week is keyed to. That only holds
// while the observation actually lands inside the breakout week. History
// has gaps — the app has only recorded snapshots since mid-Aug 2026, and
// rows written before 31 Aug stored signal_date as the scan timestamp
// rather than the week start, so they cannot be matched to a signal at
// all. Outside the breakout week the earliest match is therefore not
// "when this signal appeared", it is just the first scan that happened to
// see an already-running streak, which is frequently the current one.
// Taking that literally is exactly how a 7-week-old signal ends up
// claiming it entered criteria 1 day ago. Past the breakout week the
// week-start is the honest answer.
function effectiveCriteriaDate(firstSeenDate, signalDate) {
  if (!firstSeenDate) return signalDate;
  const seen = new Date(firstSeenDate).getTime();
  const weekStart = new Date(signalDate).getTime();
  if (Number.isNaN(seen) || Number.isNaN(weekStart)) return signalDate;
  const withinBreakoutWeek = seen >= weekStart && seen - weekStart < 7 * 24 * 60 * 60 * 1000;
  return withinBreakoutWeek ? firstSeenDate : signalDate;
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
  // Refreshes the index grid's stored quotes once per screener run rather
  // than the browser hitting Yahoo live on every page view — see
  // indices.js. Never allowed to break the actual screener run: a Yahoo
  // hiccup here just means the index grid keeps showing its last stored
  // values instead of failing the whole refresh.
  fetchAndStoreIndexQuotes().catch((err) =>
    console.error("Failed to refresh index quotes:", err.message)
  );

  // Computed once up front, not per-candidate — every signal is sized off
  // the SAME snapshot of total equity, matching how the validated backtest
  // sizes every trade off current total equity, not a shrinking remainder.
  const equity = await computeCurrentEquity();

  const universe = await getNseUniverse();
  const capFiltered = await filterByMarketCap(universe);
  if (capFiltered.length === 0) {
    // Only possible on a true cold start (no prior successful fetch to fall
    // back to) — marketCap.js otherwise serves stale cached candidates
    // instead of ever returning empty. Nothing to show, so this has to fail.
    throw new Error(
      "Market cap filtering returned 0 candidates and no prior data exists to fall back to — likely a Yahoo Finance API failure, not a real market condition"
    );
  }
  const marketCapFreshness = await getMarketCapFreshness();
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
              const effectiveDateStr = effectiveCriteriaDate(firstSeenDate, signal.signalDate);
              // How the price has moved since the ORIGINAL breakout close,
              // not since a calendar week/month ago (that's change1w/1m) —
              // this is "what would my return be if I'd bought the week it
              // first entered criteria," and also the price-drift gate
              // that decides whether an older, still-streaking signal is
              // still close enough to its entry to be worth showing.
              const changeSinceEntry = signal.priceAtSignal
                ? ((currentPrice - signal.priceAtSignal) / signal.priceAtSignal) * 100
                : null;

              if (isWithinBuyWindow(signal.weeksInCriteria)) {
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
                  // The date the UI actually labels the row with, resolved
                  // here rather than re-derived in the browser so the date
                  // shown and the day count beneath it can never disagree.
                  criteriaSinceDate: effectiveDateStr,
                  priceAtSignal: signal.priceAtSignal,
                  changeSinceEntry,
                  // Calendar days since the same effective "day zero" the
                  // row is labelled with (see effectiveCriteriaDate) — a
                  // real day count, not weeksInCriteria*7, so a signal
                  // that broke out mid-week reads correctly instead of
                  // jumping in fixed 7-day steps.
                  daysInCriteria: Math.round(
                    (Date.now() - new Date(effectiveDateStr).getTime()) / (24 * 60 * 60 * 1000)
                  ),
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

  // Sector is looked up only for the small set of stocks that actually made
  // the final list, not the whole candidate universe — it's a separate
  // per-symbol Yahoo call from the price data above, and a sector almost
  // never changes, so it's cached indefinitely in Supabase (sectorDb.js)
  // rather than being a recurring cost.
  const sectors = await Promise.all(results.map((r) => getOrFetchSector(r.symbol)));
  results.forEach((r, i) => { r.sector = sectors[i]; });

  // Order of preference: strongest breakout first (highest % above the
  // upper Bollinger Band at signal) — matches the priority ranking used
  // throughout the validated backtest, not just whichever stock happened
  // to move the most this week.
  results.sort((a, b) => (b.strengthPct ?? -Infinity) - (a.strengthPct ?? -Infinity));
  results.forEach((r, i) => { r.rank = i + 1; });

  // Position-sizing suggestion, on-screen only — this never places an
  // order or touches your holdings. Walks the ranked list in order,
  // spending down a running copy of your available cash, so a strong
  // signal further down the list correctly sees less cash left than one
  // above it already "claimed" — same sequencing the backtest's priority
  // reallocation used, just advisory here instead of automatic.
  const weakestHolding = findWeakestHolding(equity.holdings);
  let remainingCash = equity.availableCash;
  for (const r of results) {
    const suggestedAmount = Math.min(equity.totalEquity * (PCT_OF_EQUITY_PER_TRADE / 100), MAX_TRADE_VALUE);
    const suggestedShares = r.price ? Math.floor(suggestedAmount / r.price) : 0;
    const cost = suggestedShares * (r.price ?? 0);
    const affordable = suggestedShares >= 1 && cost <= remainingCash;

    r.suggestedShares = suggestedShares;
    r.suggestedAmount = Math.round(suggestedAmount);
    r.affordableNow = affordable;
    r.reallocationSuggestion = null;

    if (affordable) {
      remainingCash -= cost;
    } else if (weakestHolding && (r.strengthPct ?? -Infinity) > (weakestHolding.strengthPct ?? -Infinity)) {
      r.reallocationSuggestion = {
        symbol: weakestHolding.symbol,
        strengthPct: weakestHolding.strengthPct,
        marketValue: Math.round(weakestHolding.marketValue),
      };
    }
  }

  return { results, stale: marketCapFreshness.stale, staleAsOf: marketCapFreshness.asOf };
}
