import { Router } from "express";
import yahooFinance from "../services/yahooClient.js";
import {
  readHoldings,
  addHolding,
  removeHolding,
} from "../services/holdingsStore.js";
import { evaluateHoldings } from "../services/sellScreener.js";

const router = Router();

router.get("/holdings", async (_req, res) => {
  const holdings = await readHoldings();
  if (holdings.length === 0) return res.json({ holdings: [] });
  const evaluated = await evaluateHoldings(holdings);
  res.json({ holdings: evaluated });
});

router.post("/holdings", async (req, res) => {
  const { symbol, quantity, avgBuyPrice } = req.body;
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

  const holding = await addHolding({ symbol, name, quantity, avgBuyPrice });
  res.json(holding);
});

router.delete("/holdings/:id", async (req, res) => {
  const holdings = await removeHolding(req.params.id);
  res.json({ holdings });
});

export default router;
