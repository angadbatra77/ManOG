import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../config.js";

const CACHE_FILE = path.join(DATA_DIR, "screener-cache.json");

const state = {
  refreshing: false,
  progress: { done: 0, total: 0 },
  lastError: null,
};

export function getStatus() {
  return { ...state, progress: { ...state.progress } };
}

export function setRefreshing(refreshing) {
  state.refreshing = refreshing;
  if (refreshing) state.lastError = null;
}

export function setProgress(done, total) {
  state.progress = { done, total };
}

export function setError(message) {
  state.lastError = message;
}

export async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { results: [], updatedAt: null };
  }
}

export async function writeCache(results) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = { results, updatedAt: new Date().toISOString() };
  await fs.writeFile(CACHE_FILE, JSON.stringify(payload, null, 2));
  return payload;
}
