import { getAccessToken } from "./upstoxAuth.js";
import { resolveInstrumentKey } from "./upstoxInstruments.js";

const HISTORICAL_CANDLE_URL = "https://api.upstox.com/v2/historical-candle";

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns weekly candles in the same shape screener.js already uses
 * ({date, open, high, low, close, volume}, oldest first), or null if
 * Upstox isn't usable right now (not connected, symbol not found, or the
 * request failed) — callers are expected to fall back to Yahoo in that case.
 */
export async function fetchWeeklyCandlesUpstox(symbol, lookbackWeeks) {
  const token = await getAccessToken();
  if (!token) return null;

  const instrumentKey = await resolveInstrumentKey(symbol);
  if (!instrumentKey) return null;

  const toDate = isoDate(new Date());
  const fromDate = isoDate(new Date(Date.now() - lookbackWeeks * 7 * 24 * 60 * 60 * 1000));
  const url = `${HISTORICAL_CANDLE_URL}/${encodeURIComponent(instrumentKey)}/week/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return null;

  const data = await res.json();
  const candles = data?.data?.candles;
  if (!Array.isArray(candles)) return null;

  // Upstox returns newest-first; screener.js expects oldest-first, and
  // candle rows are [timestamp, open, high, low, close, volume, oi]
  return candles
    .map(([timestamp, open, high, low, close, volume]) => ({
      date: timestamp,
      open,
      high,
      low,
      close,
      volume,
    }))
    .reverse();
}
