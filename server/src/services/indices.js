import yahooFinance from "./yahooClient.js";

// Broad + sectoral index tickers, confirmed working directly against Yahoo
// before wiring this up (see session notes) — Yahoo's index symbols don't
// always match the obvious guess (e.g. Nifty Next 50, historically called
// "Junior Nifty", is ^NSMIDCP, not anything with "JUNIOR" in it).
const INDEX_LIST = [
  { symbol: "^BSESN", label: "SENSEX" },
  { symbol: "^NSEI", label: "NIFTY 50" },
  { symbol: "^NSMIDCP", label: "NIFTY NEXT 50" }, // Junior Nifty
  { symbol: "^NSEBANK", label: "BANK NIFTY" },
  { symbol: "^CNXIT", label: "NIFTY IT" },
  { symbol: "^CNXAUTO", label: "NIFTY AUTO" },
  { symbol: "^CNXPHARMA", label: "NIFTY PHARMA" },
  { symbol: "^CNXFMCG", label: "NIFTY FMCG" },
  { symbol: "^CNXMETAL", label: "NIFTY METAL" },
  { symbol: "^CNXREALTY", label: "NIFTY REALTY" },
  { symbol: "^CNXENERGY", label: "NIFTY ENERGY" },
  { symbol: "^CNXMEDIA", label: "NIFTY MEDIA" },
  { symbol: "^CNXPSUBANK", label: "NIFTY PSU BANK" },
  { symbol: "^CNXFIN", label: "NIFTY FIN SERVICE" },
  { symbol: "^CNXINFRA", label: "NIFTY INFRA" },
];

const CACHE_TTL_MS = 60 * 1000; // "live" without hammering Yahoo on every poll
let cache = { fetchedAt: 0, quotes: [] };

async function fetchOne(symbol, label) {
  try {
    const q = await yahooFinance.quote(symbol);
    return {
      symbol,
      label,
      price: q?.regularMarketPrice ?? null,
      changePercent: q?.regularMarketChangePercent ?? null,
    };
  } catch {
    return { symbol, label, price: null, changePercent: null };
  }
}

export async function getIndexQuotes() {
  if (Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.quotes.length > 0) {
    return cache.quotes;
  }

  let quotes;
  try {
    // One batch call for all of them — cheap, same pattern as marketCap.js.
    const symbols = INDEX_LIST.map((i) => i.symbol);
    const results = await yahooFinance.quote(symbols);
    const arr = Array.isArray(results) ? results : [results];
    const bySymbol = new Map(arr.map((q) => [q.symbol, q]));
    quotes = INDEX_LIST.map(({ symbol, label }) => {
      const q = bySymbol.get(symbol);
      return {
        symbol,
        label,
        price: q?.regularMarketPrice ?? null,
        changePercent: q?.regularMarketChangePercent ?? null,
      };
    });
  } catch {
    // Batch call failed outright (seen in practice — a transient Yahoo
    // hiccup can fail the whole batch) — fall back to one request per
    // index so a single bad symbol/blip doesn't blank out the whole strip.
    quotes = await Promise.all(INDEX_LIST.map((i) => fetchOne(i.symbol, i.label)));
  }

  cache = { fetchedAt: Date.now(), quotes };
  return quotes;
}
