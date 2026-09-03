// Fresh, clean simulation: starts with real starting capital, sizes each
// trade as (up to) a fixed max rupee amount buying whole shares (not just
// 1 share), and recycles cash chronologically as positions close. Uses the
// already-generated 2-way exit signal list (+5% target OR 28-day time
// exit) as the trade universe. Reports final equity, CAGR, and the trade
// number at which 80% of starting capital was first deployed.
//
// Run with: node scripts/position-sized-simulation.js

import fs from "node:fs/promises";

const MONTHS_BACK = 60;
const STARTING_CAPITAL = 1_000_000; // Rs 10,00,000
const MAX_PER_TRADE = 100_000; // Rs 1,00,000
const SOURCE_FILE = process.argv.find((a) => a.startsWith("--source="))
  ? process.argv.find((a) => a.startsWith("--source=")).split("=")[1]
  : `three-way-exit-results-${MONTHS_BACK}mo.json`;

async function main() {
  const data = JSON.parse(
    await fs.readFile(new URL(`./${SOURCE_FILE}`, import.meta.url), "utf-8")
  );
  const { trades, openPositions } = data;

  const allSignals = [
    ...trades.map((t) => ({ ...t, isOpen: false })),
    ...openPositions.map((p) => ({ ...p, sellDate: null, isOpen: true })),
  ].sort((a, b) => new Date(a.buyDate) - new Date(b.buyDate));

  console.log(`Total signals available: ${allSignals.length}`);
  console.log(`Starting capital: Rs ${STARTING_CAPITAL.toLocaleString("en-IN")}, max per trade: Rs ${MAX_PER_TRADE.toLocaleString("en-IN")}\n`);

  let cash = STARTING_CAPITAL;
  let taken = 0;
  let skipped = 0;
  const takenPositions = []; // {symbol, buyDate, buyPrice, shares, sellDate, sellPrice, isOpen}
  const pendingSells = [];
  let firstReached80 = null;

  for (const s of allSignals) {
    // Settle every position whose sell date has arrived — scanning them all,
    // not shifting a queue.
    //
    // Positions are pushed in BUY order, but they sell in whatever order the
    // exits happen to fire. The previous version only inspected
    // pendingSells[0] and stopped at the first one not yet due, so a
    // position bought earlier but selling later blocked everything behind
    // it: buy A in January selling in December, buy B in February selling
    // in September, and B's cash stayed locked until December. Capital sat
    // stranded, fewer trades were taken than the strategy would have taken,
    // and every figure this script produced was understated.
    const buyTime = new Date(s.buyDate).getTime();
    for (let i = pendingSells.length - 1; i >= 0; i--) {
      if (new Date(pendingSells[i].sellDate).getTime() <= buyTime) {
        const sell = pendingSells[i];
        cash += sell.shares * sell.sellPrice;
        pendingSells.splice(i, 1);
      }
    }

    const budget = Math.min(cash, MAX_PER_TRADE);
    const shares = Math.floor(budget / s.buyPrice);

    if (shares < 1) {
      skipped += 1;
      continue;
    }

    const cost = shares * s.buyPrice;
    cash -= cost;
    taken += 1;

    const position = { ...s, shares };
    takenPositions.push(position);
    if (!s.isOpen) pendingSells.push(position);

    const deployed = STARTING_CAPITAL - cash;
    if (firstReached80 == null && deployed >= STARTING_CAPITAL * 0.8) {
      firstReached80 = taken;
    }
  }

  // drain remaining sells — order no longer matters here, everything settles
  for (const sell of pendingSells) {
    cash += sell.shares * sell.sellPrice;
  }
  pendingSells.length = 0;

  const closedPositions = takenPositions.filter((p) => !p.isOpen);
  const openHeld = takenPositions.filter((p) => p.isOpen);

  const realizedPL = closedPositions.reduce((s, p) => s + p.shares * (p.sellPrice - p.buyPrice), 0);
  // open positions: value at buyPrice (conservative proxy; see caveat in output)
  const openValue = openHeld.reduce((s, p) => s + p.shares * p.buyPrice, 0);
  const finalEquity = cash + openValue;

  const totalReturnPct = ((finalEquity - STARTING_CAPITAL) / STARTING_CAPITAL) * 100;
  const years = MONTHS_BACK / 12;
  const cagrPct = (Math.pow(finalEquity / STARTING_CAPITAL, 1 / years) - 1) * 100;

  const summary = {
    totalSignals: allSignals.length,
    tradesTaken: taken,
    tradesSkipped: skipped,
    closedPositions: closedPositions.length,
    stillOpenPositions: openHeld.length,
    firstTradeNumberToReach80PctDeployed: firstReached80,
    finalCash: Math.round(cash * 100) / 100,
    finalEquity: Math.round(finalEquity * 100) / 100,
    realizedPL: Math.round(realizedPL * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    cagrPct: Math.round(cagrPct * 100) / 100,
  };

  console.log(JSON.stringify(summary, null, 2));

  await fs.writeFile(
    new URL("./position-sized-simulation-result.json", import.meta.url),
    JSON.stringify({ summary, takenPositions }, null, 2)
  );
  console.log("\nFull detail written to scripts/position-sized-simulation-result.json");
}

main().catch((err) => {
  console.error("Analysis failed:", err);
  process.exit(1);
});
