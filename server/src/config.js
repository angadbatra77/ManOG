export const PORT = process.env.PORT || 4000;

// 1000 Cr = 1000 * 1,00,00,000 = 1,00,00,000,000
export const MARKET_CAP_THRESHOLD = 1_000_00_00_000;

export const RSI_PERIOD = 14;
export const RSI_BUY_LEVEL = 60;

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
