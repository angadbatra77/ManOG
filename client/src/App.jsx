import { useEffect, useRef, useState } from "react";
import ResultsTable from "./components/ResultsTable.jsx";
import HoldingsTab from "./components/HoldingsTab.jsx";
import "./App.css";

function ScreenerTab() {
  const [results, setResults] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [status, setStatus] = useState({ refreshing: false, progress: { done: 0, total: 0 } });
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  async function loadResults() {
    const res = await fetch("/api/results");
    const data = await res.json();
    setResults(data.results ?? []);
    setUpdatedAt(data.updatedAt ?? null);
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

      {error && <p className="error">{error}</p>}

      <ResultsTable results={results} updatedAt={updatedAt} />
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
      </nav>

      {tab === "screener" ? <ScreenerTab /> : <HoldingsTab />}
    </div>
  );
}
