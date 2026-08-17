import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, NSE_EQUITY_LIST_URL } from "../config.js";

const SYMBOLS_FILE = path.join(DATA_DIR, "nse-symbols.json");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseEquityCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.toUpperCase());
  const symbolIdx = header.indexOf("SYMBOL");
  const nameIdx = header.indexOf("NAME OF COMPANY");
  const seriesIdx = header.indexOf(" SERIES");

  const symbols = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const symbol = fields[symbolIdx];
    const series = seriesIdx >= 0 ? fields[seriesIdx] : "EQ";
    if (!symbol) continue;
    // Only keep the main "EQ" series to avoid duplicate/illiquid series listings
    if (series && series.trim() !== "EQ") continue;
    symbols.push({
      symbol: `${symbol}.NS`,
      name: nameIdx >= 0 ? fields[nameIdx] : symbol,
    });
  }
  return symbols;
}

async function fetchFromNse() {
  // NSE's site blocks requests without a prior session cookie from the homepage.
  const homepage = await fetch("https://www.nseindia.com", {
    headers: BROWSER_HEADERS,
  });
  const cookies = homepage.headers.getSetCookie
    ? homepage.headers.getSetCookie()
    : (homepage.headers.get("set-cookie") ? [homepage.headers.get("set-cookie")] : []);
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

  const res = await fetch(NSE_EQUITY_LIST_URL, {
    headers: {
      ...BROWSER_HEADERS,
      Cookie: cookieHeader,
      Referer: "https://www.nseindia.com/market-data/securities-available-for-trading",
    },
  });

  if (!res.ok) {
    throw new Error(`NSE equity list request failed: ${res.status}`);
  }
  const csvText = await res.text();
  const symbols = parseEquityCsv(csvText);
  if (symbols.length === 0) {
    throw new Error("Parsed 0 symbols from NSE equity list");
  }
  return symbols;
}

export async function getNseUniverse({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(await fs.readFile(SYMBOLS_FILE, "utf-8"));
      if (Array.isArray(cached.symbols) && cached.symbols.length > 0) {
        return cached.symbols;
      }
    } catch {
      // no cache yet, fall through to fetch
    }
  }

  const symbols = await fetchFromNse();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    SYMBOLS_FILE,
    JSON.stringify({ fetchedAt: new Date().toISOString(), symbols }, null, 2)
  );
  return symbols;
}
