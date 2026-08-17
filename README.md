# ManOG — NSE Momentum Screener

**Screener tab** — screens NSE-listed stocks (market cap > ₹1000 Cr) on the weekly chart for:
RSI crossing above 60, weekly close above the upper Bollinger Band, and MACD line above signal line.
Results include a stop loss at that week's low and link out to TradingView for charting.

**Holdings tab** — track stocks you own (symbol, quantity, optional avg buy price). Each holding is
evaluated live against the sell rule: MACD line crossing below the signal line on the weekly chart,
flagged as a SELL badge.

## Run it

Two servers, run in separate terminals:

```bash
cd server
npm install
npm run dev
```

```bash
cd client
npm install
npm run dev
```

Open the client dev server URL (shown in terminal, typically `http://localhost:5173`) and click **Refresh**.
The first refresh fetches the full NSE symbol list and screens every qualifying stock — this can take
several minutes. For quick testing, refresh a small subset first via `POST /api/refresh?limit=50`.
