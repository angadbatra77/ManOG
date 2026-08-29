import { readHoldings } from "./holdingsStore.js";
import { getAvailableCash } from "./capitalStore.js";
import { fetchWeeklyCandles } from "./screener.js";

/**
 * Current equity = your manually-tracked available cash + the live market
 * value of everything you hold. There's no broker balance API wired up
 * (Upstox is data-only), so availableCash is only as accurate as you keep
 * it updated — this is a sizing aid, not a real-time account balance.
 */
export async function computeCurrentEquity() {
  const [availableCash, holdings] = await Promise.all([getAvailableCash(), readHoldings()]);

  let heldValue = 0;
  const pricedHoldings = [];
  for (const holding of holdings) {
    let currentPrice = null;
    try {
      const candles = await fetchWeeklyCandles(`${holding.symbol}.NS`);
      currentPrice = candles.length ? candles[candles.length - 1].close : null;
    } catch {
      // if a symbol's price can't be fetched, fall back to the buy price
      // rather than silently understating equity by dropping it entirely
      currentPrice = holding.avgBuyPrice ?? null;
    }
    const marketValue = currentPrice != null ? holding.quantity * currentPrice : 0;
    heldValue += marketValue;
    pricedHoldings.push({ ...holding, currentPrice, marketValue });
  }

  return {
    availableCash,
    heldValue: Math.round(heldValue),
    totalEquity: Math.round(availableCash + heldValue),
    holdings: pricedHoldings,
  };
}

// The weakest currently-held position by entry strength — the one the
// validated strategy's priority-reallocation logic would sell first to fund
// a stronger new signal, when cash alone isn't enough. Holdings with no
// recorded strength (e.g. added manually with no screener signal behind
// them) are treated as infinitely weak, so a real signal-backed holding is
// never suggested for reallocation ahead of an unknown one.
export function findWeakestHolding(pricedHoldings) {
  if (pricedHoldings.length === 0) return null;
  let weakest = null;
  let weakestStrength = Infinity;
  for (const h of pricedHoldings) {
    const strength = h.strengthPct ?? -Infinity; // no known strength -> reallocate this one first, not last
    if (strength < weakestStrength) {
      weakestStrength = strength;
      weakest = h;
    }
  }
  return weakest;
}
