import { useEffect, useState } from "react";

function formatPrice(value) {
  if (value == null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function pnlPercent(holding) {
  if (holding.avgBuyPrice == null || holding.price == null) return null;
  return ((holding.price - holding.avgBuyPrice) / holding.avgBuyPrice) * 100;
}

function sellReasonLabel(reason) {
  if (reason === "stop_loss") return "STOP LOSS HIT";
  if (reason === "macd") return "MOMENTUM FADING";
  return null;
}

function watchReasonLabel(reason) {
  if (reason === "stop_loss") return "would hit stop loss";
  if (reason === "macd") return "MACD already bearish";
  return null;
}

function formatGraceDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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
  const [nseSymbols, setNseSymbols] = useState([]);
  const [form, setForm] = useState({
    symbol: "",
    quantity: "",
    avgBuyPrice: "",
    stopLoss: "",
    purchaseDate: "",
    signalDate: "",
  });
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
    fetch("/api/nse-symbols")
      .then((res) => res.json())
      .then((data) => setNseSymbols(data.symbols ?? []));
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
          stopLoss: form.stopLoss,
          purchaseDate: form.purchaseDate,
          signalDate: form.signalDate,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add holding");
      }
      setForm({
        symbol: "",
        quantity: "",
        avgBuyPrice: "",
        stopLoss: "",
        purchaseDate: "",
        signalDate: "",
      });
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
          list="nse-symbols-list"
          placeholder="Company or symbol (e.g. TCS)"
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value })}
        />
        <datalist id="nse-symbols-list">
          {nseSymbols.map((s) => (
            <option key={s.symbol} value={s.symbol}>
              {s.symbol} — {s.name}
            </option>
          ))}
        </datalist>
        <input
          type="number"
          placeholder="Quantity"
          value={form.quantity}
          onChange={(e) => setForm({ ...form, quantity: e.target.value })}
        />
        <input
          type="number"
          placeholder="Purchase price (optional)"
          value={form.avgBuyPrice}
          onChange={(e) => setForm({ ...form, avgBuyPrice: e.target.value })}
        />
        <input
          type="number"
          placeholder="Stop loss (optional)"
          value={form.stopLoss}
          onChange={(e) => setForm({ ...form, stopLoss: e.target.value })}
        />
        <input
          type="date"
          title="Purchase date (defaults to today) — used for P&L only"
          value={form.purchaseDate}
          onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })}
        />
        <input
          type="date"
          title="Original signal date from the screener — if this stock had already been in criteria a few weeks when you bought, put that breakout date here so the grace period isn't extended past what's validated. Leave blank if you caught it fresh."
          placeholder="Signal date"
          value={form.signalDate}
          onChange={(e) => setForm({ ...form, signalDate: e.target.value })}
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
              <th>Stop Loss</th>
              <th>Trailing SL</th>
              <th title="The order to place at your broker. The app cannot enforce a stop itself — this is the number to put in the GTT, and the date it needs to be live.">
                GTT to place
              </th>
              <th>Current Price</th>
              <th>P&L</th>
              <th>Grace Period</th>
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
                  <td>
                    <div className="symbol-cell">
                      <span className="symbol">{h.symbol}</span>
                      {h.name && <span className="name">{h.name}</span>}
                    </div>
                  </td>
                  <td>{h.quantity}</td>
                  <td>{h.avgBuyPrice != null ? formatPrice(h.avgBuyPrice) : "—"}</td>
                  <td>
                    {h.stopLoss != null ? formatPrice(h.stopLoss) : "—"}
                    {h.stopLossWarning && (
                      <span
                        className="warning-icon"
                        title={`This looks off from what we last recorded for this stock: ₹${h.stopLossWarning.historicalStopLoss} on ${h.stopLossWarning.scanDate}. Double check for a typo.`}
                      >
                        {" "}
                        ⚠️
                      </span>
                    )}
                  </td>
                  <td className={h.trailingStopLoss > h.stopLoss ? "positive" : ""}>
                    {h.trailingStopLoss != null ? formatPrice(h.trailingStopLoss) : "—"}
                  </td>
                  <td>
                    {h.gttTrigger == null ? (
                      "—"
                    ) : (
                      <div className="stacked-cell">
                        <span className="gtt-price">{formatPrice(h.gttTrigger)}</span>
                        {h.gttLive ? (
                          h.dailyBreach ? (
                            <span
                              className="gtt-note negative"
                              title={`A daily low of ${formatPrice(h.dailyBreach.low)} went through this stop on ${h.dailyBreach.date}. If a GTT was resting at the broker it has already sold. If not, this position should be out.`}
                            >
                              breached {h.dailyBreach.date}
                            </span>
                          ) : (
                            <span className="gtt-note">
                              {h.stopRatchetedAbove ? "live · update it" : "live"}
                            </span>
                          )
                        ) : (
                          <span className="gtt-note" title="No stop can fire during the grace period. Place the order so it is live before this date.">
                            place by {formatGraceDate(h.gttDueDate)}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td>{h.error ? "—" : formatPrice(h.price)}</td>
                  <td className={pnl == null ? "" : pnl >= 0 ? "positive" : "negative"}>
                    {pnl == null ? "—" : `${pnl > 0 ? "+" : ""}${pnl.toFixed(2)}%`}
                  </td>
                  <td>
                    {h.inGracePeriod ? (
                      <span
                        className="badge badge-neutral"
                        title={`No sell signal can trigger until ${formatGraceDate(h.graceEndsDate)}. The trailing stop keeps ratcheting up underneath in the meantime.`}
                      >
                        🔒 {h.weeksRemainingInGrace} {h.weeksRemainingInGrace === 1 ? "wk" : "wks"} left
                      </span>
                    ) : (
                      <span className="badge badge-hold" title="Grace period has ended — the stop loss and MACD checks are both live.">
                        Active since {formatGraceDate(h.graceEndsDate)}
                      </span>
                    )}
                  </td>
                  <td>
                    {h.error ? (
                      <span className="badge badge-neutral">N/A</span>
                    ) : h.sellSignal ? (
                      <span className="badge badge-sell">{sellReasonLabel(h.sellReason)}</span>
                    ) : h.wouldSellReason ? (
                      <span
                        className="badge badge-watch"
                        title="Suppressed by the grace period — will become a real signal only if still true once grace ends."
                      >
                        👀 Watch: {watchReasonLabel(h.wouldSellReason)}
                      </span>
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
