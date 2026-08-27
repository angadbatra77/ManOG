export const PORT = process.env.PORT || 4000;

// 1000 Cr = 1000 * 1,00,00,000 = 1,00,00,000,000
export const MARKET_CAP_THRESHOLD = 1_000_00_00_000;

export const RSI_PERIOD = 14;
export const RSI_BUY_LEVEL = 60;

// validated exit rule: suppress both the stop-loss and MACD sell signals
// for this many weeks after purchase, so a position isn't shaken out by
// ordinary early volatility before it's had room to work
export const GRACE_WEEKS = 12;

// The backtest only ever bought a stock on the FRESH week its RSI crossed
// above 60 — never one already sitting in criteria. Live, we bend that
// slightly as a bootstrapping accommodation: a signal up to this many weeks
// old is still shown if price hasn't drifted, since buying it now is close
// to economically equivalent to having caught it fresh. Once the screener
// is checked regularly this branch stops mattering — every future signal
// gets caught in its first week — so treat this as scaffolding, not a
// permanent strategy change.
export const MAX_SIGNAL_AGE_WEEKS = 4;
export const MAX_SIGNAL_PRICE_DRIFT_PCT = 5;

export const BB_PERIOD = 20;
export const BB_STDDEV = 2;

export const MACD_FAST_PERIOD = 12;
export const MACD_SLOW_PERIOD = 26;
export const MACD_SIGNAL_PERIOD = 9;

// how many weekly candles to pull per symbol (~2 years)
export const WEEKLY_LOOKBACK_WEEKS = 110;

// concurrent yahoo-finance2 history requests during a refresh
export const HISTORY_CONCURRENCY = 16;

// symbols per batched quote() call for market cap filtering
export const QUOTE_BATCH_SIZE = 200;

export const NSE_EQUITY_LIST_URL =
  "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";

export const DATA_DIR = new URL("./data/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Upstox broker integration (data feed + order placement). Register an app
// at https://account.upstox.com/developer/apps with the redirect URI below,
// then put the key/secret it gives you into server/.env — never here.
export const UPSTOX_API_KEY = process.env.UPSTOX_API_KEY;
export const UPSTOX_API_SECRET = process.env.UPSTOX_API_SECRET;
export const UPSTOX_REDIRECT_URI =
  process.env.UPSTOX_REDIRECT_URI || `http://localhost:${PORT}/api/upstox/callback`;
