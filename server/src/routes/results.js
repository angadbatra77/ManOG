import { Router } from "express";
import { runScreener } from "../services/screener.js";
import {
  readCache,
  writeCache,
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

const router = Router();

router.get("/results", async (_req, res) => {
  const cache = await readCache();
  res.json(cache);
});

router.get("/status", (_req, res) => {
  res.json(getStatus());
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
    const results = await runScreener({
      limit,
      onProgress: (done, total) => setProgress(done, total),
    });
    await writeCache(results);
    // only record real, full-universe runs into date-wise history — not
    // partial test/dev runs triggered with a ?limit=
    if (!limit) {
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
