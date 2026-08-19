import { useEffect, useState } from "react";
import ResultsTable from "./ResultsTable.jsx";

export default function SellSignalsTab() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/sell-signals")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load sell signals");
        setResults(data.results ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="sell-signals">
      <p className="subtitle">
        Stocks that previously appeared as a buy signal, now showing MACD line
        below signal line on the weekly chart (bearish / exit condition).
      </p>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="empty-state">Scanning…</p>
      ) : (
        <ResultsTable results={results} variant="sell" />
      )}
    </div>
  );
}
