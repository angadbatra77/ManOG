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

function openTradingView(symbol) {
  window.open(
    `https://www.tradingview.com/chart/?symbol=NSE:${symbol}`,
    "_blank",
    "noopener,noreferrer"
  );
}

export default function ResultsTable({ results }) {
  if (results.length === 0) {
    return <p className="empty-state">No buy signals in the latest run.</p>;
  }

  return (
    <table className="results-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Current Price</th>
          <th>1W Change</th>
          <th>1M Change</th>
          <th>In Criteria</th>
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
            <td className="symbol-cell">
              <span className="symbol">{row.symbol}</span>
              <span className="name">{row.name}</span>
            </td>
            <td>{formatPrice(row.price)}</td>
            <td className={changeClass(row.change1w)}>{formatPct(row.change1w)}</td>
            <td className={changeClass(row.change1m)}>{formatPct(row.change1m)}</td>
            <td>{formatWeeks(row.weeksInCriteria)}</td>
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
