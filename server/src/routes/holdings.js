import { Router } from "express";
import yahooFinance from "../services/yahooClient.js";
import {
  readHoldings,
  addHolding,
  removeHolding,
} from "../services/holdingsStore.js";
import { evaluateHoldings } from "../services/sellScreener.js";
import { getAvailableCash, setAvailableCash } from "../services/capitalStore.js";

const router = Router();

router.get("/holdings", async (_req, res) => {
  const holdings = await readHoldings();
  if (holdings.length === 0) return res.json({ holdings: [] });
  const evaluated = await evaluateHoldings(holdings);
  res.json({ holdings: evaluated });
});

router.post("/holdings", async (req, res) => {
  const { symbol, quantity, avgBuyPrice, stopLoss, purchaseDate, signalDate, strengthPct } = req.body;
  if (!symbol || !quantity) {
    return res.status(400).json({ error: "symbol and quantity are required" });
  }

  const ySymbol = symbol.toUpperCase().endsWith(".NS")
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;

  let name = null;
  try {
    const quote = await yahooFinance.quote(ySymbol);
    name = quote?.longName || quote?.shortName || null;
  } catch {
    // symbol may still be valid even if the name lookup fails transiently
  }

  const holding = await addHolding({
    symbol,
    name,
    quantity,
    avgBuyPrice,
    stopLoss,
    purchaseDate,
    signalDate,
    strengthPct,
  });
  res.json(holding);
});

router.delete("/holdings/:id", async (req, res) => {
  const holdings = await removeHolding(req.params.id);
  res.json({ holdings });
});

router.get("/capital", async (_req, res) => {
  res.json({ availableCash: await getAvailableCash() });
});

router.post("/capital", async (req, res) => {
  try {
    const availableCash = await setAvailableCash(req.body.availableCash);
    res.json({ availableCash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
