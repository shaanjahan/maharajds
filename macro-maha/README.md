# Macro Maha

A personal, Bloomberg-Terminal-inspired financial analysis desktop app for macOS.
Dark background, blue highlights, a command line, realtime Yahoo Finance data and
a full local analytics stack — statistical, time-series, Bayesian and ML — with
**no backend**. Everything runs inside the app on your Mac; the only network
traffic is the app talking directly to Yahoo Finance.

```
┌───────────────────────────────────────────────────────────────────────┐
│ MACROMAHA   > AAPL BAYES_                    ● LIVE STREAM   NY 09:41 │
├──────────┬──────────────────────────────────────────────┬────────────┤
│ MARKETS  │  AAPL · Apple Inc.   212.50  +1.52 (+0.72%)  │ DES  STAT  │
│ S&P 500  │  ┌────────────────────────────────────────┐  │ FC   BAYES │
│ NASDAQ   │  │        candlesticks + volume           │  │ REL  NEWS  │
│ VIX      │  │        overlays · forecast fans        │  │            │
│ US 10Y   │  │                                        │  │ P(drift>0) │
│ BTC      │  └────────────────────────────────────────┘  │   87.3%    │
│ WATCHLIST│  ┌──────────── RSI / MACD / z ────────────┐  │ 95% CI ... │
│ ...      │  └────────────────────────────────────────┘  │            │
├──────────┴──[F1 HELP][F2 DES][F3 CHART][F4 STAT]────────┴────────────┤
│ AAPL loaded — 251 bars (1Y).                                          │
└───────────────────────────────────────────────────────────────────────┘
```

## Quick start (MacBook)

Requires [Node.js](https://nodejs.org) 18+ (20+ recommended).

```bash
cd macro-maha
npm install
npm start
```

To build a standalone `Macro Maha.app` / `.dmg` you can keep in your dock:

```bash
npm run dist        # output lands in macro-maha/dist/
```

Run the analytics unit tests (30 tests, no network needed):

```bash
npm test
```

## How the data flows (no backend)

- **Realtime stream** — the app opens a websocket to
  `streamer.finance.yahoo.com` (the same feed Yahoo's own site uses) and
  decodes its protobuf `PricingData` frames in-app. Ticks flash the watchlist
  and update the live candle. Status shows `LIVE STREAM` when connected.
- **Polling fallback** — every 15 s the app also refreshes quotes over REST,
  so prices stay current even if the websocket drops (status: `POLLING 15s`).
- **History, fundamentals, news, search** — fetched on demand from Yahoo's
  chart/quote/quoteSummary/search endpoints in the Electron main process
  (which is CORS-free). Cookie/crumb auth for the fundamentals endpoints is
  handled automatically, with graceful degradation if Yahoo declines.
- **Economic data** — 20 macro indicators (unemployment, GDP & GDP growth,
  CPI/core CPI/core PCE inflation, payrolls, claims, participation, Fed funds,
  2Y/10Y yields and the curve, M2, industrial production, retail sales,
  consumer sentiment, housing starts, federal debt/GDP, labor productivity
  and Penn World Table TFP) pulled straight from FRED's keyless
  `fredgraph.csv` endpoint, cached 6 h, charted on click.
- **Everything else is local** — every statistic, forecast and posterior is
  computed inside the app in plain JavaScript. Watchlist persists locally.

## Command line (Bloomberg-style)

Press `⌘K` to focus the command line. Typing a partial company name searches
symbols. Commands:

| Command | What it does |
|---|---|
| `AAPL` / `AAPL GP 5Y` | Chart (ranges: 1D 5D 1M 6M YTD 1Y 5Y MAX) |
| `AAPL DES` | Company profile, valuation & fundamentals |
| `AAPL STAT` | Descriptive stats, VaR/CVaR, drawdown, OLS trend, ACF, technicals |
| `AAPL FC` | Forecast suite: Holt, AR(p) by AIC, Monte Carlo + ML signal |
| `AAPL BAYES` | Bayesian drift & trend, credible intervals, predictive fan |
| `AAPL REL MSFT NVDA` | Correlation matrix, β/α vs S&P, relative performance chart |
| `AAPL PAIR MSFT` | Pair spread, z-score pane, mean-reversion half-life |
| `AAPL RSI` / `AAPL MACD` | Indicator study pane under the chart |
| `AAPL NEWS` | Latest headlines (opens in your browser) |
| `WL ADD TSLA` / `WL DEL TSLA` | Manage the watchlist |
| `PORT` | Portfolio dashboard: P&L, VaR in $, risk contribution, Monte Carlo |
| `PORT ADD AAPL 10 150` | Add 10 shares @ $150 cost basis (omit cost to use live price) |
| `PORT DEL AAPL` / `PORT CLEAR` | Remove a position / clear the portfolio |
| `ECON` | Macro dashboard: GDP, jobs, inflation, rates, productivity, TFP |
| `ECON UNRATE` | Chart one indicator directly by its FRED id |
| `HELP` (or `F1`) | Command reference |

Function keys `F1–F8` mirror the buttons under the chart.

## The analytics stack

All implemented from scratch in `renderer/js/analytics.js` and
`renderer/js/bayes.js`, unit-tested in `test/analytics.test.js`:

- **Descriptive / risk** — annualized return & volatility, Sharpe, skew,
  excess kurtosis, max drawdown, historical + parametric VaR and CVaR at
  95/99%, autocorrelation function of returns.
- **Trend & technicals** — OLS trend on log price with t-stat/p-value,
  SMA/EMA/Bollinger overlays, RSI(14), MACD(12,26,9), golden/death cross.
- **Time-series forecasting** — Holt double exponential smoothing (grid-tuned
  α/β), AR(p) with order selection by AIC, both with 95% bands; seeded
  Monte Carlo GBM (2000 paths) with empirical percentile fans.
- **Bayesian analysis** — conjugate Normal-Inverse-Gamma posterior on daily
  returns (posterior drift with Student-t credible intervals, `P(drift > 0)`,
  posterior volatility, next-day predictive interval) and Bayesian linear
  trend regression whose 63-day predictive fan uses the exact Student-t
  predictive variance (widens with horizon and leverage).
- **ML signal** — L2-regularized logistic regression on lagged returns, RSI,
  MACD, moving-average gaps and volatility regime; chronological 80/20 split
  so the reported accuracy is out-of-sample; outputs `P(next day up)`.
- **Cross-asset** — correlation matrices on aligned daily log returns,
  β/α/R² vs `^GSPC`, relative performance charting, and pair analysis with
  OLS hedge ratio, spread z-score and Ornstein–Uhlenbeck half-life.
- **Portfolio** — live-valued positions panel (persisted locally) and a full
  risk dashboard: unrealized/day P&L, annualized return/vol/Sharpe/drawdown
  of your actual holdings, dollar VaR & CVaR, per-position risk contribution
  (`w_i · cov(r_i, r_p) / var(r_p)`), diversification ratio, effective number
  of positions, β/α vs the S&P, plus Bayesian drift and Monte Carlo outlook
  on the portfolio as a whole.

Numerical plumbing (inverse normal CDF, regularized incomplete beta,
Student-t CDF/quantiles, Gaussian elimination) is also hand-rolled and tested.

## Project layout

```
macro-maha/
├── main.js                 # Electron main: window + Yahoo HTTP client via IPC
├── preload.js              # contextBridge API (window.maha)
├── src/yahoo.js            # chart/quote/search/summary + cookie-crumb auth
├── renderer/
│   ├── index.html          # terminal layout
│   ├── css/terminal.css    # dark + blue theme
│   └── js/
│       ├── app.js          # command line, panels, realtime wiring
│       ├── chart.js        # lightweight-charts wrapper (fans, studies, REL)
│       ├── streamer.js     # websocket + protobuf PricingData decoder
│       ├── analytics.js    # stats / TA / forecasting / ML engine
│       └── bayes.js        # Bayesian inference + Monte Carlo
└── test/analytics.test.js  # 30 unit tests (npm test)
```

## Honest caveats

- Yahoo Finance's endpoints are unofficial. They're stable in practice and
  widely used, but Yahoo can change them; the app degrades gracefully
  (fundamentals fall back, streaming falls back to polling).
- "Realtime" is as real as Yahoo's feed: US equities are effectively live;
  some international exchanges are delayed by their rules.
- Forecasts and probabilities are statistical estimates from past prices.
  They are decision support for your own analysis — not investment advice.
