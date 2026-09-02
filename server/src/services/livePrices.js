import pLimit from "p-limit";
import yahooFinance from "./yahooClient.js";

// The one deliberately LIVE number in the app.
//
// Everything else on the Screener is pinned to the last fully completed
// week (see weeklyResample.js) so the list can't reshape mid-week. That's
// correct for the signal itself, but it makes "% Chg Since Criteria"
// useless for exactly the freshest signals: in a stock's first week in
// criteria the breakout close and the "current" close are the same
// candle, so the column reads +0.00% by construction — for ~40% of the
// table on a typical run. This fetches a real quote for the symbols
// currently on screen so that number can be recomputed against a price
// that has actually moved, without letting live data anywhere near the
// weekly candles the signal logic depends on.
//
// Deliberately a separate endpoint rather than a field baked into the
// screener results: those are computed once per weekly refresh and
// cached, so a "live" price stored there would be a lie by Wednesday.
//
// Uses chart(), NOT quote(), and that distinction is the whole reason
// this works in production. Yahoo's v7 quote endpoint blocks
// cloud-provider IPs — from Render every quote() comes back empty, for
// every symbol, including RELIANCE and TCS, while the same call works
// fine from a laptop. The chart endpoint has no such block: the weekly
// refresh pulls candles for ~1400 symbols through it from Render
// without trouble. chart()'s meta carries regularMarketPrice, which is
// the same live number quote() would have given us. Do not "simplify"
// this back to a batched quote() call — it will pass every local test
// and return nothing but dashes once deployed.

const TTL_MS = 60 * 1000;
const FETCH_CONCURRENCY = 12;
// Yahoo pins regularMarketTime to the closing bell once a session ends,
// so a quote timestamp that has stopped advancing IS the "market is
// closed" signal. chart()'s meta has no marketState field of its own.
const LIVE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_SYMBOLS = 300;

// Cached per symbol rather than as one timestamped map: the set of
// symbols asked for shifts between refreshes and between tabs, and a
// whole-map TTL would throw away still-fresh quotes every time that set
// changed by one.
const cache = new Map();

// Describes the exchange rather than any one symbol, so it can't live in
// the per-symbol cache: a request served entirely from cache does no
// fetching and would otherwise report "state unknown" and drop the live
// indicator seconds after a successful fetch.
let lastQuoteTime = null;

async function fetchOne(plainSymbol) {
  const chart = await yahooFinance.chart(`${plainSymbol}.NS`, {
    // Narrowest range Yahoo will still answer with a populated meta —
    // we only want meta.regularMarketPrice, never the candles.
    period1: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    interval: "1d",
  });
  const meta = chart?.meta;
  const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
  const at = meta?.regularMarketTime ? new Date(meta.regularMarketTime).toISOString() : null;
  return { price, at };
}

/**
 * Live prices for a list of plain NSE symbols (no .NS suffix).
 * Returns { prices: { SYMBOL: number|null }, asOf, marketState }.
 *
 * Never throws on a Yahoo failure — a symbol Yahoo won't return comes
 * back as null and the UI shows "—" for it. A dead live column is a far
 * better outcome than a page view that fails, which is the same trade
 * indices.js already makes.
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
    const limiter = pLimit(FETCH_CONCURRENCY);
    const settled = await Promise.all(
      missing.map((symbol) =>
        limiter(async () => {
          try {
            return { symbol, ...(await fetchOne(symbol)) };
          } catch {
            return { symbol, price: null, at: null };
          }
        })
      )
    );

    for (const { symbol, price, at } of settled) {
      if (price == null) {
        // Yahoo can fail one symbol without failing the rest. Rather
        // than blank it the moment one fetch misses, fall back to the
        // last price we did get — a minutes-old quote is still far more
        // informative than the week-old candle close this column exists
        // to improve on.
        const stale = cache.get(symbol);
        prices[symbol] = stale ? stale.price : null;
        continue;
      }
      cache.set(symbol, { price, fetchedAt: now });
      prices[symbol] = price;
      if (at && (!lastQuoteTime || at > lastQuoteTime)) lastQuoteTime = at;
    }
  }

  const asOf = lastQuoteTime ?? new Date().toISOString();
  const marketState =
    lastQuoteTime && Date.now() - new Date(lastQuoteTime).getTime() < LIVE_WINDOW_MS
      ? "REGULAR"
      : "CLOSED";

  return { prices, asOf, marketState };
}
