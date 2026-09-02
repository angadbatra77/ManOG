// Finds the trailing-turnover percentile that best reproduces the stocks
// our Rs 1,000 Cr market-cap gate selects today.
//
// Why a substitute gate is needed at all: market cap is price x shares
// outstanding, and for a company that no longer exists there is no shares
// outstanding figure to look up — not in bhavcopy, not from Yahoo, not
// anywhere free. So the real market-cap gate can only ever be applied to
// survivors, which is precisely the bias we're removing. Turnover IS in
// bhavcopy for every stock that ever traded, so it can be applied
// consistently across the whole universe. A filter you can apply to
// everything beats a more "correct" one you can only apply to survivors.
//
// Expressed as a PERCENTILE of that day's traded universe rather than a
// rupee threshold, because a fixed rupee figure is meaningless across 20
// years of inflation and market growth — it would admit almost nothing in
// 2006 and almost everything today.
//
// Last run: top 60.5% of the traded universe matched the market-cap list
// with an F1 of 88.7%.
//
// Run with: node scripts/calibrate-liquidity-gate.js

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "../src/services/supabaseClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const PARSED = path.resolve(__dirname, arg("data", "."));
const LOOKBACK = 60;      // trading days
const ALIVE_CUTOFF = arg("alive", "2026-08-01");

if (!supabase) throw new Error("Supabase not configured — needs the market-cap candidate list to calibrate against");
const { data, error } = await supabase
  .from("marketcap_candidates_cache")
  .select("candidates")
  .eq("id", 1)
  .maybeSingle();
if (error) throw new Error(error.message);
if (!data) throw new Error("No cached market-cap candidates to calibrate against — run a screener refresh first");

const mcapSet = new Set(data.candidates.map((c) => c.symbol.replace(/\.NS$/, "")));
console.log(`market-cap gate selects ${mcapSet.size} symbols today\n`);

const man = JSON.parse(await fs.readFile(path.join(PARSED, "bhav-daily-240mo.json.manifest.json"), "utf-8"));
const median = (s) => { const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stats = [];

for (let i = 0; i < man.chunkCount; i++) {
  const chunk = JSON.parse(await fs.readFile(path.join(PARSED, `bhav-daily-240mo.json.part${i}.json`), "utf-8"));
  for (const [key, bars] of Object.entries(chunk)) {
    if (bars.length < LOOKBACK) continue;
    // Only currently-trading names, since that's what the market-cap
    // snapshot we're calibrating against covers.
    if (bars[bars.length - 1].date < ALIVE_CUTOFF) continue;
    const tail = bars.slice(-LOOKBACK).map((b) => b.value).filter((v) => v > 0).sort((a, b) => a - b);
    if (!tail.length) continue;
    stats.push({ sym: key.replace(/\.NS$/, ""), medTurnover: median(tail) });
  }
}

stats.sort((a, b) => b.medTurnover - a.medTurnover);
console.log(`currently-trading symbols with >=${LOOKBACK} bars: ${stats.length}\n`);
console.log("cut       n     turnover >=        overlap  recall  precision   F1");

let best = null;
for (const n of [600, 800, 1000, 1200, 1300, 1400, 1500, 1600, 1800, 2000, 2200]) {
  if (n > stats.length) continue;
  const pick = stats.slice(0, n);
  const hit = pick.filter((s) => mcapSet.has(s.sym)).length;
  const recall = hit / mcapSet.size;
  const precision = hit / n;
  const f1 = (2 * recall * precision) / (recall + precision);
  console.log(
    `top ${String(n).padStart(4)}  ${String(pick.length).padStart(4)}   ${(pick[pick.length - 1].medTurnover / 1e7).toFixed(2).padStart(7)} Cr/day   ${String(hit).padStart(5)}   ${(recall * 100).toFixed(1).padStart(5)}%    ${(precision * 100).toFixed(1).padStart(5)}%   ${(f1 * 100).toFixed(1)}%`
  );
  if (!best || f1 > best.f1) best = { n, f1, pct: n / stats.length };
}

console.log(`\nbest match: top ${best.n} = top ${(best.pct * 100).toFixed(1)}% of the traded universe (F1 ${(best.f1 * 100).toFixed(1)}%)`);
await fs.writeFile(
  path.join(PARSED, "gate-calibration.json"),
  JSON.stringify({ percentile: best.pct, matchedAgainst: mcapSet.size, f1: best.f1, calibratedAt: new Date().toISOString() }, null, 2)
);
console.log("written to gate-calibration.json — survivorship-free-backtest.js reads this");
