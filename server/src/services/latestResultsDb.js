import { supabase as client } from "./supabaseClient.js";

// The current/live screener results, stored as a single row in Supabase
// instead of a local file — local disk resets on every Render redeploy,
// so anyone opening the app got an empty screen until the next manual
// refresh. Supabase persists across deploys and is shared by anyone who
// opens the link, without re-pulling from Yahoo.
export async function saveLatestResults(results) {
  if (!client) return;
  const { error } = await client
    .from("screener_latest")
    .upsert({ id: 1, results, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function getLatestResults() {
  if (!client) return { results: [], updatedAt: null };
  const { data, error } = await client
    .from("screener_latest")
    .select("results, updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { results: [], updatedAt: null };
  return { results: data.results ?? [], updatedAt: data.updated_at };
}
