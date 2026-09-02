import { useEffect, useRef, useState } from "react";
import ResultsTable from "./components/ResultsTable.jsx";
import HoldingsTab from "./components/HoldingsTab.jsx";
import HistoryTab from "./components/HistoryTab.jsx";
import SellSignalsTab from "./components/SellSignalsTab.jsx";
import CapitalSettings from "./components/CapitalSettings.jsx";
import IndicesTicker from "./components/IndicesTicker.jsx";
import "./App.css";

function ScreenerTab() {
  const [results, setResults] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [stale, setStale] = useState(false);
  const [staleAsOf, setStaleAsOf] = useState(null);
  const [status, setStatus] = useState({ refreshing: false, progress: { done: 0, total: 0 } });
  const [error, setError] = useState(null);
  const [live, setLive] = useState(null);
  const pollRef = useRef(null);

  async function loadResults() {
    const res = await fetch("/api/results");
    const data = await res.json();
    const rows = data.results ?? [];
    setResults(rows);
    setUpdatedAt(data.updatedAt ?? null);
    setStale(data.stale ?? false);
    setStaleAsOf(data.staleAsOf ?? null);
    loadLivePrices(rows);
  }

  // Fired after the cached table is already on screen, and deliberately not
  // awaited by it — this is the only call in the app that hits Yahoo on a
  // page view, so it is never allowed to delay or break the render. If it
  // fails the Live column just shows placeholders.
  async function loadLivePrices(rows) {
    if (!rows.length) return;
    try {
      const symbols = rows.map((r) => r.symbol).join(",");
      const res = await fetch("/api/live-prices?symbols=" + encodeURIComponent(symbols));
      if (!res.ok) return;
      setLive(await res.json());
    } catch {
      // leave whatever was last fetched in place rather than blanking the
      // column on a single bad poll
    }
  }

  async function loadStatus() {
    const res = await fetch("/api/status");
    const data = await res.json();
    setStatus(data);
    return data;
  }

  useEffect(() => {
    loadResults();
    loadStatus().then((data) => {
      if (data.refreshing) startPolling();
    });
    return () => clearInterval(pollRef.current);
  }, []);

  // Everything else in the table is weekly data that cannot change between
  // refreshes; only this one number can, so it re-polls on its own instead
  // of dragging a full /results fetch along with it.
  useEffect(() => {
    if (results.length === 0) return undefined;
    const id = setInterval(() => loadLivePrices(results), 60000);
    return () => clearInterval(id);
  }, [results]);

  function startPolling() {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const data = await loadStatus();
      if (!data.refreshing) {
        clearInterval(pollRef.current);
        await loadResults();
        if (data.lastError) setError(data.lastError);
      }
    }, 2000);
  }

  async function handleRefresh() {
    setError(null);
    const res = await fetch("/api/refresh", { method: "POST" });
    if (res.status === 409) {
      startPolling();
      return;
    }
    startPolling();
  }

  return (
    <>
      <p className="subtitle">
        Weekly RSI(60) breakout + upper Bollinger Band close + bullish MACD, market cap &gt; ₹1000 Cr
      </p>

      <div className="toolbar">
        <CapitalSettings />

        <div className="controls">
          <button onClick={handleRefresh} disabled={status.refreshing}>
            {status.refreshing ? "Refreshing…" : "Refresh"}
          </button>
          {status.refreshing && status.progress.total > 0 && (
            <span className="progress">
              {status.progress.done} / {status.progress.total}
            </span>
          )}
          {updatedAt && (
            <span className="updated-at">
              Last updated: {new Date(updatedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {stale && (
        <p className="stale-banner">
          ⚠️ Data may not be fresh — market cap data last refreshed{" "}
          {staleAsOf ? new Date(staleAsOf).toLocaleString() : "at an earlier time"}. Today's
          Yahoo Finance fetch failed (likely a temporary block/rate-limit), so this run kept
          serving the last known-good candidate list instead of breaking. It will clear itself
          automatically once a refresh succeeds.
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <ResultsTable results={results} updatedAt={updatedAt} live={live} />
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState("screener");

  return (
    <div className="app">
      <header>
        <h1>NSE Momentum Screener</h1>
      </header>

      <IndicesTicker />

      {/* Upstox banner hidden — Yahoo is the primary data source for actual
          trading decisions (see the session notes on why). Upstox still
          works as a silent fallback-order source in screener.js; this just
          stops advertising the connect flow in the UI. */}

      <nav className="tabs">
        <button
          className={tab === "screener" ? "tab active" : "tab"}
          onClick={() => setTab("screener")}
        >
          Screener
        </button>
        <button
          className={tab === "holdings" ? "tab active" : "tab"}
          onClick={() => setTab("holdings")}
        >
          Holdings
        </button>
        <button
          className={tab === "history" ? "tab active" : "tab"}
          onClick={() => setTab("history")}
        >
          History
        </button>
        <button
          className={tab === "sell-signals" ? "tab active" : "tab"}
          onClick={() => setTab("sell-signals")}
        >
          Sell Signals
        </button>
      </nav>

      {tab === "screener" && <ScreenerTab />}
      {tab === "holdings" && <HoldingsTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "sell-signals" && <SellSignalsTab />}
    </div>
  );
}
