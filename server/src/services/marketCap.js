import fs from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import yahooFinance from "./yahooClient.js";
import { MARKET_CAP_THRESHOLD, QUOTE_BATCH_SIZE, DATA_DIR } from "../config.js";

const CANDIDATES_FILE = path.join(DATA_DIR, "marketcap-candidates.json");
// market caps don't move enough within a few hours to justify re-querying
// ~2500 symbols on every single refresh click
const CANDIDATES_TTL_MS = 6 * 60 * 60 * 1000;
const QUOTE_BATCH_CONCURRENCY = 5;

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function fetchQuotesForBatch(symbols) {
  try {
    const quotes = await yahooFinance.quote(symbols);
    return Array.isArray(quotes) ? quotes : [quotes];
  } catch {
    // A single bad symbol can fail the whole batch; retry one-by-one as a fallback.
    const limiter = pLimit(QUOTE_BATCH_CONCURRENCY);
    const results = await Promise.all(
      symbols.map((symbol) =>
        limiter(async () => {
          try {
            return await yahooFinance.quote(symbol);
          } catch {
            return null;
          }
        })
      )
    );
    return results.filter(Boolean);
  }
}

async function computeMarketCapCandidates(universe) {
  const batches = chunk(universe, QUOTE_BATCH_SIZE);
  const bySymbol = new Map(universe.map((u) => [u.symbol, u]));
  const limiter = pLimit(QUOTE_BATCH_CONCURRENCY);

  const batchResults = await Promise.all(
    batches.map((batch) =>
      limiter(() => fetchQuotesForBatch(batch.map((u) => u.symbol)))
    )
  );

  const passed = [];
  for (const quoteList of batchResults) {
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

async function readCandidatesFile() {
  try {
    return JSON.parse(await fs.readFile(CANDIDATES_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Given a list of {symbol, name} entries, returns only those whose market cap
 * exceeds MARKET_CAP_THRESHOLD, each annotated with current price + market cap.
 * Cached for CANDIDATES_TTL_MS since this step (batched quotes across the
 * whole NSE universe) is expensive and market caps barely move hour to hour.
 */
export async function filterByMarketCap(universe, { forceRefresh = false } = {}) {
  const cached = await readCandidatesFile();

  if (!forceRefresh && cached) {
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (Array.isArray(cached.candidates) && cached.candidates.length > 0 && age < CANDIDATES_TTL_MS) {
      return cached.candidates;
    }
  }

  const candidates = await computeMarketCapCandidates(universe);

  // NSE always has hundreds of companies above the market-cap threshold, so
  // 0 candidates back is never a real market condition — it means Yahoo's
  // quote endpoint failed outright (seen in practice: cloud-provider IPs
  // like Render's get blocked/rate-limited with no warning). Rather than
  // break the whole screener run, keep serving the last known-good
  // candidate list and mark it stale so the UI can warn instead of lying
  // about freshness.
  if (candidates.length === 0 && cached && Array.isArray(cached.candidates) && cached.candidates.length > 0) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(
      CANDIDATES_FILE,
      JSON.stringify({ ...cached, stale: true }, null, 2)
    );
    return cached.candidates;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    CANDIDATES_FILE,
    JSON.stringify(
      { fetchedAt: new Date().toISOString(), candidates, stale: false },
      null,
      2
    )
  );
  return candidates;
}

/**
 * Reports whether the market-cap candidate list currently being served is
 * stale (Yahoo failed on the most recent attempt, so we fell back to an
 * older successful fetch) and, if so, how old that data actually is.
 */
export async function getMarketCapFreshness() {
  const cached = await readCandidatesFile();
  if (!cached) return { stale: false, asOf: null };
  return { stale: !!cached.stale, asOf: cached.fetchedAt ?? null };
}
