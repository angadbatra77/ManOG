import { supabase as client } from "./supabaseClient.js";
import { toISTDateString } from "./weeklyResample.js";

const TABLE = "daily_candles";

// Persistent, durable raw daily-candle history (survives Render redeploys,
// unlike the old local-disk-only cache). This is what lets a refresh fetch
// only "yesterday -> today" per symbol instead of re-downloading ~2 years of
// history every single time — see fetchWeeklyCandles in screener.js.

function toRow(symbol, candle) {
  return {
    symbol,
    date: toISTDateString(candle.date),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

function fromRow(row) {
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}

export function isDailyCandlesDbConfigured() {
  return client != null;
}

// The most recent trading date we've already stored for this symbol, or
// null if we've never fetched it before — a first-time symbol needs a full
// historical backfill, not an incremental top-up.
export async function getLatestStoredDate(symbol) {
  if (!client) return null;
  const { data, error } = await client
    .from(TABLE)
    .select("date")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;
  return data[0].date;
}

// Everything stored for this symbol from `sinceDate` (inclusive) onward,
// oldest first — the trailing window fed into the weekly resample.
export async function getStoredDailyCandles(symbol, sinceDate) {
  if (!client) return [];
  const { data, error } = await client
    .from(TABLE)
    .select("date, open, high, low, close, volume")
    .eq("symbol", symbol)
    .gte("date", sinceDate)
    .order("date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

// Safe to call repeatedly with overlapping ranges — upserting on
// (symbol, date) means re-fetching a day we already have just replaces it
// rather than creating a duplicate.
export async function upsertDailyCandles(symbol, candles) {
  if (!client || candles.length === 0) return;
  const rows = candles.map((c) => toRow(symbol, c));
  const { error } = await client.from(TABLE).upsert(rows, { onConflict: "symbol,date" });
  if (error) throw new Error(error.message);
}
