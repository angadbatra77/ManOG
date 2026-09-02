// Downloads NSE bhavcopy — the daily full-market snapshot listing every
// symbol that traded that day — for the whole backtest window.
//
// This exists because it is the ONLY source that contains companies which
// were later delisted. We checked the alternative directly: Yahoo has price
// history for 1 of 222 distress-delisted NSE stocks (see
// nse-distress-yahoo-check.json), and per-symbol APIs like NSEDownload
// can't return a symbol that no longer exists at all. Without bhavcopy any
// backtest here is silently restricted to companies that survived, which
// hides ~19% of the signals the strategy would actually have taken.
//
// Two archive formats, both verified working: the old per-day zip covers
// Sept 2006 through 28-Jun-2024, then it 404s and the UDiFF feed takes over
// (they overlap, so the cutover date isn't fragile).
//
// Resumable — already-downloaded files and known non-trading days are
// skipped, so re-running after an interruption costs nothing. About 12
// minutes and ~350 MB for the full 20 years.
//
// Run with: node scripts/fetch-bhavcopy.js [--out=./bhav-raw] [--from=2006-09-01]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const OUT = path.resolve(__dirname, arg("out", "./bhav-raw"));
const START = new Date(`${arg("from", "2006-09-01")}T00:00:00Z`);
const END = new Date();
const CONCURRENCY = 4;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const CUTOVER = Date.UTC(2024, 5, 28);

function urlFor(d) {
  const y = d.getUTCFullYear();
  const mo = MONTHS[d.getUTCMonth()];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const ymd = `${y}${String(d.getUTCMonth() + 1).padStart(2, "0")}${dd}`;
  return d.getTime() <= CUTOVER
    ? {
        name: `cm${dd}${mo}${y}bhav.csv.zip`,
        url: `https://nsearchives.nseindia.com/content/historical/EQUITIES/${y}/${mo}/cm${dd}${mo}${y}bhav.csv.zip`,
        year: y,
      }
    : {
        name: `BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`,
        url: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${ymd}_F_0000.csv.zip`,
        year: y,
      };
}

const days = [];
for (let t = new Date(START); t <= END; t.setUTCDate(t.getUTCDate() + 1)) {
  const dow = t.getUTCDay();
  if (dow === 0 || dow === 6) continue; // NSE trades Mon-Fri
  days.push(new Date(t));
}

// Holidays are recorded so a second run doesn't re-request ~284 days that
// will never exist.
const holidaysPath = path.join(OUT, "_holidays.json");
let holidays = new Set();
try {
  holidays = new Set(JSON.parse(await fs.readFile(holidaysPath, "utf-8")));
} catch {
  // first run
}

let done = 0, fetched = 0, cached = 0, nonTrading = 0, failed = 0;
const t0 = Date.now();

async function grab(d) {
  const { name, url, year } = urlFor(d);
  const dest = path.join(OUT, String(year), name);
  if (holidays.has(name)) { cached++; return; }
  try {
    const st = await fs.stat(dest);
    if (st.size > 500) { cached++; return; }
  } catch {
    // not downloaded yet
  }
  await fs.mkdir(path.join(OUT, String(year)), { recursive: true });

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Referer: "https://www.nseindia.com/all-reports", Accept: "*/*" },
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 404) { holidays.add(name); nonTrading++; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // A "success" that's too small to be a zip is NSE serving an error
      // page, not a thin trading day.
      if (buf.length < 500) { holidays.add(name); nonTrading++; return; }
      await fs.writeFile(dest, buf);
      fetched++;
      return;
    } catch {
      if (attempt === 4) { failed++; return; }
      await new Promise((r) => setTimeout(r, 1500 * attempt * attempt));
    }
  }
}

console.log(`Fetching ${days.length} weekdays into ${OUT}`);
const queue = [...days];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      await grab(queue.shift());
      done++;
      if (done % 250 === 0) {
        console.log(
          `  ${done}/${days.length}  fetched=${fetched} cached=${cached} non-trading=${nonTrading} failed=${failed}  ${((Date.now() - t0) / 60000).toFixed(1)}m`
        );
        await fs.writeFile(holidaysPath, JSON.stringify([...holidays]));
      }
    }
  })
);

await fs.writeFile(holidaysPath, JSON.stringify([...holidays]));
console.log(
  `\nDONE ${done} weekdays | fetched ${fetched} | already had ${cached} | non-trading ${nonTrading} | failed ${failed} | ${((Date.now() - t0) / 60000).toFixed(1)} min`
);
if (failed > 0) {
  console.log("Some days failed — just re-run, it resumes from what's on disk.");
}
