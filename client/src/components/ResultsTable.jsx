import { Fragment, useState } from "react";

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

function formatDays(value) {
  if (value == null) return "—";
  return value === 1 ? "1 day" : `${value} days`;
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

// Recomputes "% chg since criteria" against a live quote instead of the
// last completed weekly close. Same formula, fresher numerator — this is
// what stops a first-week signal from reading a meaningless +0.00%.
// What each sortable column sorts ON. Kept next to the accessors rather
// than inline in the header so a column and its sort key can't drift
// apart — several of these sort on a different value than they display
// (the stacked cells show two numbers, the date cells show a formatted
// string), which is exactly where that drift would hide.
const SORT_KEYS = {
  rank: (row) => row.rank,
  symbol: (row) => row.symbol,
  price: (row) => row.price,
  marketCap: (row) => row.marketCap,
  strengthPct: (row) => row.strengthPct,
  change1w: (row) => row.change1w,
  changeSinceEntry: (row) => row.changeSinceEntry,
  liveChange: (row, live) => liveChangeSinceEntry(row, live?.prices?.[row.symbol] ?? null),
  signalDate: (row) => (row.signalDate ? new Date(row.signalDate).getTime() : null),
  criteriaSince: (row) =>
    row.daysInCriteria ?? (row.weeksInCriteria != null ? row.weeksInCriteria * 7 : null),
  suggestedAmount: (row) => row.suggestedAmount,
};

// Missing values always sink to the bottom, whichever way the column is
// pointing — a blank is never "the smallest", it's just absent, and
// flipping the arrow shouldn't march a block of dashes to the top.
function compareBy(key, dir, live) {
  const get = SORT_KEYS[key];
  return (a, b) => {
    const av = get(a, live);
    const bv = get(b, live);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return dir === "asc" ? cmp : -cmp;
  };
}

function liveChangeSinceEntry(row, livePrice) {
  if (livePrice == null || !row.priceAtSignal) return null;
  return ((livePrice - row.priceAtSignal) / row.priceAtSignal) * 100;
}

function liveHeaderTitle(live) {
  const base =
    "The same calculation as % Chg Since Criteria, but against a live quote instead of last week’s close — the weekly columns can’t show any movement at all for a signal that fired in the most recent completed week";
  if (!live?.asOf) return base;
  return `${base}. Prices as of ${new Date(live.asOf).toLocaleString()}`;
}

export default function ResultsTable({ results, updatedAt, variant = "buy", live = null }) {
  // Only the Screener tab passes live quotes. The History tab renders past
  // snapshots (a live price against an old entry would be a different
  // metric entirely) and the Sell tab has no entry price to measure from,
  // so both keep the table exactly as it was.
  const showLive = variant === "buy" && live != null;
  // Only a genuinely open market earns the live indicator. Yahoo reports
  // PRE / POST / POSTPOST / CLOSED outside trading hours, and a pulsing
  // "live" badge over yesterday's closing price would be the same quiet
  // lie this column exists to fix.
  const marketOpen = live?.marketState === "REGULAR";

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

  // null = each section keeps its own default order (FRESH by rank,
  // PREVIOUS chronological). Any explicit sort overrides both sections at
  // once, so the two lists stay comparable instead of being ordered by
  // different things.
  const [sort, setSort] = useState(null);

  function toggleSort(key) {
    setSort((current) => {
      if (current?.key !== key) {
        // Numbers are almost always most interesting largest-first
        // (biggest mover, strongest breakout); names and dates read
        // naturally the other way.
        const numeric = key !== "symbol";
        return { key, dir: numeric ? "desc" : "asc" };
      }
      if (current.dir === "desc") return { key, dir: "asc" };
      return null; // third click returns to the section defaults
    });
  }

  function applySort(rows) {
    if (!sort) return rows;
    return [...rows].sort(compareBy(sort.key, sort.dir, live));
  }

  // A sortable header. The empty trailing column and the chart button
  // aren't sortable, so they just use a plain <th>.
  function th(key, label, title) {
    const active = sort?.key === key;
    return (
      <th
        title={title}
        className={`sortable${active ? " sorted" : ""}`}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        onClick={() => toggleSort(key)}
      >
        {label}
        <span className="sort-arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </th>
    );
  }

  // Column total, so a section divider spans the whole table however many
  // optional columns this variant is showing.
  const columnCount = 7 + (variant === "buy" ? 4 : 0) + (showLive ? 1 : 0);

  // "Fresh" is weeksInCriteria === 1: the streak began in the most recent
  // COMPLETED week. Deliberately not a date subtraction — the old rule
  // counted calendar days from the breakout week’s Monday, which is always
  // 8+ days old by Tuesday, so the list emptied itself on any mid-week
  // refresh. A streak length has no such cliff: it gives the same answer
  // whichever day you look.
  const fresh = results.filter((r) => r.weeksInCriteria === 1);
  // Chronological: oldest breakout first. Sort is stable, so stocks that
  // entered in the same week keep the order the server ranked them in
  // rather than being reshuffled arbitrarily within the week.
  const previous = results
    .filter((r) => r.weeksInCriteria !== 1)
    .sort((a, b) => new Date(a.signalDate) - new Date(b.signalDate));

  // The screener no longer returns older signals at all — buying N weeks
  // late tested worse in both decades, badly enough that showing them was
  // an invitation to lose money (4 weeks late: 28.19% vs 45.72%). So the
  // PREVIOUS section is only rendered when rows actually exist, which now
  // means only for History snapshots taken before that change.
  const sections =
    variant === "buy"
      ? [
          {
            key: "fresh",
            label: "FRESH",
            note: "entered criteria at last Friday's close — the only thing the strategy buys",
            emptyText: "Nothing new entered criteria in the most recent completed week.",
            rows: applySort(fresh),
          },
          ...(previous.length
            ? [{
                key: "running",
                label: "PREVIOUS STOCKS",
                note: "older signals, kept from an earlier snapshot — buying these tested materially worse",
                emptyText: null,
                rows: applySort(previous),
              }]
            : []),
        ]
      : [{ key: "all", label: null, rows: applySort(results), emptyText: null }];

  // One row, shared by every section so the grouped view and the flat
  // view can never drift apart in columns or formatting.
  function renderRow(row) {
    return (
      <tr
        key={row.symbol}
        className="clickable-row"
        onClick={() => openTradingView(row.symbol)}
      >
        {variant === "buy" && <td className="rank-cell">{row.rank ?? "—"}</td>}
        <td>
          <div className="symbol-cell">
            <span className="symbol">{row.symbol}</span>
            <span className="name">{row.name}</span>
            {variant === "buy" && row.sector && (
              <span className="sector-tag">{row.sector}</span>
            )}
          </div>
        </td>
        <td>{formatPrice(row.price)}</td>
        <td>{formatMarketCap(row.marketCap)}</td>
        {variant === "buy" && (
          <td className={changeClass(row.strengthPct)}>{formatPct(row.strengthPct)}</td>
        )}
        <td>
          <div className="stacked-cell">
            <span className={changeClass(row.change1w)}>{formatPct(row.change1w)}</span>
            <span className={`stacked-sub ${changeClass(row.change1m)}`}>
              {formatPct(row.change1m)}
            </span>
          </div>
        </td>
        {variant === "buy" && (
          <td className={changeClass(row.changeSinceEntry)}>
            {formatPct(row.changeSinceEntry)}
          </td>
        )}
        {showLive &&
          (() => {
            const livePrice = live.prices?.[row.symbol] ?? null;
            const liveChange = liveChangeSinceEntry(row, livePrice);
            return (
              <td>
                <div className="stacked-cell">
                  <span className={changeClass(liveChange)}>{formatPct(liveChange)}</span>
                  <span className="stacked-sub">{formatPrice(livePrice)}</span>
                </div>
              </td>
            );
          })()}
        <td>
          <div className="stacked-cell">
            <span>{formatDate(row.signalDate)}</span>
            <span className="stacked-sub">{formatPrice(row.stopLoss)}</span>
          </div>
        </td>
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
            <div className="stacked-cell">
              <span>{formatDate(row.criteriaSinceDate ?? row.firstSeenDate ?? row.signalDate)}</span>
              <span className="stacked-sub">
                {formatDays(row.daysInCriteria)} · {row.graceWeeksIfBoughtNow}wk grace left
              </span>
            </div>
          ) : (
            formatWeeks(row.weeksInCriteria)
          )}
        </td>
        {variant === "buy" && (
          <td>
            <div className="stacked-cell">
              <span className={row.affordableNow ? "" : "negative"}>
                {row.suggestedShares ?? "—"} sh (₹{formatPrice(row.suggestedAmount)})
              </span>
              {!row.affordableNow && row.reallocationSuggestion && (
                <span className="reallocation-note">
                  Sell {row.reallocationSuggestion.symbol} instead (weaker,{" "}
                  {row.reallocationSuggestion.strengthPct?.toFixed(1)}%)
                </span>
              )}
              {!row.affordableNow && !row.reallocationSuggestion && (
                <span className="reallocation-note">Not enough cash</span>
              )}
            </div>
          </td>
        )}
        <td>
          <button
            className="chart-link"
            onClick={(e) => {
              e.stopPropagation();
              openTradingView(row.symbol);
            }}
          >
            Chart ↗
          </button>
        </td>
      </tr>
    );
  }


  return (
    <div className="table-scroll">
      <table className="results-table">
        <thead>
          <tr>
            {variant === "buy" &&
              th("rank", "#", "Sorted by entry strength — how far above the upper Bollinger Band the breakout closed. This is an ordering, NOT a prediction of which stock does better: across 20 years it correlates 0.037 with return, sits inside the random-seed range at every capital level, and ranked worse than picking at random over 2006-16. Click any header to re-sort; twice to flip, three times to return here.")}
            {th("symbol", "Symbol")}
            {th("price", "Price")}
            {th("marketCap", "Market Cap")}
            {variant === "buy" &&
              th(
                "strengthPct",
                "Entry Strength",
                "How far the breakout week's close sat above the upper Bollinger Band — this is what the rank is based on"
              )}
            {th("change1w", "Change (1W / 1M)", "1-week change over 1-month change — sorts on the 1-week figure")}
            {variant === "buy" &&
              th(
                "changeSinceEntry",
                "% Chg Since Criteria",
                "Price change since the stock first entered criteria — what your return would be if you’d bought that week"
              )}
            {showLive &&
              th(
                "liveChange",
                <>
                  Live % Chg
                  {marketOpen && <span className="live-dot" title="Market open" />}
                  {!marketOpen && <span className="live-header-note">at close</span>}
                </>,
                liveHeaderTitle(live)
              )}
            {th("signalDate", "Signal / Stop Loss", "Signal date, with stop loss below it — sorts on the signal date")}
            {th(
              "criteriaSince",
              variant === "sell" ? "In Sell Mode" : "In Criteria Since",
              variant === "buy"
                ? "The date it first entered criteria, with how many days ago and how much grace period remains below — sorts on how long it has been in criteria"
                : undefined
            )}
            {variant === "buy" &&
              th(
                "suggestedAmount",
                "Suggested Position",
                "min(10% of current equity, ₹20L) — a sizing suggestion only, never an order"
              )}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <Fragment key={section.key}>
              {section.label && (
                <tr className="section-row">
                  <td colSpan={columnCount}>
                    <span className={`section-tag ${section.key}`}>{section.label}</span>
                    <span className="section-note">{section.note}</span>
                  </td>
                </tr>
              )}
              {section.rows.length === 0 ? (
                <tr className="section-empty">
                  <td colSpan={columnCount}>{section.emptyText}</td>
                </tr>
              ) : (
                section.rows.map(renderRow)
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
