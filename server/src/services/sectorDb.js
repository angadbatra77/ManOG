import { supabase as client } from "./supabaseClient.js";
import yahooFinance from "./yahooClient.js";

const TABLE = "stock_sectors";

// A stock's sector/industry essentially never changes, so this is cached in
// Supabase indefinitely rather than re-fetched on every refresh — and only
// ever looked up for the small set of stocks that actually end up as
// signals (a handful a day), never the whole ~1,200-stock candidate
// universe, since Yahoo's quoteSummary is a separate per-symbol call from
// the price/quote data already being fetched.
async function getStoredSector(symbol) {
  if (!client) return null;
  const { data, error } = await client
    .from(TABLE)
    .select("sector, industry")
    .eq("symbol", symbol)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function fetchAndStoreSector(symbol) {
  const result = await yahooFinance.quoteSummary(`${symbol}.NS`, { modules: ["assetProfile"] });
  const sector = result?.assetProfile?.sector ?? null;
  const industry = result?.assetProfile?.industry ?? null;

  if (client && (sector || industry)) {
    const { error } = await client
      .from(TABLE)
      .upsert({ symbol, sector, industry, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  }

  return { sector, industry };
}

// Returns just the sector name (or null), never throws — a sector lookup
// failing shouldn't break the screener run.
export async function getOrFetchSector(symbol) {
  try {
    const stored = await getStoredSector(symbol);
    if (stored) return stored.sector;
  } catch {
    // Supabase read failing — fall through to a live fetch below
  }

  try {
    const { sector } = await fetchAndStoreSector(symbol);
    return sector;
  } catch {
    return null;
  }
}
