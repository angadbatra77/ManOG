import { Router } from "express";
import { scanSellSignals } from "../services/sellSignalsScreener.js";

const router = Router();

router.get("/sell-signals", async (_req, res) => {
  try {
    const results = await scanSellSignals();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message || "Sell signal scan failed" });
  }
});

export default router;
