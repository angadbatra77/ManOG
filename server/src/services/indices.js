import yahooFinance from "./yahooClient.js";
import { supabase as client } from "./supabaseClient.js";

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

const TABLE = "index_quotes";

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

async function fetchFromYahoo() {
  try {
    // One batch call for all of them — cheap, same pattern as marketCap.js.
    const symbols = INDEX_LIST.map((i) => i.symbol);
    const results = await yahooFinance.quote(symbols);
    const arr = Array.isArray(results) ? results : [results];
    const bySymbol = new Map(arr.map((q) => [q.symbol, q]));
    return INDEX_LIST.map(({ symbol, label }) => {
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
    // index so a single bad symbol/blip doesn't blank out the whole set.
    return Promise.all(INDEX_LIST.map((i) => fetchOne(i.symbol, i.label)));
  }
}

// Called once per screener refresh (daily in practice) — fetches live
// quotes and persists them to Supabase. If Yahoo fails entirely (all
// prices null), the stored rows are deliberately left untouched rather
// than overwritten with nulls: a live index price is only meaningful as
// "as of the last successful refresh," never as a fabricated blank, so a
// failed fetch just means today's refresh didn't update it, same as any
// other Yahoo-dependent step in a refresh.
export async function fetchAndStoreIndexQuotes() {
  const quotes = await fetchFromYahoo();
  const hasAnyData = quotes.some((q) => q.price != null);
  if (!client || !hasAnyData) return;

  const rows = quotes
    .filter((q) => q.price != null)
    .map((q) => ({
      symbol: q.symbol,
      label: q.label,
      price: q.price,
      change_percent: q.changePercent,
      updated_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;

  const { error } = await client.from(TABLE).upsert(rows, { onConflict: "symbol" });
  if (error) throw new Error(error.message);
}

// What the app actually serves to the browser — always a DB read, never a
// live Yahoo call, so a page view never fails or blocks on Yahoo being
// down. Freshness is whatever the last successful refresh managed to
// store, same as every other number on the Screener.
export async function getStoredIndexQuotes() {
  if (!client) {
    return { quotes: INDEX_LIST.map((i) => ({ ...i, price: null, changePercent: null })), updatedAt: null };
  }

  const { data, error } = await client.from(TABLE).select("symbol, label, price, change_percent, updated_at");
  if (error) throw new Error(error.message);

  const bySymbol = new Map((data ?? []).map((r) => [r.symbol, r]));
  let updatedAt = null;
  const quotes = INDEX_LIST.map(({ symbol, label }) => {
    const row = bySymbol.get(symbol);
    if (row?.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
    return {
      symbol,
      label,
      price: row?.price ?? null,
      changePercent: row?.change_percent ?? null,
    };
  });

  return { quotes, updatedAt };
}
