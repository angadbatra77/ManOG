import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

let client = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

function todayIST() {
  // date-wise history should follow Indian trading days, not the server's UTC date
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function toRow(scanDate, result) {
  return {
    scan_date: scanDate,
    symbol: result.symbol,
    name: result.name,
    price: result.price,
    market_cap: result.marketCap,
    change_1w: result.change1w,
    change_1m: result.change1m,
    stop_loss: result.stopLoss,
    signal_date: result.signalDate,
    weeks_in_criteria: result.weeksInCriteria,
  };
}

function fromRow(row) {
  return {
    symbol: row.symbol,
    name: row.name,
    price: row.price,
    marketCap: row.market_cap,
    change1w: row.change_1w,
    change1m: row.change_1m,
    stopLoss: row.stop_loss,
    signalDate: row.signal_date,
    weeksInCriteria: row.weeks_in_criteria,
  };
}

// Replaces today's snapshot with the latest refresh's matching stocks, so
// "date-wise" history holds one clean set of matches per day rather than
// accumulating duplicates from every click within the same day. Refuses to
// touch existing rows when results is empty — a zero-match run is far more
// likely a transient scan failure than a real "nothing matched today", and
// we'd rather keep stale-but-real data than silently wipe it.
export async function saveDailySnapshot(results) {
  if (!client || results.length === 0) return;

  const scanDate = todayIST();
  await client.from("screener_history").delete().eq("scan_date", scanDate);

  const rows = results.map((r) => toRow(scanDate, r));
  const { error } = await client.from("screener_history").insert(rows);
  if (error) throw new Error(error.message);
}

export async function getHistoryForDate(date) {
  if (!client) return [];
  const { data, error } = await client
    .from("screener_history")
    .select("*")
    .eq("scan_date", date)
    .order("change_1w", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

export async function getAvailableDates() {
  if (!client) return [];
  const { data, error } = await client
    .from("screener_history")
    .select("scan_date")
    .order("scan_date", { ascending: false });
  if (error) throw new Error(error.message);
  return [...new Set((data ?? []).map((r) => r.scan_date))];
}

// The set of stocks that have ever appeared as a buy signal, across all
// recorded dates — the universe the Sell Signals page tracks for an exit.
export async function getAllHistoricalSymbols() {
  if (!client) return [];
  const { data, error } = await client
    .from("screener_history")
    .select("symbol, name");
  if (error) throw new Error(error.message);

  const bySymbol = new Map();
  for (const row of data ?? []) {
    if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, row.name);
  }
  return [...bySymbol.entries()].map(([symbol, name]) => ({ symbol, name }));
}

export function isHistoryConfigured() {
  return client != null;
}
