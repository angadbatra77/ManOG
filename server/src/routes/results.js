import { Router } from "express";
import { runScreener } from "../services/screener.js";
import { getNseUniverse } from "../services/nseUniverse.js";
import {
  getStatus,
  setRefreshing,
  setProgress,
  setError,
} from "../services/cache.js";
import {
  saveDailySnapshot,
  getHistoryForDate,
  getAvailableDates,
} from "../services/historyDb.js";
import {
  saveLatestResults,
  getLatestResults,
} from "../services/latestResultsDb.js";
import { getStoredIndexQuotes } from "../services/indices.js";
import { getLivePrices, MAX_SYMBOLS } from "../services/livePrices.js";

const router = Router();

router.get("/results", async (_req, res) => {
  const cache = await getLatestResults();
  res.json(cache);
});

router.get("/nse-symbols", async (_req, res) => {
  const symbols = await getNseUniverse();
  res.json({
    symbols: symbols.map((s) => ({
      symbol: s.symbol.replace(/\.NS$/, ""),
      name: s.name,
    })),
  });
});

// The only endpoint that hits Yahoo on a page view. Kept separate from
// /results specifically so it can fail without taking the table with it:
// the browser renders the cached weekly results first and fills this in
// afterwards.
router.get("/live-prices", async (req, res) => {
  const raw = typeof req.query.symbols === "string" ? req.query.symbols.trim() : "";
  if (!raw) {
    return res.json({ prices: {}, asOf: null, marketState: null });
  }

  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SYMBOLS);

  try {
    res.json(await getLivePrices(symbols));
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch live prices" });
  }
});

router.get("/status", (_req, res) => {
  res.json(getStatus());
});

router.get("/indices", async (_req, res) => {
  try {
    const { quotes, updatedAt } = await getStoredIndexQuotes();
    res.json({ quotes, updatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch indices" });
  }
});

router.get("/history/dates", async (_req, res) => {
  const dates = await getAvailableDates();
  res.json({ dates });
});

router.get("/history", async (req, res) => {
  if (!req.query.date) {
    return res.status(400).json({ error: "date query param is required" });
  }
  const results = await getHistoryForDate(req.query.date);
  res.json({ results });
});

router.post("/refresh", async (req, res) => {
  const status = getStatus();
  if (status.refreshing) {
    return res.status(409).json({ error: "Refresh already in progress" });
  }

  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  setRefreshing(true);
  setProgress(0, 0);
  res.json({ started: true });

  try {
    const { results, stale, staleAsOf } = await runScreener({
      limit,
      onProgress: (done, total) => setProgress(done, total),
    });

    // A ?limit= run only ever checks a small slice of the universe, so
    // whatever it finds is never a real picture of "what's on the market
    // today" — saving it as the live homepage (or the day's history) would
    // silently replace a correct full-universe result with an incomplete
    // one. The real UI never sends ?limit=; this only ever exists for
    // local dev/test runs, so gating both writes behind it costs nothing
    // for actual usage and makes this class of bug impossible by
    // construction, rather than relying on remembering not to.
    if (!limit) {
      await saveLatestResults(results, { stale, staleAsOf });
      // Not a hard failure (we still have a usable candidate list from an
      // earlier successful fetch), so this doesn't go through setError —
      // the frontend reads the persisted stale/staleAsOf flag from
      // /api/results directly, which stays correct across reloads and for
      // anyone else who opens the app, unlike this in-memory status.
      await saveDailySnapshot(results).catch((err) =>
        console.error("Failed to save history snapshot:", err.message)
      );
    }
  } catch (err) {
    setError(err.message || "Refresh failed");
  } finally {
    setRefreshing(false);
  }
});

export default router;
