import { useEffect, useState } from "react";

function formatPrice(value) {
  if (value == null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function formatChange(value) {
  if (value == null) return "";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function changeClass(value) {
  if (value == null) return "";
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

// Polls a lightweight, server-cached endpoint (60s TTL server-side, see
// indices.js) rather than hitting Yahoo directly from the browser — keeps
// this "live" without every open tab hammering Yahoo independently.
export default function IndicesTicker() {
  const [quotes, setQuotes] = useState([]);

  async function load() {
    try {
      const res = await fetch("/api/indices");
      const data = await res.json();
      setQuotes(data.quotes ?? []);
    } catch {
      // silently ignore a failed poll — ticker just keeps showing whatever
      // it last had rather than flashing empty
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (quotes.length === 0) return null;

  return (
    <div className="indices-ticker">
      {quotes.map((q) => (
        <div key={q.symbol} className="index-pill" title={q.label}>
          <span className="index-label">{q.label}</span>
          <span className="index-price">{formatPrice(q.price)}</span>
          <span className={`index-change ${changeClass(q.changePercent)}`}>
            {formatChange(q.changePercent)}
          </span>
        </div>
      ))}
    </div>
  );
}
