import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../config.js";

const HOLDINGS_FILE = path.join(DATA_DIR, "holdings.json");

export async function readHoldings() {
  try {
    const raw = await fs.readFile(HOLDINGS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeHoldings(holdings) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(HOLDINGS_FILE, JSON.stringify(holdings, null, 2));
}

export async function addHolding({
  symbol,
  name,
  quantity,
  avgBuyPrice,
  stopLoss,
  purchaseDate,
  signalDate,
  strengthPct,
}) {
  const holdings = await readHoldings();
  const holding = {
    id: crypto.randomUUID(),
    symbol: symbol.toUpperCase().replace(/\.NS$/, ""),
    name: name || null,
    quantity: Number(quantity),
    avgBuyPrice:
      avgBuyPrice != null && avgBuyPrice !== "" ? Number(avgBuyPrice) : null,
    stopLoss: stopLoss != null && stopLoss !== "" ? Number(stopLoss) : null,
    // when you actually bought — used for P&L only
    purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
    // the ORIGINAL breakout week this stock entered our criteria, if known
    // (e.g. copied from the screener). Grace period and the trailing stop
    // ratchet anchor to this instead of purchaseDate when it's set, so a
    // signal you bought a few weeks late doesn't get extra, unvalidated
    // protection time. Falls back to purchaseDate if left blank.
    signalDate: signalDate || purchaseDate || new Date().toISOString().slice(0, 10),
    // entry strength at signal time (% above upper BB), if known — the same
    // ranking used to decide which holding is "weakest" when capital-sizing
    // suggests reallocating into a stronger new signal. Optional; a manually
    // entered holding with no known signal just won't show a strength.
    strengthPct: strengthPct != null && strengthPct !== "" ? Number(strengthPct) : null,
  };
  holdings.push(holding);
  await writeHoldings(holdings);
  return holding;
}

export async function removeHolding(id) {
  const holdings = await readHoldings();
  const filtered = holdings.filter((h) => h.id !== id);
  await writeHoldings(filtered);
  return filtered;
}
