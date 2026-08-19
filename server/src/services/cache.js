// In-memory refresh status only — the actual results now live in Supabase
// (see latestResultsDb.js) so they survive Render redeploys and are shared
// by anyone opening the app, instead of a local file that reset every deploy.
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
