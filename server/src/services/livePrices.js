import pLimit from "p-limit";
import { fetchQuotesForBatch } from "./marketCap.js";
import { QUOTE_BATCH_SIZE } from "../config.js";

// The one deliberately LIVE number in the app.
//
// Everything else on the Screener is pinned to the last fully completed
// week (see weeklyResample.js) so the list can't reshape mid-week. That's
// correct for the signal itself, but it makes "% Chg Since Criteria"
// useless for exactly the freshest signals: in a stock's first week in
// criteria the breakout close and the "current" close are the same candle,
// so the column reads +0.00% by construction — for ~40% of the table on a
// typical run. This fetches a real quote for the symbols currently on
// screen so that number can be recomputed against a price that has
// actually moved, without letting live data anywhere near the weekly
// candles the signal logic depends on.
//
// Deliberately a separate endpoint rather than a field baked into the
// screener results: those are computed once per weekly refresh and cached,
// so a "live" price stored there would be a lie by Wednesday.

const TTL_MS = 60 * 1000;
const QUOTE_BATCH_CONCURRENCY = 5;
export const MAX_SYMBOLS = 300;

// Cached per symbol rather than as one timestamped map: the set of symbols
// asked for shifts between refreshes and between tabs, and a whole-map TTL
// would throw away still-fresh quotes every time that set changed by one.
const cache = new Map();

// marketState and the quote timestamp describe the whole exchange, not any
// one symbol, so they can't live in the per-symbol cache: a request served
// entirely from cache does no fetching and would otherwise report "market
// state unknown" and hide the live indicator, even seconds after a
// successful fetch. Kept separately and always returned.
let lastQuoteMeta = { marketState: null, quoteTime: null };

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Live quotes for a list of plain NSE symbols (no .NS suffix).
 * Returns { prices: { SYMBOL: number|null }, asOf, marketState }.
 *
 * Never throws on a Yahoo failure — a symbol Yahoo won't return comes back
 * as null and the UI shows "—" for it. A dead live column is a far better
 * outcome than a page view that fails, which is the same trade indices.js
 * already makes.
 */
export async function getLivePrices(plainSymbols) {
  const now = Date.now();
  const prices = {};
  const missing = [];

  for (const symbol of plainSymbols) {
    const hit = cache.get(symbol);
    if (hit && now - hit.fetchedAt < TTL_MS) {
      prices[symbol] = hit.price;
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length > 0) {
    const limiter = pLimit(QUOTE_BATCH_CONCURRENCY);
    const batches = chunk(missing.map((s) => `${s}.NS`), QUOTE_BATCH_SIZE);
    const batchResults = await Promise.all(
      batches.map((batch) => limiter(() => fetchQuotesForBatch(batch)))
    );

    const returned = new Set();
    for (const quoteList of batchResults) {
      for (const q of quoteList) {
        if (!q?.symbol) continue;
        const plain = q.symbol.replace(/\.NS$/, "");
        const price = typeof q.regularMarketPrice === "number" ? q.regularMarketPrice : null;
        if (price == null) continue;
        if (q.marketState) lastQuoteMeta.marketState = q.marketState;
        // The exchange's own timestamp for the price, not the moment we
        // asked — after hours those differ by hours, and the UI labels
        // this number as of when it was actually true.
        if (q.regularMarketTime) {
          const t = new Date(q.regularMarketTime).toISOString();
          if (!lastQuoteMeta.quoteTime || t > lastQuoteMeta.quoteTime) {
            lastQuoteMeta.quoteTime = t;
          }
        }
        cache.set(plain, { price, fetchedAt: now });
        prices[plain] = price;
        returned.add(plain);
      }
    }

    // Yahoo blocks cloud-provider IPs without warning (marketCap.js has the
    // same scar). Rather than blank out a symbol the moment one fetch
    // fails, fall back to the last price we did get for it — a
    // minutes-old quote is still enormously more informative than the
    // week-old candle close this column exists to improve on.
    for (const symbol of missing) {
      if (returned.has(symbol)) continue;
      const stale = cache.get(symbol);
      prices[symbol] = stale ? stale.price : null;
    }
  }

  return {
    prices,
    asOf: lastQuoteMeta.quoteTime ?? new Date().toISOString(),
    marketState: lastQuoteMeta.marketState,
  };
}
