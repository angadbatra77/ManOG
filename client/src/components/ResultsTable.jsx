function formatPct(value) {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function formatPrice(value) {
  if (value == null) return "—";
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

function changeClass(value) {
  if (value == null) return "";
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

function formatWeeks(value) {
  if (value == null) return "—";
  return value === 1 ? "1 wk" : `${value} wks`;
}

function formatMarketCap(value) {
  if (value == null) return "—";
  const cr = value / 1_00_00_000;
  return cr >= 1000
    ? `₹${(cr / 100).toFixed(1)}k Cr`
    : `₹${cr.toFixed(0)} Cr`;
}

function formatDate(value) {
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

export default function ResultsTable({ results, updatedAt, variant = "buy" }) {
  if (results.length === 0) {
    return (
      <p className="empty-state">
        {variant === "sell"
          ? "No stocks currently in sell mode."
          : updatedAt
          ? "No buy signals in the latest run."
          : "No scan has completed yet — click Refresh to run one (can take a couple of minutes for the full universe)."}
      </p>
    );
  }

  return (
    <table className="results-table">
      <thead>
        <tr>
          {variant === "buy" && <th title="Order of preference — strongest breakout first">#</th>}
          <th>Symbol</th>
          <th>Current Price</th>
          <th>Market Cap</th>
          {variant === "buy" && (
            <th title="How far the breakout week's close sat above the upper Bollinger Band — this is what the rank is based on">
              Entry Strength
            </th>
          )}
          <th>1W Change</th>
          <th>1M Change</th>
          <th>Signal Date</th>
          <th>Stop Loss</th>
          <th>{variant === "sell" ? "In Sell Mode" : "In Criteria"}</th>
          <th>Chart</th>
        </tr>
      </thead>
      <tbody>
        {results.map((row) => (
          <tr
            key={row.symbol}
            className="clickable-row"
            onClick={() => openTradingView(row.symbol)}
          >
            {variant === "buy" && <td className="rank-cell">{row.rank ?? "—"}</td>}
            <td className="symbol-cell">
              <span className="symbol">{row.symbol}</span>
              <span className="name">{row.name}</span>
            </td>
            <td>{formatPrice(row.price)}</td>
            <td>{formatMarketCap(row.marketCap)}</td>
            {variant === "buy" && (
              <td className={changeClass(row.strengthPct)}>{formatPct(row.strengthPct)}</td>
            )}
            <td className={changeClass(row.change1w)}>{formatPct(row.change1w)}</td>
            <td className={changeClass(row.change1m)}>{formatPct(row.change1m)}</td>
            <td>{formatDate(row.signalDate)}</td>
            <td>{formatPrice(row.stopLoss)}</td>
            <td
              title={
                variant === "buy" && row.graceWeeksIfBoughtNow != null
                  ? row.weeksInCriteria > 1
                    ? `Signal is ${row.weeksInCriteria - 1} week(s) old — if you buy now, only ${row.graceWeeksIfBoughtNow} week(s) of grace period remain (anchored to the original signal, not today)`
                    : "Fresh signal — full 12-week grace period if bought now"
                  : undefined
              }
            >
              {variant === "buy" && row.graceWeeksIfBoughtNow != null ? (
                <div className="criteria-cell">
                  <span>{formatWeeks(row.weeksInCriteria)}</span>
                  <span className="grace-hint">{row.graceWeeksIfBoughtNow}wk grace left</span>
                </div>
              ) : (
                formatWeeks(row.weeksInCriteria)
              )}
            </td>
            <td>
              <button
                className="chart-link"
                onClick={(e) => {
                  e.stopPropagation();
                  openTradingView(row.symbol);
                }}
              >
                View Chart ↗
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
