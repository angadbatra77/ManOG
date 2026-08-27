import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { DATA_DIR } from "../config.js";

const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const CACHE_FILE = path.join(DATA_DIR, "upstox-instruments-cache.json");
// Upstox refreshes this file itself around 6 AM daily — no point re-fetching
// more often than that.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let symbolMap = null;
let loadedAt = 0;

async function fetchFresh() {
  const res = await fetch(INSTRUMENTS_URL);
  if (!res.ok) throw new Error(`Upstox instruments fetch failed: HTTP ${res.status}`);
  const gzipped = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(zlib.gunzipSync(gzipped).toString("utf-8"));

  // Plain equities only — the file also carries bonds, ETFs report under
  // their own instrument_type, ..., so filter to ordinary listed shares.
  const entries = json
    .filter((row) => row.segment === "NSE_EQ" && row.instrument_type === "EQ")
    .map((row) => [row.trading_symbol, row.instrument_key]);

  return Object.fromEntries(entries);
}

export async function getUpstoxSymbolMap() {
  const now = Date.now();
  if (symbolMap && now - loadedAt < CACHE_TTL_MS) return symbolMap;

  try {
    const map = await fetchFresh();
    symbolMap = map;
    loadedAt = now;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: now, map }));
    return map;
  } catch (err) {
    // fall back to whatever we last saved to disk, even if stale — better
    // than failing the whole screener because Upstox's asset CDN hiccuped
    try {
      const cached = JSON.parse(await fs.readFile(CACHE_FILE, "utf-8"));
      symbolMap = cached.map;
      loadedAt = cached.fetchedAt;
      return symbolMap;
    } catch {
      throw err;
    }
  }
}

export async function resolveInstrumentKey(symbol) {
  const map = await getUpstoxSymbolMap();
  return map[symbol.replace(/\.NS$/, "")] ?? null;
}
