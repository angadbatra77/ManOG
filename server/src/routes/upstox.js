import { Router } from "express";
import {
  isUpstoxConfigured,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  getUpstoxStatus,
} from "../services/upstoxAuth.js";

const router = Router();

// In dev, the client runs on its own Vite port (5174) separate from this
// server (4000) — Upstox can only redirect back to a URL registered on this
// server, so once the OAuth roundtrip finishes we bounce the browser over
// to the actual dev client instead of leaving it on the bare API server.
// In production the client is served from this same origin, so this is a
// no-op relative redirect unless CLIENT_URL is set.
const CLIENT_URL = process.env.CLIENT_URL || "";

router.get("/upstox/status", async (_req, res) => {
  res.json(await getUpstoxStatus());
});

router.get("/upstox/login", (_req, res) => {
  if (!isUpstoxConfigured()) {
    return res.status(400).json({
      error: "Upstox is not configured yet — add UPSTOX_API_KEY and UPSTOX_API_SECRET to server/.env",
    });
  }
  res.redirect(buildAuthorizationUrl());
});

// Upstox redirects here after the user logs in and approves the app.
router.get("/upstox/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.redirect(`${CLIENT_URL}/?upstox=error&reason=${encodeURIComponent(error_description || error)}`);
  }
  if (!code) {
    return res.redirect(`${CLIENT_URL}/?upstox=error&reason=missing_code`);
  }
  try {
    await exchangeCodeForToken(code);
    res.redirect(`${CLIENT_URL}/?upstox=connected`);
  } catch (err) {
    res.redirect(`${CLIENT_URL}/?upstox=error&reason=${encodeURIComponent(err.message)}`);
  }
});

export default router;
