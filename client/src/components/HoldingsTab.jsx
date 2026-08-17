import { useEffect, useState } from "react";

function formatPrice(value) {
  if (value == null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function pnlPercent(holding) {
  if (holding.avgBuyPrice == null || holding.price == null) return null;
  return ((holding.price - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;
}

function openTradingView(symbol) {
  window.open(
    `https://www.tradingview.com/chart/?symbol=NSE:${symbol}`,
    "_blank",
    "noopener,noreferrer"
  );
}

export default function HoldingsTab() {
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ symbol: "", quantity: "", avgBuyPrice: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function loadHoldings() {
    setLoading(true);
    const res = await fetch("/api/holdings");
    const data = await res.json();
    setHoldings(data.holdings ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadHoldings();
  }, []);

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.symbol.trim() || !form.quantity) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/holdings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: form.symbol.trim(),
          quantity: form.quantity,
          avgBuyPrice: form.avgBuyPrice,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add holding");
      }
      setForm({ symbol: "", quantity: "", avgBuyPrice: "" });
      await loadHoldings();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id) {
    await fetch(`/api/holdings/${id}`, { method: "DELETE" });
    await loadHoldings();
  }

  return (
    <div className="holdings">
      <form className="holding-form" onSubmit={handleAdd}>
        <input
          placeholder="Symbol (e.g. TCS)"
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value })}
        />
        <input
          type="number"
          placeholder="Quantity"
          value={form.quantity}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
        <input
          type="number"
          placeholder="Avg buy price (optional)"
          value={form.avgBuyPrice}
          onChange={(e) => setForm({ ...form, avgBuyPrice: e.target.value })}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? "Adding…" : "Add Holding"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="empty-state">Loading holdings…</p>
      ) : holdings.length === 0 ? (
        <p className="empty-state">No holdings yet — add one above.</p>
      ) : (
        <table className="results-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Qty</th>
              <th>Avg Buy</th>
              <th>Current Price</th>
              <th>P&L</th>
              <th>Signal</th>
              <th>Chart</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const pnl = pnlPercent(h);
              return (
                <tr key={h.id}>
                  <td className="symbol-cell">
                    <span className="symbol">{h.symbol}</span>
                    {h.name && <span className="name">{h.name}</span>}
                  </td>
                  <td>{h.quantity}</td>
                  <td>{h.avgBuyPrice != null ? formatPrice(h.avgBuyPrice) : "—"}</td>
                  <td>{h.error ? "—" : formatPrice(h.price)}</td>
                  <td className={pnl == null ? "" : pnl >= 0 ? "positive" : "negative"}>
                    {pnl == null ? "—" : `${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}%`}
                  </td>
                  <td>
                    {h.error ? (
                      <span className="badge badge-neutral">N/A</span>
                    ) : h.sellSignal ? (
                      <span className="badge badge-sell">SELL</span>
                    ) : (
                      <span className="badge badge-hold">HOLD</span>
                    )}
                  </td>
                  <td>
                    <button className="chart-link" onClick={() => openTradingView(h.symbol)}>
                      View Chart ↗
                    </button>
                  </td>
                  <td>
                    <button className="delete-link" onClick={() => handleDelete(h.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
