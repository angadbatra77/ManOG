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

const router = Router();

router.get("/results", async (_req, res) => {
  const cache = await readCache();
  res.json(cache);
});

router.get("/status", (_req, res) => {
  res.json(getStatus());
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
  } catch (err) {
    setError(err.message || "Refresh failed");
  } finally {
    setRefreshing(false);
  }
});

export default router;
