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
    // used as the starting point for the trailing stop loss calculation;
    // defaults to today if not given
    purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
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
