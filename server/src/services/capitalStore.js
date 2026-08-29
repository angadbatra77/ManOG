import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const CAPITAL_FILE = path.join(DATA_DIR, "capital.json");

// There's no broker balance API wired up (Upstox is data-only, by choice) —
// this is a manually-maintained "how much cash do you actually have free to
// deploy right now" figure. It only feeds the position-sizing suggestion;
// nothing here places an order or moves money.
export async function getAvailableCash() {
  try {
    const raw = await fs.readFile(CAPITAL_FILE, "utf-8");
    const data = JSON.parse(raw);
    return data.availableCash ?? 0;
  } catch {
    return 0;
  }
}

export async function setAvailableCash(amount) {
  const availableCash = Number(amount);
  if (!Number.isFinite(availableCash) || availableCash < 0) {
    throw new Error("availableCash must be a non-negative number");
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CAPITAL_FILE, JSON.stringify({ availableCash, updatedAt: new Date().toISOString() }, null, 2));
  return availableCash;
}
