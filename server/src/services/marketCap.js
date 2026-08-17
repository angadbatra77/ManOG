import yahooFinance from "./yahooClient.js";
import { MARKET_CAP_THRESHOLD, QUOTE_BATCH_SIZE } from "../config.js";

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Given a list of {symbol, name} entries, returns only those whose market cap
 * exceeds MARKET_CAP_THRESHOLD, each annotated with current price + market cap.
 */
export async function filterByMarketCap(universe) {
  const batches = chunk(universe, QUOTE_BATCH_SIZE);
  const bySymbol = new Map(universe.map((u) => [u.symbol, u]));
  const passed = [];

  for (const batch of batches) {
    const symbols = batch.map((u) => u.symbol);
    let quotes;
    try {
      quotes = await yahooFinance.quote(symbols);
    } catch (err) {
      // A single bad symbol can fail the whole batch; retry one-by-one as a fallback.
      quotes = [];
      for (const symbol of symbols) {
        try {
          const q = await yahooFinance.quote(symbol);
          if (q) quotes.push(q);
        } catch {
          // skip symbols yahoo doesn't recognize
        }
      }
    }

    const quoteList = Array.isArray(quotes) ? quotes : [quotes];
    for (const q of quoteList) {
      if (!q || !q.symbol) continue;
      if (typeof q.marketCap !== "number") continue;
      if (q.marketCap <= MARKET_CAP_THRESHOLD) continue;
      const meta = bySymbol.get(q.symbol);
      if (!meta) continue;
      passed.push({
        symbol: q.symbol,
        name: meta.name,
        marketCap: q.marketCap,
        price: q.regularMarketPrice ?? null,
      });
    }
  }

  return passed;
}
