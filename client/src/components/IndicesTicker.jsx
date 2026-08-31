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

// Reads whatever the last screener refresh stored in Supabase (see
// indices.js) — never calls Yahoo directly from the browser, so this can't
// fail or block on Yahoo being down. Freshness is tied to the same
// once-daily refresh cadence as the rest of the app, not a live tick;
// polled occasionally just to pick up a refresh that happened after load.
export default function IndicesTicker() {
  const [quotes, setQuotes] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);

  async function load() {
    try {
      const res = await fetch("/api/indices");
      const data = await res.json();
      setQuotes(data.quotes ?? []);
      setUpdatedAt(data.updatedAt ?? null);
    } catch {
      // silently ignore a failed poll — grid just keeps showing whatever
      // it last had rather than flashing empty
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 5 * 60_000);
    return () => clearInterval(interval);
  }, []);

  if (quotes.length === 0) return null;

  return (
    <div className="indices-section">
      <div className="indices-grid">
        {quotes.map((q) => (
          <div key={q.symbol} className="index-cell">
            <span className="index-label">{q.label}</span>
            <span className="index-price">{formatPrice(q.price)}</span>
            <span className={`index-change ${changeClass(q.changePercent)}`}>
              {formatChange(q.changePercent)}
            </span>
          </div>
        ))}
      </div>
      {updatedAt && (
        <p className="indices-updated-at">
          As of last refresh: {new Date(updatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
