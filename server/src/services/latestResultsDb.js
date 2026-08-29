import { supabase as client } from "./supabaseClient.js";

// The current/live screener results, stored as a single row in Supabase
// instead of a local file — local disk resets on every Render redeploy,
// so anyone opening the app got an empty screen until the next manual
// refresh. Supabase persists across deploys and is shared by anyone who
// opens the link, without re-pulling from Yahoo.
export async function saveLatestResults(results, { stale = false, staleAsOf = null } = {}) {
  if (!client) return;
  const { error } = await client.from("screener_latest").upsert({
    id: 1,
    results,
    updated_at: new Date().toISOString(),
    stale,
    stale_as_of: staleAsOf,
  });
  if (error) throw new Error(error.message);
}

export async function getLatestResults() {
  if (!client) return { results: [], updatedAt: null, stale: false, staleAsOf: null };
  const { data, error } = await client
    .from("screener_latest")
    .select("results, updated_at, stale, stale_as_of")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { results: [], updatedAt: null, stale: false, staleAsOf: null };
  return {
    results: data.results ?? [],
    updatedAt: data.updated_at,
    stale: data.stale ?? false,
    staleAsOf: data.stale_as_of ?? null,
  };
}
