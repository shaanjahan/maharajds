// Macro Maha — terminal application logic.
// Command line, watchlist, realtime feed, chart control and analytics panels.
(function () {
  'use strict';

  const A = window.Analytics;
  const B = window.Bayes;
  const CC = window.MahaChart.COLORS;

  // ---- configuration --------------------------------------------------------

  const RANGES = {
    '1D': { range: '1d', interval: '2m', sec: 120 },
    '5D': { range: '5d', interval: '15m', sec: 900 },
    '1M': { range: '1mo', interval: '60m', sec: 3600 },
    '6M': { range: '6mo', interval: '1d', sec: 86400 },
    YTD: { range: 'ytd', interval: '1d', sec: 86400 },
    '1Y': { range: '1y', interval: '1d', sec: 86400 },
    '5Y': { range: '5y', interval: '1wk', sec: 604800 },
    MAX: { range: 'max', interval: '1mo', sec: 2592000 }
  };

  const MARKET_SYMBOLS = [
    ['^GSPC', 'S&P 500'],
    ['^IXIC', 'NASDAQ'],
    ['^DJI', 'DOW'],
    ['^VIX', 'VIX'],
    ['^TNX', 'US 10Y'],
    ['BTC-USD', 'BITCOIN'],
    ['EURUSD=X', 'EUR/USD'],
    ['CL=F', 'WTI CRUDE'],
    ['GC=F', 'GOLD']
  ];

  const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'SPY', 'QQQ', 'BTC-USD'];
  const PERF_COLORS = ['#3b9eff', '#ffd166', '#1fd08a', '#ff5d6c', '#b58cff', '#4dd0e1', '#f4a261'];
  const BENCH = '^GSPC';
  const POLL_MS = 15000;
  const DAILY_TTL = 10 * 60 * 1000;

  // ---- state ----------------------------------------------------------------

  const state = {
    symbol: null,
    rangeKey: '1Y',
    chartBars: [],
    watchlist: loadWatchlist(),
    portfolio: loadPortfolio(), // [{sym, qty, cost}]
    quotes: new Map(), // symbol -> latest quote-ish object
    daily: new Map(), // symbol -> {at, t, c, bars}
    activeTab: 'STAT',
    relPeers: [],
    overlaysOn: {},
    studyOn: null,
    names: new Map()
  };

  // ---- DOM ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const el = {
    cmd: $('cmd'),
    suggest: $('cmd-suggest'),
    conn: $('conn'),
    connLabel: $('conn-label'),
    clockLocal: $('clock-local'),
    clockNY: $('clock-ny'),
    mktState: $('mkt-state'),
    markets: $('markets'),
    watchlist: $('watchlist'),
    qhSymbol: $('qh-symbol'),
    qhName: $('qh-name'),
    qhPrice: $('qh-price'),
    qhChg: $('qh-chg'),
    qhSub: $('qh-sub'),
    tbRanges: $('tb-ranges'),
    tbOverlays: $('tb-overlays'),
    tbStudies: $('tb-studies'),
    tabs: $('tabs'),
    tabBody: $('tab-body'),
    statusMsg: $('status-msg'),
    statusRight: $('status-right'),
    fkeys: $('fkeys')
  };

  const chart = new window.MahaChart.TerminalChart($('chart-main'), $('chart-sub'));

  // ---- formatting helpers ---------------------------------------------------

  function fmtPx(v) {
    if (v == null || !isFinite(v)) return '—';
    if (Math.abs(v) >= 10000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (Math.abs(v) < 1) return v.toFixed(4);
    return v.toFixed(2);
  }

  function fmtBig(v) {
    if (v == null || !isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  function fmtPct(v, digits) {
    if (v == null || !isFinite(v)) return '—';
    const d = digits != null ? digits : 2;
    return (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
  }

  function pctClass(v) {
    if (v == null || !isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function setStatus(msg, cls) {
    el.statusMsg.textContent = msg;
    el.statusMsg.className = cls || '';
  }

  // ---- persistence ----------------------------------------------------------

  function loadWatchlist() {
    try {
      const raw = localStorage.getItem('macro-maha-watchlist');
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list) && list.length ? list : DEFAULT_WATCHLIST.slice();
    } catch (_e) {
      return DEFAULT_WATCHLIST.slice();
    }
  }

  function saveWatchlist() {
    localStorage.setItem('macro-maha-watchlist', JSON.stringify(state.watchlist));
  }

  function loadPortfolio() {
    try {
      const raw = localStorage.getItem('macro-maha-portfolio');
      const list = raw ? JSON.parse(raw) : null;
      return Array.isArray(list)
        ? list.filter((h) => h && h.sym && h.qty > 0 && h.cost >= 0)
        : [];
    } catch (_e) {
      return [];
    }
  }

  function savePortfolio() {
    localStorage.setItem('macro-maha-portfolio', JSON.stringify(state.portfolio));
  }

  // ---- data helpers ---------------------------------------------------------

  async function api(promise) {
    const res = await promise;
    if (!res.ok) throw new Error(res.error);
    return res.data;
  }

  // Daily (2y) adjusted series used by every analytics routine.
  async function getDaily(symbol) {
    const cached = state.daily.get(symbol);
    if (cached && Date.now() - cached.at < DAILY_TTL) return cached;
    const h = await api(window.maha.history(symbol, '2y', '1d'));
    const entry = {
      at: Date.now(),
      t: h.bars.map((b) => b.t),
      c: h.bars.map((b) => b.ac),
      bars: h.bars
    };
    state.daily.set(symbol, entry);
    return entry;
  }

  // ---- quote rows (markets + watchlist) -------------------------------------

  function rowId(prefix, sym) {
    return prefix + '-' + sym.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function renderQuoteRows(container, symbols, prefix) {
    container.innerHTML = symbols
      .map((sym) => {
        const label = state.names.get(sym) || sym;
        return (
          `<div class="qrow" id="${rowId(prefix, sym)}" data-sym="${esc(sym)}">` +
          `<span><span class="q-sym">${esc(sym)}</span>` +
          `<span class="q-sub">${esc(label !== sym ? label : '')}</span></span>` +
          '<span class="q-px">—</span>' +
          '<span class="q-chg flat">—</span></div>'
        );
      })
      .join('');
    container.querySelectorAll('.qrow').forEach((row) => {
      row.addEventListener('click', () => loadSymbol(row.dataset.sym));
    });
  }

  function updateRow(prefix, sym, price, chgPct, direction) {
    const row = $(rowId(prefix, sym));
    if (!row) return;
    row.querySelector('.q-px').textContent = fmtPx(price);
    const chgEl = row.querySelector('.q-chg');
    chgEl.textContent = fmtPct(chgPct);
    chgEl.className = 'q-chg ' + pctClass(chgPct);
    if (direction) {
      row.classList.remove('tick-up', 'tick-down');
      void row.offsetWidth; // restart animation
      row.classList.add(direction > 0 ? 'tick-up' : 'tick-down');
    }
    if (prefix === 'wl') row.classList.toggle('active', sym === state.symbol);
  }

  function applyQuote(q, direction) {
    if (!q || !q.symbol) return;
    const prev = state.quotes.get(q.symbol) || {};
    const merged = Object.assign({}, prev, q);
    state.quotes.set(q.symbol, merged);
    if (q.shortName) state.names.set(q.symbol, q.shortName);
    updateRow('mkt', q.symbol, merged.price, merged.changePercent, direction);
    updateRow('wl', q.symbol, merged.price, merged.changePercent, direction);
    refreshPortfolioRow(q.symbol, direction);
    if (q.symbol === state.symbol) renderQuoteHeader();
  }

  // ---- portfolio panel ------------------------------------------------------

  const pfEl = $('portfolio');
  const pfTotalEl = $('pf-total');

  function renderPortfolioRows() {
    if (!state.portfolio.length) {
      pfEl.innerHTML =
        '<div class="placeholder" style="padding:14px 10px;color:var(--text-faint)">' +
        'No positions.<br>PORT ADD AAPL 10 150</div>';
      pfTotalEl.innerHTML = 'PORT ADD &lt;SYM&gt; &lt;QTY&gt; [PX]';
      return;
    }
    pfEl.innerHTML = state.portfolio
      .map(
        (h) =>
          `<div class="qrow" id="${rowId('pf', h.sym)}" data-sym="${esc(h.sym)}">` +
          `<span><span class="q-sym">${esc(h.sym)}</span>` +
          `<span class="q-sub">${h.qty} @ ${fmtPx(h.cost)}</span></span>` +
          '<span class="q-px">—</span>' +
          '<span class="q-chg flat">—</span></div>'
      )
      .join('');
    pfEl.querySelectorAll('.qrow').forEach((row) => {
      row.addEventListener('click', () => loadSymbol(row.dataset.sym));
    });
    state.portfolio.forEach((h) => refreshPortfolioRow(h.sym));
  }

  function refreshPortfolioRow(sym, direction) {
    const h = state.portfolio.find((p) => p.sym === sym);
    if (!h) return;
    const q = state.quotes.get(sym);
    const row = $(rowId('pf', sym));
    if (!row || !q || q.price == null) return;
    row.querySelector('.q-px').textContent = '$' + fmtBig(q.price * h.qty);
    const pnl = h.cost > 0 ? (q.price / h.cost - 1) * 100 : 0;
    const chgEl = row.querySelector('.q-chg');
    chgEl.textContent = fmtPct(pnl, 1);
    chgEl.className = 'q-chg ' + pctClass(pnl);
    if (direction) {
      row.classList.remove('tick-up', 'tick-down');
      void row.offsetWidth;
      row.classList.add(direction > 0 ? 'tick-up' : 'tick-down');
    }
    refreshPortfolioTotals();
  }

  function refreshPortfolioTotals() {
    let value = 0;
    let cost = 0;
    let priced = 0;
    for (const h of state.portfolio) {
      const q = state.quotes.get(h.sym);
      if (q && q.price != null) {
        value += q.price * h.qty;
        cost += h.cost * h.qty;
        priced++;
      }
    }
    if (!priced) return;
    const pnl = cost > 0 ? (value / cost - 1) * 100 : 0;
    pfTotalEl.innerHTML =
      `$${fmtBig(value)} <span class="${pctClass(pnl)}">${fmtPct(pnl, 1)}</span>`;
  }

  // ---- quote header ---------------------------------------------------------

  function renderQuoteHeader() {
    const q = state.quotes.get(state.symbol) || {};
    el.qhSymbol.textContent = state.symbol || '—';
    el.qhName.textContent = state.names.get(state.symbol) || q.shortName || '';
    el.qhPrice.textContent = fmtPx(q.price);
    el.qhChg.textContent =
      q.change != null
        ? `${q.change >= 0 ? '+' : ''}${fmtPx(Math.abs(q.change) < 1 ? q.change : +q.change.toFixed(2))} (${fmtPct(q.changePercent)})`
        : '—';
    el.qhChg.className = pctClass(q.changePercent);
    const bits = [];
    if (q.open != null) bits.push(`<b>O</b> ${fmtPx(q.open)}`);
    if (q.dayHigh != null) bits.push(`<b>H</b> ${fmtPx(q.dayHigh)}`);
    if (q.dayLow != null) bits.push(`<b>L</b> ${fmtPx(q.dayLow)}`);
    if (q.volume != null) bits.push(`<b>VOL</b> ${fmtBig(q.volume)}`);
    if (q.previousClose != null) bits.push(`<b>PREV</b> ${fmtPx(q.previousClose)}`);
    if (q.fiftyTwoWeekLow != null) bits.push(`<b>52W</b> ${fmtPx(q.fiftyTwoWeekLow)}–${fmtPx(q.fiftyTwoWeekHigh)}`);
    if (q.marketCap != null) bits.push(`<b>MCAP</b> ${fmtBig(q.marketCap)}`);
    if (q.trailingPE != null) bits.push(`<b>P/E</b> ${q.trailingPE.toFixed(1)}`);
    if (q.exchange) bits.push(`<b>${esc(q.exchange)}</b> ${esc(q.currency || '')}`);
    el.qhSub.innerHTML = bits.join('<span style="color:var(--border-bright)">|</span>');
  }

  // ---- chart toolbar --------------------------------------------------------

  const OVERLAY_DEFS = {
    SMA20: { color: '#ffd166', calc: (c) => A.sma(c, 20) },
    SMA50: { color: '#4dd0e1', calc: (c) => A.sma(c, 50) },
    SMA200: { color: '#b58cff', calc: (c) => A.sma(c, 200) },
    EMA21: { color: '#f4a261', calc: (c) => A.ema(c, 21) },
    BB: null, // special-cased
    TREND: null
  };

  function buildToolbar() {
    el.tbRanges.innerHTML = Object.keys(RANGES)
      .map((k) => `<button data-range="${k}" ${k === state.rangeKey ? 'class="on"' : ''}>${k}</button>`)
      .join('');
    el.tbRanges.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => loadSymbol(state.symbol, btn.dataset.range));
    });

    el.tbOverlays.innerHTML = Object.keys(OVERLAY_DEFS)
      .map((k) => `<button data-ov="${k}">${k}</button>`)
      .join('');
    el.tbOverlays.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.ov;
        state.overlaysOn[key] = !state.overlaysOn[key];
        btn.classList.toggle('on', state.overlaysOn[key]);
        applyOverlays();
      });
    });

    el.tbStudies.innerHTML = ['RSI', 'MACD', 'CLOSE STUDY']
      .map((k) => `<button data-study="${k}">${k}</button>`)
      .join('');
    el.tbStudies.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.study;
        if (key === 'CLOSE STUDY') {
          state.studyOn = null;
          chart.hideSub();
        } else {
          state.studyOn = key;
          applyStudy();
        }
        el.tbStudies.querySelectorAll('button').forEach((b2) =>
          b2.classList.toggle('on', b2.dataset.study === state.studyOn)
        );
      });
    });
  }

  function applyOverlays() {
    const closes = state.chartBars.map((b) => b.c);
    for (const [key, def] of Object.entries(OVERLAY_DEFS)) {
      if (key === 'BB') {
        ['BB:U', 'BB:M', 'BB:L'].forEach((n) => chart.removeOverlay(n));
        if (state.overlaysOn.BB && closes.length >= 20) {
          const bb = A.bollinger(closes, 20, 2);
          chart.setIndicatorOverlay('BB:U', bb.upper, 'rgba(59,158,255,0.7)');
          chart.setIndicatorOverlay('BB:M', bb.mid, 'rgba(59,158,255,0.4)');
          chart.setIndicatorOverlay('BB:L', bb.lower, 'rgba(59,158,255,0.7)');
        }
        continue;
      }
      if (key === 'TREND') {
        chart.removeOverlay('TREND');
        if (state.overlaysOn.TREND && closes.length >= 10) {
          const tr = A.linearTrend(closes);
          chart.setIndicatorOverlay('TREND', tr.fitted, CC.trend, 2);
        }
        continue;
      }
      chart.removeOverlay(key);
      if (state.overlaysOn[key] && closes.length) {
        chart.setIndicatorOverlay(key, def.calc(closes), def.color);
      }
    }
  }

  function applyStudy() {
    const closes = state.chartBars.map((b) => b.c);
    if (state.studyOn === 'RSI' && closes.length > 15) chart.showRSI(A.rsi(closes, 14));
    else if (state.studyOn === 'MACD' && closes.length > 35) chart.showMACD(A.macd(closes));
  }

  // ---- symbol loading -------------------------------------------------------

  async function loadSymbol(symbol, rangeKey) {
    symbol = String(symbol || '').toUpperCase().trim();
    if (!symbol) return;
    if (rangeKey && RANGES[rangeKey]) state.rangeKey = rangeKey;
    const rk = RANGES[state.rangeKey];
    setStatus(`Loading ${symbol} ${state.rangeKey}…`);
    try {
      const h = await api(window.maha.history(symbol, rk.range, rk.interval));
      state.symbol = symbol;
      state.chartBars = h.bars;
      chart.setData(h.bars, rk.sec);
      applyOverlays();
      if (state.studyOn) applyStudy();

      // Seed the header from chart meta immediately; a fuller quote follows.
      const meta = h.meta || {};
      const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
      applyQuote({
        symbol,
        shortName: meta.shortName || meta.longName,
        currency: meta.currency,
        exchange: meta.exchangeName,
        price: meta.regularMarketPrice,
        previousClose: prev,
        change: meta.regularMarketPrice != null && prev != null ? meta.regularMarketPrice - prev : null,
        changePercent:
          meta.regularMarketPrice != null && prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : null,
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        volume: meta.regularMarketVolume
      });

      el.tbRanges.querySelectorAll('button').forEach((b) =>
        b.classList.toggle('on', b.dataset.range === state.rangeKey)
      );
      document.querySelectorAll('#watchlist .qrow').forEach((row) =>
        row.classList.toggle('active', row.dataset.sym === symbol)
      );

      streamer.subscribe([symbol]);
      pollQuotes([symbol]);
      renderActiveTab();
      setStatus(`${symbol} loaded — ${h.bars.length} bars (${state.rangeKey}).`, 'okay');
    } catch (err) {
      setStatus(`ERROR loading ${symbol}: ${err.message}`, 'err');
    }
  }

  // ---- realtime: streamer + polling fallback --------------------------------

  const streamer = new window.MahaStreamer.Streamer({
    onTick(t) {
      const direction = (() => {
        const prevQ = state.quotes.get(t.id);
        if (prevQ && prevQ.price != null) return t.price > prevQ.price ? 1 : t.price < prevQ.price ? -1 : 0;
        return 0;
      })();
      applyQuote(
        {
          symbol: t.id,
          price: t.price,
          change: t.change,
          changePercent: t.changePercent,
          dayHigh: t.dayHigh,
          dayLow: t.dayLow,
          volume: t.dayVolume,
          previousClose: t.previousClose
        },
        direction
      );
      if (t.id === state.symbol) {
        const sec = t.time ? Math.floor(t.time / (t.time > 1e12 ? 1000 : 1)) : Math.floor(Date.now() / 1000);
        chart.applyTick(t.price, sec, t.dayVolume);
      }
      el.statusRight.textContent =
        `LAST TICK ${t.id} ${fmtPx(t.price)} @ ${new Date().toLocaleTimeString()}` +
        (t.marketHoursLabel ? ` [${t.marketHoursLabel}]` : '');
    },
    onStatus(s) {
      el.conn.className = 'conn ' + (s === 'live' ? 'live' : s === 'connecting' ? 'polling' : 'reconnecting');
      el.connLabel.textContent = s === 'live' ? 'LIVE STREAM' : s.toUpperCase();
    }
  });

  function allTrackedSymbols() {
    const set = new Set(MARKET_SYMBOLS.map(([s]) => s));
    state.watchlist.forEach((s) => set.add(s));
    state.portfolio.forEach((h) => set.add(h.sym));
    if (state.symbol) set.add(state.symbol);
    return Array.from(set);
  }

  async function pollQuotes(symbols) {
    try {
      const rows = await api(window.maha.quote(symbols || allTrackedSymbols()));
      rows.forEach((q) => applyQuote(q));
      if (!streamer.isLive()) {
        el.conn.className = 'conn polling';
        el.connLabel.textContent = 'POLLING 15s';
      }
    } catch (err) {
      setStatus(`Quote poll failed: ${err.message}`, 'err');
    }
  }

  // ---- clock ----------------------------------------------------------------

  function tickClock() {
    const now = new Date();
    el.clockLocal.textContent = now.toLocaleTimeString('en-US', { hour12: false });
    const nyStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' });
    const nyParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric'
    }).formatToParts(now);
    const get = (type) => (nyParts.find((p) => p.type === type) || {}).value;
    const wd = get('weekday');
    const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
    const open = !['Sat', 'Sun'].includes(wd) && mins >= 570 && mins < 960; // 09:30–16:00 ET
    el.clockNY.innerHTML = `NY ${nyStr} <span id="mkt-state" class="${open ? 'open' : 'closed'}">${open ? '● OPEN' : '○ CLOSED'}</span>`;
  }

  // ---- command line ---------------------------------------------------------

  const VERBS = new Set(['GP', 'DES', 'STAT', 'FC', 'FORE', 'BAYES', 'BAY', 'REL', 'PAIR', 'RSI', 'MACD', 'NEWS', 'HELP', 'WL', 'PORT']);

  async function runCommand(input) {
    const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    hideSuggest();

    if (tokens[0] === 'HELP') return showTab('HELP');

    if (tokens[0] === 'PORT') return handlePortCommand(tokens.slice(1));

    if (tokens[0] === 'WL') {
      const op = tokens[1];
      const sym = tokens[2];
      if (op === 'ADD' && sym) {
        if (!state.watchlist.includes(sym)) {
          state.watchlist.push(sym);
          saveWatchlist();
          renderQuoteRows(el.watchlist, state.watchlist, 'wl');
          streamer.subscribe([sym]);
          pollQuotes([sym]);
          setStatus(`${sym} added to watchlist.`, 'okay');
        }
      } else if ((op === 'DEL' || op === 'RM') && sym) {
        state.watchlist = state.watchlist.filter((s) => s !== sym);
        saveWatchlist();
        renderQuoteRows(el.watchlist, state.watchlist, 'wl');
        pollQuotes(state.watchlist);
        setStatus(`${sym} removed from watchlist.`, 'okay');
      } else {
        setStatus('Usage: WL ADD <SYM> | WL DEL <SYM>', 'err');
      }
      return;
    }

    let symbol;
    let verb;
    let args;
    if (VERBS.has(tokens[0])) {
      symbol = state.symbol;
      verb = tokens[0];
      args = tokens.slice(1);
    } else {
      symbol = tokens[0];
      verb = tokens[1] || 'GP';
      args = tokens.slice(2);
    }
    if (!symbol) {
      setStatus('No active symbol. Try: AAPL GP', 'err');
      return;
    }

    switch (verb) {
      case 'GP': {
        const rangeKey = args.find((tk) => RANGES[tk]);
        await loadSymbol(symbol, rangeKey);
        break;
      }
      case 'DES':
        await ensureSymbol(symbol);
        await showTab('DES');
        break;
      case 'STAT':
        await ensureSymbol(symbol);
        await showTab('STAT');
        break;
      case 'FC':
      case 'FORE':
        await ensureSymbol(symbol, '1Y');
        await showTab('FC');
        break;
      case 'BAYES':
      case 'BAY':
        await ensureSymbol(symbol, '1Y');
        await showTab('BAYES');
        break;
      case 'REL':
        await ensureSymbol(symbol, '1Y');
        state.relPeers = args.length ? args : defaultPeers(symbol);
        await showTab('REL');
        break;
      case 'PAIR':
        if (!args[0]) {
          setStatus('Usage: <SYM> PAIR <SYM2>', 'err');
          return;
        }
        await ensureSymbol(symbol, '1Y');
        state.relPeers = [args[0]];
        state.pairMode = true;
        await showTab('REL');
        break;
      case 'RSI':
      case 'MACD':
        await ensureSymbol(symbol);
        state.studyOn = verb;
        applyStudy();
        el.tbStudies.querySelectorAll('button').forEach((b2) =>
          b2.classList.toggle('on', b2.dataset.study === verb)
        );
        break;
      case 'NEWS':
        await ensureSymbol(symbol);
        await showTab('NEWS');
        break;
      default:
        setStatus(`Unknown command "${verb}". Type HELP.`, 'err');
    }
  }

  async function ensureSymbol(symbol, rangeKey) {
    // Reload when the symbol/range changed or the chart is stuck in
    // relative-performance mode from a previous REL command.
    if (state.symbol !== symbol || (rangeKey && state.rangeKey !== rangeKey) || chart.mode !== 'price') {
      await loadSymbol(symbol, rangeKey);
    }
  }

  function defaultPeers(symbol) {
    return state.watchlist.filter((s) => s !== symbol).slice(0, 4);
  }

  async function handlePortCommand(args) {
    const op = args[0];
    if (!op) return showTab('PORT');

    if (op === 'ADD') {
      const sym = args[1];
      const qty = parseFloat(args[2]);
      let cost = args[3] != null ? parseFloat(args[3]) : NaN;
      if (!sym || !(qty > 0)) {
        setStatus('Usage: PORT ADD <SYM> <QTY> [COST] — e.g. PORT ADD AAPL 10 150', 'err');
        return;
      }
      if (!(cost >= 0)) {
        // No cost given: use the live price as the basis.
        try {
          const rows = await api(window.maha.quote([sym]));
          cost = rows[0] && rows[0].price;
        } catch (_e) { /* fall through */ }
        if (!(cost >= 0)) {
          setStatus(`Could not fetch a price for ${sym} — give a cost: PORT ADD ${sym} ${qty} <COST>`, 'err');
          return;
        }
      }
      const existing = state.portfolio.find((h) => h.sym === sym);
      if (existing) {
        const newQty = existing.qty + qty;
        existing.cost = (existing.qty * existing.cost + qty * cost) / newQty;
        existing.qty = newQty;
      } else {
        state.portfolio.push({ sym, qty, cost });
      }
      savePortfolio();
      renderPortfolioRows();
      streamer.subscribe([sym]);
      pollQuotes([sym]);
      setStatus(`Position ${sym} ${existing ? 'updated' : 'added'}: ${qty} @ ${fmtPx(cost)}.`, 'okay');
    } else if (op === 'DEL' || op === 'RM') {
      const sym = args[1];
      const before = state.portfolio.length;
      state.portfolio = state.portfolio.filter((h) => h.sym !== sym);
      if (state.portfolio.length < before) {
        savePortfolio();
        renderPortfolioRows();
        setStatus(`Position ${sym} removed.`, 'okay');
      } else {
        setStatus(`No position in ${sym}.`, 'err');
      }
    } else if (op === 'CLEAR') {
      state.portfolio = [];
      savePortfolio();
      renderPortfolioRows();
      setStatus('Portfolio cleared.', 'okay');
    } else {
      setStatus('Usage: PORT | PORT ADD <SYM> <QTY> [COST] | PORT DEL <SYM> | PORT CLEAR', 'err');
      return;
    }
    if (state.activeTab === 'PORT') await renderActiveTab();
  }

  // ---- command suggestions --------------------------------------------------

  let suggestTimer = null;
  let suggestSel = -1;

  function hideSuggest() {
    el.suggest.classList.add('hidden');
    el.suggest.innerHTML = '';
    suggestSel = -1;
  }

  async function updateSuggest() {
    const raw = el.cmd.value.trim();
    const first = raw.split(/\s+/)[0] || '';
    if (raw.length < 2 || raw.includes(' ') || VERBS.has(first.toUpperCase())) {
      hideSuggest();
      return;
    }
    try {
      const res = await api(window.maha.search(raw));
      if (!res.quotes.length) return hideSuggest();
      el.suggest.innerHTML = res.quotes
        .map(
          (q, i) =>
            `<div class="sug" data-sym="${esc(q.symbol)}" data-i="${i}">` +
            `<span class="s-sym">${esc(q.symbol)}</span>` +
            `<span class="s-name">${esc(q.name)}</span>` +
            `<span class="s-exch">${esc(q.exchange)} ${esc(q.type)}</span></div>`
        )
        .join('');
      el.suggest.classList.remove('hidden');
      suggestSel = -1;
      el.suggest.querySelectorAll('.sug').forEach((row) => {
        row.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          el.cmd.value = '';
          hideSuggest();
          loadSymbol(row.dataset.sym);
        });
      });
    } catch (_e) {
      hideSuggest();
    }
  }

  el.cmd.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(updateSuggest, 250);
  });

  document.addEventListener('mousedown', (ev) => {
    if (!ev.target.closest('#cmd-wrap')) hideSuggest();
  });

  el.cmd.addEventListener('keydown', (ev) => {
    const rows = el.suggest.querySelectorAll('.sug');
    if (ev.key === 'ArrowDown' && rows.length) {
      ev.preventDefault();
      suggestSel = Math.min(suggestSel + 1, rows.length - 1);
      rows.forEach((r, i) => r.classList.toggle('sel', i === suggestSel));
    } else if (ev.key === 'ArrowUp' && rows.length) {
      ev.preventDefault();
      suggestSel = Math.max(suggestSel - 1, 0);
      rows.forEach((r, i) => r.classList.toggle('sel', i === suggestSel));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (suggestSel >= 0 && rows[suggestSel]) {
        const sym = rows[suggestSel].dataset.sym;
        el.cmd.value = '';
        hideSuggest();
        loadSymbol(sym);
      } else {
        const val = el.cmd.value;
        el.cmd.value = '';
        runCommand(val);
      }
    } else if (ev.key === 'Escape') {
      hideSuggest();
      el.cmd.blur();
    }
  });

  // ---- tabs -----------------------------------------------------------------

  async function showTab(tab) {
    state.activeTab = tab;
    el.tabs.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    await renderActiveTab();
  }

  async function renderActiveTab() {
    const tab = state.activeTab;
    if (tab === 'HELP') return renderHELP();
    if (tab === 'PORT') {
      el.tabBody.innerHTML = '<div class="placeholder">Computing…</div>';
      try {
        await renderPORT();
      } catch (err) {
        el.tabBody.innerHTML = `<div class="placeholder">⚠ ${esc(err.message)}</div>`;
      }
      return;
    }
    if (!state.symbol) return;
    el.tabBody.innerHTML = '<div class="placeholder">Computing…</div>';
    try {
      if (tab === 'DES') await renderDES();
      else if (tab === 'STAT') await renderSTAT();
      else if (tab === 'FC') await renderFC();
      else if (tab === 'BAYES') await renderBAYES();
      else if (tab === 'REL') await renderREL();
      else if (tab === 'NEWS') await renderNEWS();
    } catch (err) {
      el.tabBody.innerHTML = `<div class="placeholder">⚠ ${esc(err.message)}</div>`;
    }
  }

  el.tabs.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => showTab(b.dataset.tab))
  );

  function kv(rows) {
    return (
      '<table class="kv">' +
      rows
        .filter((r) => r)
        .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
        .join('') +
      '</table>'
    );
  }

  function pctSpan(v, digits) {
    return `<span class="${pctClass(v)}">${fmtPct(v, digits)}</span>`;
  }

  // ---- DES ------------------------------------------------------------------

  async function renderDES() {
    const sym = state.symbol;
    let s = null;
    try {
      s = await api(window.maha.summary(sym));
    } catch (_e) {
      /* crumb endpoints can fail; degrade below */
    }
    const q = state.quotes.get(sym) || {};
    const prof = (s && s.assetProfile) || {};
    const det = (s && s.summaryDetail) || {};
    const ks = (s && s.defaultKeyStatistics) || {};
    const fin = (s && s.financialData) || {};
    const raw = (o) => (o && typeof o === 'object' ? o.raw : o);

    const html = [];
    html.push('<div class="sec-title">PROFILE</div>');
    html.push(
      kv([
        ['Name', esc(state.names.get(sym) || q.shortName || sym)],
        prof.sector && ['Sector', esc(prof.sector)],
        prof.industry && ['Industry', esc(prof.industry)],
        prof.country && ['Country', esc(prof.country)],
        prof.fullTimeEmployees && ['Employees', fmtBig(prof.fullTimeEmployees)],
        prof.website &&
          ['Website', `<a href="#" data-url="${esc(prof.website)}" class="ext" style="color:var(--accent)">${esc(prof.website.replace(/^https?:\/\//, ''))}</a>`]
      ])
    );
    if (prof.longBusinessSummary) {
      html.push('<div class="sec-title">BUSINESS</div>');
      html.push(`<div class="desc-text">${esc(prof.longBusinessSummary)}</div>`);
    }
    html.push('<div class="sec-title">VALUATION & FUNDAMENTALS</div>');
    html.push(
      kv([
        ['Market cap', fmtBig(raw(det.marketCap) || q.marketCap)],
        ['P/E (trail / fwd)', `${raw(det.trailingPE) ? raw(det.trailingPE).toFixed(1) : '—'} / ${raw(ks.forwardPE) ? raw(ks.forwardPE).toFixed(1) : '—'}`],
        ['EPS (trail)', raw(ks.trailingEps) != null ? raw(ks.trailingEps).toFixed(2) : '—'],
        ['Beta (5Y monthly)', raw(ks.beta) != null ? raw(ks.beta).toFixed(2) : '—'],
        ['Dividend yield', raw(det.dividendYield) != null ? (raw(det.dividendYield) * 100).toFixed(2) + '%' : '—'],
        ['52-week range', `${fmtPx(raw(det.fiftyTwoWeekLow) || q.fiftyTwoWeekLow)} – ${fmtPx(raw(det.fiftyTwoWeekHigh) || q.fiftyTwoWeekHigh)}`],
        ['Revenue (ttm)', fmtBig(raw(fin.totalRevenue))],
        ['Gross margin', raw(fin.grossMargins) != null ? (raw(fin.grossMargins) * 100).toFixed(1) + '%' : '—'],
        ['Operating margin', raw(fin.operatingMargins) != null ? (raw(fin.operatingMargins) * 100).toFixed(1) + '%' : '—'],
        ['ROE', raw(fin.returnOnEquity) != null ? (raw(fin.returnOnEquity) * 100).toFixed(1) + '%' : '—'],
        ['Analyst target (mean)', fmtPx(raw(fin.targetMeanPrice))],
        ['Recommendation', esc(fin.recommendationKey || '—').toUpperCase()]
      ])
    );
    if (!s) {
      html.push('<div class="note">Full fundamentals unavailable right now (Yahoo auth endpoint). Showing live quote data only.</div>');
    }
    el.tabBody.innerHTML = html.join('');
    el.tabBody.querySelectorAll('a.ext').forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        window.maha.openExternal(a.dataset.url);
      })
    );
  }

  // ---- STAT -----------------------------------------------------------------

  async function renderSTAT() {
    const sym = state.symbol;
    const d = await getDaily(sym);
    if (d.c.length < 60) throw new Error('Not enough daily history for statistics.');
    const desc = A.describe(d.c);
    const closes = d.c;
    const rsiArr = A.rsi(closes, 14);
    const rsiNow = rsiArr[rsiArr.length - 1];
    const m = A.macd(closes);
    const macdHist = m.hist[m.hist.length - 1];
    const sma50 = A.sma(closes, 50);
    const sma200 = A.sma(closes, 200);
    const last = closes[closes.length - 1];
    const s50 = sma50[sma50.length - 1];
    const s200 = sma200[sma200.length - 1];

    const tag = (cls, txt) => `<span class="tag ${cls}">${txt}</span>`;
    const rsiTag = rsiNow == null ? '' : rsiNow > 70 ? tag('sellish', 'OVERBOUGHT') : rsiNow < 30 ? tag('buyish', 'OVERSOLD') : tag('neutral', 'NEUTRAL');
    const macdTag = macdHist == null ? '' : macdHist > 0 ? tag('buyish', 'BULLISH') : tag('sellish', 'BEARISH');
    const trendSig =
      desc.trend.pValue < 0.05
        ? desc.trend.annualDrift > 0
          ? tag('buyish', 'UPTREND SIG.')
          : tag('sellish', 'DOWNTREND SIG.')
        : tag('neutral', 'NO SIG. TREND');

    const acfBars = desc.acf
      .map((rho, i) => {
        const w = Math.min(Math.abs(rho), 1) * 50;
        const left = rho >= 0 ? 50 : 50 - w;
        const color = rho >= 0 ? 'var(--up)' : 'var(--down)';
        return (
          `<div class="bar-row"><span class="bar-label">ρ${i + 1}</span>` +
          `<span class="bar-track"><span class="bar-fill" style="left:${left}%;width:${w}%;background:${color}"></span></span>` +
          `<span class="bar-val">${rho.toFixed(3)}</span></div>`
        );
      })
      .join('');

    el.tabBody.innerHTML =
      `<div class="sec-title">RETURN & RISK — ${esc(sym)} (2Y DAILY, ADJUSTED)</div>` +
      kv([
        ['Ann. return (log)', pctSpan(desc.annReturn * 100)],
        ['Ann. volatility', (desc.annVol * 100).toFixed(2) + '%'],
        ['Sharpe (rf=0)', desc.sharpe.toFixed(2)],
        ['Skewness', desc.skew.toFixed(3)],
        ['Excess kurtosis', desc.kurtosis.toFixed(3)],
        ['Best day', pctSpan(desc.best * 100)],
        ['Worst day', pctSpan(desc.worst * 100)],
        ['Observations', String(desc.nReturns)]
      ]) +
      '<div class="sec-title">VALUE AT RISK (DAILY)</div>' +
      kv([
        ['VaR 95% (hist)', pctSpan(desc.var95.historicalVaR * 100)],
        ['CVaR 95% (hist)', pctSpan(desc.var95.cvar * 100)],
        ['VaR 95% (normal)', pctSpan(desc.var95.parametricVaR * 100)],
        ['VaR 99% (hist)', pctSpan(desc.var99.historicalVaR * 100)],
        ['CVaR 99% (hist)', pctSpan(desc.var99.cvar * 100)]
      ]) +
      '<div class="sec-title">DRAWDOWN</div>' +
      kv([
        ['Max drawdown (2Y)', pctSpan(desc.maxDrawdown.dd * 100)],
        ['Peak date', new Date(d.t[desc.maxDrawdown.peakIdx] * 1000).toISOString().slice(0, 10)],
        ['Trough date', new Date(d.t[desc.maxDrawdown.troughIdx] * 1000).toISOString().slice(0, 10)]
      ]) +
      `<div class="sec-title">OLS TREND (LOG PRICE) ${trendSig}</div>` +
      kv([
        ['Ann. drift', pctSpan(desc.trend.annualDrift * 100)],
        ['R²', desc.trend.fit.r2.toFixed(3)],
        ['t-stat (slope)', desc.trend.fit.tSlope.toFixed(2)],
        ['p-value', desc.trend.pValue < 1e-4 ? '<0.0001' : desc.trend.pValue.toFixed(4)]
      ]) +
      `<div class="sec-title">TECHNICALS</div>` +
      kv([
        [`RSI(14) ${rsiTag}`, rsiNow != null ? rsiNow.toFixed(1) : '—'],
        [`MACD hist ${macdTag}`, macdHist != null ? macdHist.toFixed(3) : '—'],
        ['Px vs SMA50', s50 ? pctSpan((last / s50 - 1) * 100) : '—'],
        ['Px vs SMA200', s200 ? pctSpan((last / s200 - 1) * 100) : '—'],
        ['SMA50 vs SMA200', s50 && s200 ? (s50 > s200 ? '<span class="up">GOLDEN (50&gt;200)</span>' : '<span class="down">DEATH (50&lt;200)</span>') : '—']
      ]) +
      '<div class="sec-title">AUTOCORRELATION OF RETURNS (LAGS 1–10)</div>' +
      acfBars +
      '<div class="note">Add TREND on the chart toolbar to overlay the fitted OLS trend. All statistics computed locally from adjusted daily closes.</div>';
  }

  // ---- FC (forecast suite + ML signal) --------------------------------------

  async function renderFC() {
    const sym = state.symbol;
    const d = await getDaily(sym);
    if (d.c.length < 120) throw new Error('Not enough history to forecast.');
    const closes = d.c;
    const H = 63;

    const holt = A.holtForecast(closes, H);
    const ar = A.arForecast(closes, H);
    const mc = B.monteCarlo(closes, H, { nPaths: 2000, seed: 42 });
    let ml = null;
    try {
      ml = A.mlSignal(closes);
    } catch (_e) { /* not enough data */ }

    const hzs = [
      ['1W', 4],
      ['1M', 20],
      ['3M', 62]
    ];
    const rowFor = (label, idx) => {
      const h = holt.path[idx];
      const a = ar.path[idx];
      const mcMid = mc.bands.p50[idx];
      return (
        `<tr><th>${label}</th>` +
        `<td>${fmtPx(h.mean)}<br><span style="color:var(--text-faint)">${fmtPx(h.lo)}–${fmtPx(h.hi)}</span></td>` +
        `<td>${fmtPx(a.mean)}<br><span style="color:var(--text-faint)">${fmtPx(a.lo)}–${fmtPx(a.hi)}</span></td>` +
        `<td>${fmtPx(mcMid)}<br><span style="color:var(--text-faint)">${fmtPx(mc.bands.p5[idx])}–${fmtPx(mc.bands.p95[idx])}</span></td></tr>`
      );
    };

    let mlHtml = '<div class="note">ML signal unavailable (insufficient data).</div>';
    if (ml) {
      const bias =
        ml.probUp > 0.55
          ? '<span class="tag buyish">LONG BIAS</span>'
          : ml.probUp < 0.45
            ? '<span class="tag sellish">SHORT BIAS</span>'
            : '<span class="tag neutral">NEUTRAL</span>';
      mlHtml =
        `<div style="display:flex;align-items:center;gap:14px;margin:6px 0 4px">` +
        `<span class="prob-big">${(ml.probUp * 100).toFixed(1)}%</span>` +
        `<span>P(next day up)<br>${bias}</span></div>` +
        kv([
          ['Out-of-sample accuracy', (ml.testAccuracy * 100).toFixed(1) + '%'],
          ['Naive baseline', (ml.baseline * 100).toFixed(1) + '%'],
          ['Edge vs baseline', pctSpan((ml.testAccuracy - ml.baseline) * 100)],
          ['Train / test obs', `${ml.nTrain} / ${ml.nTest}`],
          ['Features', `${ml.features} (lagged returns, RSI, MACD, MA gaps, vol regime)`]
        ]);
    }

    el.tabBody.innerHTML =
      `<div class="sec-title">FORECASTS — ${esc(sym)} (63 TRADING DAYS)</div>` +
      '<table class="mat"><tr><th></th><th>HOLT</th><th>AR(p)</th><th>MONTE CARLO</th></tr>' +
      hzs.map(([lbl, i]) => rowFor(lbl, i)).join('') +
      '</table>' +
      '<div style="display:flex;gap:6px;margin:8px 0">' +
      '<button class="fc-draw tag info" data-fan="HOLT" style="cursor:pointer">DRAW HOLT</button>' +
      '<button class="fc-draw tag info" data-fan="AR" style="cursor:pointer">DRAW AR</button>' +
      '<button class="fc-draw tag info" data-fan="MC" style="cursor:pointer">DRAW MC</button>' +
      '<button class="fc-draw tag neutral" data-fan="CLEAR" style="cursor:pointer">CLEAR</button>' +
      '</div>' +
      kv([
        ['Holt (α, β)', `${holt.alpha} / ${holt.beta}`],
        ['Holt ann. trend', pctSpan(holt.annualTrend * 100)],
        ['AR order (AIC)', `p=${ar.p}`],
        ['MC drift / vol (daily)', `${(mc.muDaily * 100).toFixed(3)}% / ${(mc.sigmaDaily * 100).toFixed(2)}%`],
        ['MC P(up in 3M)', (mc.probUp * 100).toFixed(1) + '%'],
        ['MC expected 3M price', fmtPx(mc.expectedTerminal)]
      ]) +
      '<div class="sec-title">ML DIRECTION SIGNAL (LOGISTIC REGRESSION)</div>' +
      mlHtml +
      '<div class="note">Bands are 95% intervals; Holt/AR widths use a √h one-step-σ approximation, Monte Carlo bands are empirical (2000 GBM paths, seeded). Forecasts are statistical estimates from past prices only — not investment advice.</div>';

    const draw = (which) => {
      chart.clearForecasts();
      if (which === 'HOLT') chart.setForecastFan('FC', holt.path, CC.fan);
      else if (which === 'AR') chart.setForecastFan('FC', ar.path, '#b58cff');
      else if (which === 'MC') {
        chart.setForecastFan(
          'FC',
          mc.bands.p50.map((v, i) => ({ mean: v, lo: mc.bands.p5[i], hi: mc.bands.p95[i] })),
          CC.trend
        );
      }
    };
    el.tabBody.querySelectorAll('.fc-draw').forEach((btn) =>
      btn.addEventListener('click', () => draw(btn.dataset.fan))
    );
    draw('MC');
  }

  // ---- BAYES ----------------------------------------------------------------

  async function renderBAYES() {
    const sym = state.symbol;
    const d = await getDaily(sym);
    if (d.c.length < 60) throw new Error('Not enough history for Bayesian analysis.');
    const r = A.logReturns(d.c);
    const post = B.posteriorReturns(r);
    const trend = B.bayesTrend(d.c, 63, { window: 252 });

    el.tabBody.innerHTML =
      `<div class="sec-title">BAYESIAN RETURN ANALYSIS — ${esc(sym)}</div>` +
      `<div style="display:flex;align-items:center;gap:14px;margin:6px 0 4px">` +
      `<span class="prob-big">${(post.probPositive * 100).toFixed(1)}%</span>` +
      `<span>P(true drift &gt; 0)<br><span class="tag info">NIG CONJUGATE POSTERIOR</span></span></div>` +
      kv([
        ['Posterior drift (ann.)', pctSpan(post.muAnnual.mean * 100)],
        ['95% credible interval', `${fmtPct(post.muAnnual.lo * 100)} … ${fmtPct(post.muAnnual.hi * 100)}`],
        ['Posterior vol (ann.)', (post.sigmaAnnual * 100).toFixed(2) + '%'],
        ['Next-day 95% predictive', `${fmtPct(post.predictiveNextDay.lo * 100)} … ${fmtPct(post.predictiveNextDay.hi * 100)}`],
        ['Degrees of freedom', post.df.toFixed(0)],
        ['Observations', String(post.n)]
      ]) +
      `<div class="sec-title">BAYESIAN TREND REGRESSION (LAST ${trend.window} DAYS)</div>` +
      kv([
        ['Posterior drift (ann.)', pctSpan(trend.driftAnnual.mean * 100)],
        ['95% credible interval', `${fmtPct(trend.driftAnnual.lo * 100)} … ${fmtPct(trend.driftAnnual.hi * 100)}`],
        ['P(trend &gt; 0)', (trend.probPositive * 100).toFixed(1) + '%'],
        ['R²', trend.r2.toFixed(3)],
        ['Residual σ (daily)', (trend.residSigma * 100).toFixed(2) + '%']
      ]) +
      '<div style="display:flex;gap:6px;margin:8px 0">' +
      '<button id="bay-draw" class="tag info" style="cursor:pointer">DRAW PREDICTIVE FAN</button>' +
      '<button id="bay-clear" class="tag neutral" style="cursor:pointer">CLEAR</button>' +
      '</div>' +
      '<div class="note">The 63-day fan uses the Student-t posterior predictive of the Bayesian regression — the band widens with horizon and leverage, unlike a naive normal approximation. Weakly-informative priors; with 250+ observations the data dominates. Statistical estimates only — not investment advice.</div>';

    const drawFan = () => {
      chart.clearForecasts();
      chart.setForecastFan('BAYES', trend.fan, CC.accent);
    };
    $('bay-draw').addEventListener('click', drawFan);
    $('bay-clear').addEventListener('click', () => chart.clearForecasts());
    drawFan();
  }

  // ---- REL (correlations / beta / pairs) ------------------------------------

  async function renderREL() {
    const sym = state.symbol;
    const peers = (state.relPeers && state.relPeers.length ? state.relPeers : defaultPeers(sym)).filter(
      (p) => p !== sym
    );
    if (!peers.length) throw new Error('No peers. Try: ' + sym + ' REL MSFT NVDA');
    const universe = [sym].concat(peers);
    const withBench = universe.includes(BENCH) ? universe : universe.concat([BENCH]);

    const fetched = await Promise.all(
      withBench.map(async (s) => {
        try {
          return [s, await getDaily(s)];
        } catch (_e) {
          return [s, null];
        }
      })
    );
    const seriesMap = {};
    for (const [s, ser] of fetched) {
      if (ser && ser.c.length > 60) seriesMap[s] = { t: ser.t, c: ser.c };
    }
    const missing = withBench.filter((s) => !seriesMap[s]);
    const aligned = A.alignSeries(seriesMap);
    const have = Object.keys(aligned.closes).filter((s) => universe.includes(s));
    if (have.length < 2) throw new Error('Could not load enough peer data.');

    const returnsMap = {};
    for (const s of Object.keys(aligned.closes)) returnsMap[s] = A.logReturns(aligned.closes[s]);
    const cm = A.corrMatrix(
      Object.fromEntries(have.map((s) => [s, returnsMap[s]]))
    );

    const cellColor = (c) => {
      const alpha = Math.min(Math.abs(c), 1) * 0.55;
      return c >= 0 ? `rgba(59,158,255,${alpha})` : `rgba(255,93,108,${alpha})`;
    };
    const matHtml =
      '<table class="mat"><tr><th></th>' +
      cm.symbols.map((s) => `<th>${esc(s)}</th>`).join('') +
      '</tr>' +
      cm.symbols
        .map(
          (s, i) =>
            `<tr><th>${esc(s)}</th>` +
            cm.matrix[i]
              .map((c) => `<td style="background:${cellColor(c)}">${c.toFixed(2)}</td>`)
              .join('') +
            '</tr>'
        )
        .join('') +
      '</table>';

    let betaHtml = '<div class="note">Benchmark data unavailable.</div>';
    if (returnsMap[BENCH]) {
      betaHtml = kv(
        have
          .filter((s) => s !== BENCH)
          .map((s) => {
            const ba = A.betaAlpha(returnsMap[s], returnsMap[BENCH]);
            return [
              `${esc(s)} β / α / R²`,
              `${ba.beta.toFixed(2)} / ${fmtPct(ba.alphaAnnual * 100, 1)} / ${ba.r2.toFixed(2)}`
            ];
          })
      );
    }

    let pairHtml = '';
    if (peers[0]) {
      const other = peers[0];
      if (aligned.closes[sym] && aligned.closes[other]) {
        const pa = A.spreadAnalysis(aligned.closes[sym], aligned.closes[other]);
        const zTag =
          Math.abs(pa.zNow) > 2
            ? `<span class="tag ${pa.zNow > 0 ? 'sellish' : 'buyish'}">${pa.zNow > 0 ? 'RICH' : 'CHEAP'} vs ${esc(other)}</span>`
            : '<span class="tag neutral">FAIR</span>';
        pairHtml =
          `<div class="sec-title">PAIR — ${esc(sym)} vs ${esc(other)} ${zTag}</div>` +
          kv([
            ['Hedge ratio (log OLS)', pa.hedgeRatio.toFixed(3)],
            ['Spread z-score now', pa.zNow.toFixed(2)],
            ['Return correlation', pa.corrReturns.toFixed(3)],
            ['Mean-reversion half-life', isFinite(pa.halfLife) ? pa.halfLife.toFixed(0) + ' days' : 'none detected'],
            ['Reversion t-stat', pa.lambdaT.toFixed(2)]
          ]) +
          '<div class="note">Z-score of the log-price spread shown in the study pane below the chart. |z| &gt; 2 has historically mean-reverted when the half-life is short and the reversion t-stat is strongly negative.</div>';
        // Times for the aligned spread series (skip first point to match z-length? z aligns 1:1)
        chart.showZScore(aligned.t, pa.z);
      }
    }

    el.tabBody.innerHTML =
      `<div class="sec-title">CORRELATION MATRIX (DAILY LOG RETURNS, ALIGNED ${aligned.t.length}D)</div>` +
      matHtml +
      `<div class="sec-title">BETA vs ${esc(BENCH)}</div>` +
      betaHtml +
      pairHtml +
      (missing.length ? `<div class="note">Unavailable: ${missing.map(esc).join(', ')}</div>` : '') +
      '<div class="note">Chart is showing normalized relative performance (%) for the group. Run a plain chart command (e.g. ' +
      esc(sym) +
      ' GP) to return to candles.</div>';

    // Switch main chart into relative-performance mode.
    const perfMap = {};
    for (const s of have) perfMap[s] = { t: aligned.t, c: aligned.closes[s] };
    chart.setPerformanceMode(perfMap, PERF_COLORS);
    state.pairMode = false;
  }

  // ---- PORT (portfolio analysis) --------------------------------------------

  async function renderPORT() {
    if (!state.portfolio.length) {
      el.tabBody.innerHTML =
        '<div class="sec-title">PORTFOLIO</div>' +
        '<div class="desc-text">No positions yet. Add holdings from the command line:</div>' +
        '<table class="kv cmd-list">' +
        '<tr><td>PORT ADD AAPL 10 150</td><td style="text-align:left">10 shares, cost basis $150</td></tr>' +
        '<tr><td>PORT ADD BTC-USD 0.5</td><td style="text-align:left">cost basis = current price</td></tr>' +
        '<tr><td>PORT DEL AAPL</td><td style="text-align:left">remove a position</td></tr>' +
        '</table>' +
        '<div class="note">Positions persist locally on this Mac (no backend, nothing leaves your machine). Adding to an existing position merges lots at the weighted-average cost.</div>';
      return;
    }

    // Live valuation from the quote map (stream/poll keeps it fresh).
    const rowsLive = state.portfolio.map((h) => {
      const q = state.quotes.get(h.sym) || {};
      const price = q.price != null ? q.price : null;
      return {
        sym: h.sym,
        qty: h.qty,
        cost: h.cost,
        price,
        value: price != null ? price * h.qty : null,
        dayPnl: q.change != null ? q.change * h.qty : null,
        pnlPct: price != null && h.cost > 0 ? (price / h.cost - 1) * 100 : null
      };
    });
    const totalValue = rowsLive.reduce((s, r) => s + (r.value || 0), 0);
    const totalCost = state.portfolio.reduce((s, h) => s + h.qty * h.cost, 0);
    const dayPnl = rowsLive.reduce((s, r) => s + (r.dayPnl || 0), 0);

    // Daily histories for risk analytics.
    const symsAll = state.portfolio.map((h) => h.sym);
    const fetched = await Promise.all(
      symsAll.concat([BENCH]).map(async (s) => {
        try {
          return [s, await getDaily(s)];
        } catch (_e) {
          return [s, null];
        }
      })
    );
    const seriesMap = {};
    for (const [s, ser] of fetched) {
      if (ser && ser.c.length > 60) seriesMap[s] = { t: ser.t, c: ser.c };
    }
    const analyzable = symsAll.filter((s) => seriesMap[s]);
    const missing = symsAll.filter((s) => !seriesMap[s]);
    if (analyzable.length < 1) throw new Error('No daily history available for the portfolio.');
    const aligned = A.alignSeries(seriesMap);

    // Buy-and-hold portfolio value series with current share counts.
    const qtyOf = Object.fromEntries(state.portfolio.map((h) => [h.sym, h.qty]));
    const Vt = aligned.t.map((_, i) =>
      analyzable.reduce((s, sym2) => s + qtyOf[sym2] * aligned.closes[sym2][i], 0)
    );
    const rv = A.logReturns(Vt);
    const annRet = A.mean(rv) * A.TRADING_DAYS;
    const annVol = A.std(rv) * Math.sqrt(A.TRADING_DAYS);
    const dd = A.maxDrawdown(Vt);

    // Current-composition weights (aligned last closes) for risk decomposition.
    const lastClose = Object.fromEntries(
      analyzable.map((s) => [s, aligned.closes[s][aligned.closes[s].length - 1]])
    );
    const valNow = analyzable.reduce((s, sym2) => s + qtyOf[sym2] * lastClose[sym2], 0);
    const weights = Object.fromEntries(
      analyzable.map((s) => [s, (qtyOf[s] * lastClose[s]) / valNow])
    );
    const returnsMap = {};
    for (const s of Object.keys(aligned.closes)) returnsMap[s] = A.logReturns(aligned.closes[s]);
    const rp = A.portfolioReturns(returnsMap, weights);
    const risk95 = A.varCvar(rp, 0.95);
    const risk99 = A.varCvar(rp, 0.99);
    const rc = A.riskContributions(returnsMap, weights);
    const div = A.diversificationMetrics(returnsMap, weights);
    const post = B.posteriorReturns(rp);
    const mc = B.monteCarlo(Vt, 63, { nPaths: 2000, seed: 42 });

    let betaHtml = '—';
    if (returnsMap[BENCH]) {
      const ba = A.betaAlpha(rv, returnsMap[BENCH].slice(-rv.length));
      betaHtml = `${ba.beta.toFixed(2)} / ${fmtPct(ba.alphaAnnual * 100, 1)} / ${ba.r2.toFixed(2)}`;
    }

    const posTable =
      '<table class="mat"><tr><th>SYM</th><th>QTY</th><th>COST</th><th>LAST</th><th>VALUE</th><th>WT</th><th>P&amp;L</th></tr>' +
      rowsLive
        .map((r) => {
          const w = r.value != null && totalValue > 0 ? (r.value / totalValue) * 100 : null;
          return (
            `<tr><th>${esc(r.sym)}</th>` +
            `<td>${r.qty}</td><td>${fmtPx(r.cost)}</td><td>${fmtPx(r.price)}</td>` +
            `<td>$${fmtBig(r.value)}</td><td>${w != null ? w.toFixed(1) + '%' : '—'}</td>` +
            `<td class="${pctClass(r.pnlPct)}">${fmtPct(r.pnlPct, 1)}</td></tr>`
          );
        })
        .join('') +
      '</table>';

    const rcBars = analyzable
      .map((s) => {
        const pct = rc.contribs[s] * 100;
        const w = Math.min(Math.abs(pct), 100) * 0.98;
        return (
          `<div class="bar-row"><span class="bar-label">${esc(s)}</span>` +
          `<span class="bar-track"><span class="bar-fill" style="left:0;width:${w}%;background:var(--accent)"></span></span>` +
          `<span class="bar-val">${pct.toFixed(1)}%</span></div>`
        );
      })
      .join('');

    const pnlTotal = totalCost > 0 ? (totalValue / totalCost - 1) * 100 : 0;
    el.tabBody.innerHTML =
      '<div class="sec-title">POSITIONS</div>' +
      posTable +
      '<div class="sec-title">PERFORMANCE</div>' +
      kv([
        ['Market value', '$' + fmtBig(totalValue)],
        ['Cost basis', '$' + fmtBig(totalCost)],
        ['Unrealized P&L', `<span class="${pctClass(pnlTotal)}">$${fmtBig(totalValue - totalCost)} (${fmtPct(pnlTotal, 1)})</span>`],
        ['Day P&L', `<span class="${pctClass(dayPnl)}">$${fmtBig(dayPnl)}</span>`],
        ['Ann. return (2Y, B&H)', pctSpan(annRet * 100)],
        ['Ann. volatility', (annVol * 100).toFixed(2) + '%'],
        ['Sharpe (rf=0)', annVol > 0 ? (annRet / annVol).toFixed(2) : '—'],
        ['Max drawdown', pctSpan(dd.dd * 100)],
        [`β / α / R² vs ${esc(BENCH)}`, betaHtml]
      ]) +
      '<div class="sec-title">RISK (CURRENT WEIGHTS, DAILY)</div>' +
      kv([
        ['VaR 95%', `<span class="down">$${fmtBig(Math.abs(risk95.historicalVaR) * totalValue)} (${fmtPct(risk95.historicalVaR * 100)})</span>`],
        ['CVaR 95%', `<span class="down">$${fmtBig(Math.abs(risk95.cvar) * totalValue)} (${fmtPct(risk95.cvar * 100)})</span>`],
        ['VaR 99%', `<span class="down">$${fmtBig(Math.abs(risk99.historicalVaR) * totalValue)} (${fmtPct(risk99.historicalVaR * 100)})</span>`],
        ['Portfolio vol (daily)', (rc.volDaily * 100).toFixed(2) + '%'],
        ['Diversification ratio', div.diversificationRatio.toFixed(2)],
        ['Effective # positions', div.effectiveN.toFixed(1) + ' of ' + analyzable.length],
        ['Avg pairwise corr', div.avgPairCorr.toFixed(2)],
        ['Largest weight', (Math.max.apply(null, Object.values(weights)) * 100).toFixed(1) + '%']
      ]) +
      '<div class="sec-title">RISK CONTRIBUTION BY POSITION</div>' +
      rcBars +
      '<div class="sec-title">OUTLOOK (STATISTICAL)</div>' +
      kv([
        ['Bayesian P(drift > 0)', (post.probPositive * 100).toFixed(1) + '%'],
        ['Posterior drift (ann.)', pctSpan(post.muAnnual.mean * 100)],
        ['MC P(portfolio up in 3M)', (mc.probUp * 100).toFixed(1) + '%'],
        ['MC expected value (3M)', '$' + fmtBig((mc.expectedTerminal / mc.s0) * totalValue)],
        ['MC 5th percentile (3M)', `<span class="down">$${fmtBig((mc.terminalP5 / mc.s0) * totalValue)}</span>`]
      ]) +
      (missing.length ? `<div class="note">Excluded from risk analytics (no history): ${missing.map(esc).join(', ')}</div>` : '') +
      `<div class="note">Chart shows your portfolio vs ${esc(BENCH)} (normalized %). Risk uses 2Y of aligned daily closes: VaR/CVaR and contributions use current weights; return/drawdown assume today's share counts held throughout. Statistical estimates — not investment advice.</div>`;

    // Chart: portfolio index vs benchmark, normalized.
    const perfMap = { PORT: { t: aligned.t, c: Vt } };
    if (seriesMap[BENCH]) perfMap[BENCH] = { t: aligned.t, c: aligned.closes[BENCH] };
    chart.setPerformanceMode(perfMap, PERF_COLORS);
    chart.hideSub();
  }

  // ---- NEWS -----------------------------------------------------------------

  async function renderNEWS() {
    const sym = state.symbol;
    const res = await api(window.maha.search(sym));
    if (!res.news.length) {
      el.tabBody.innerHTML = '<div class="placeholder">No news found.</div>';
      return;
    }
    el.tabBody.innerHTML =
      `<div class="sec-title">NEWS — ${esc(sym)}</div>` +
      res.news
        .map(
          (n, i) =>
            `<div class="news-item" data-i="${i}">` +
            `<div class="n-title">${esc(n.title)}</div>` +
            `<div class="n-meta">${esc(n.publisher || '')} · ${n.time ? new Date(n.time * 1000).toLocaleString() : ''}</div></div>`
        )
        .join('');
    el.tabBody.querySelectorAll('.news-item').forEach((item) =>
      item.addEventListener('click', () => {
        const n = res.news[Number(item.dataset.i)];
        if (n && n.link) window.maha.openExternal(n.link);
      })
    );
  }

  // ---- HELP -----------------------------------------------------------------

  function renderHELP() {
    el.tabs.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    el.tabBody.innerHTML =
      '<div class="sec-title">COMMAND REFERENCE</div>' +
      '<table class="kv cmd-list">' +
      [
        ['AAPL', 'Load symbol (chart + analytics)'],
        ['AAPL GP 5Y', 'Chart with range: 1D 5D 1M 6M YTD 1Y 5Y MAX'],
        ['AAPL DES', 'Company profile & fundamentals'],
        ['AAPL STAT', 'Statistical analysis (returns, VaR, trend, ACF)'],
        ['AAPL FC', 'Forecasts: Holt, AR(p), Monte Carlo + ML signal'],
        ['AAPL BAYES', 'Bayesian drift & trend with credible intervals'],
        ['AAPL REL MSFT NVDA', 'Correlations, betas, relative performance'],
        ['AAPL PAIR MSFT', 'Pair spread, z-score, mean-reversion half-life'],
        ['AAPL RSI / MACD', 'Indicator study pane'],
        ['AAPL NEWS', 'Latest headlines'],
        ['WL ADD TSLA', 'Add to watchlist (WL DEL removes)'],
        ['PORT', 'Portfolio dashboard: P&L, VaR, risk contribution'],
        ['PORT ADD AAPL 10 150', 'Add 10 shares @ $150 (omit cost = live price)'],
        ['PORT DEL AAPL / CLEAR', 'Remove a position / clear portfolio'],
        ['HELP', 'This screen'],
        ['⌘K', 'Focus command line'],
        ['F1–F8', 'Function keys for the active symbol']
      ]
        .map(([c, d2]) => `<tr><td>${c}</td><td style="text-align:left">${d2}</td></tr>`)
        .join('') +
      '</table>' +
      '<div class="note">Typing a partial name (e.g. "micros") searches Yahoo symbols. Data: Yahoo Finance websocket stream with REST polling fallback. All analytics run locally in-app — no backend, no data leaves your machine except requests to Yahoo.</div>';
  }

  // ---- keyboard shortcuts ---------------------------------------------------

  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      el.cmd.focus();
      el.cmd.select();
      return;
    }
    const fmap = { F1: 'HELP', F2: 'DES', F3: 'GP', F4: 'STAT', F5: 'FC', F6: 'BAYES', F7: 'REL', F8: 'NEWS' };
    if (fmap[ev.key]) {
      ev.preventDefault();
      runCommand(fmap[ev.key]);
    }
  });

  el.fkeys.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd))
  );

  // ---- boot -----------------------------------------------------------------

  function boot() {
    buildToolbar();
    MARKET_SYMBOLS.forEach(([s, label]) => state.names.set(s, label));
    renderQuoteRows(el.markets, MARKET_SYMBOLS.map(([s]) => s), 'mkt');
    renderQuoteRows(el.watchlist, state.watchlist, 'wl');
    renderPortfolioRows();

    tickClock();
    setInterval(tickClock, 1000);

    streamer.connect();
    streamer.subscribe(allTrackedSymbols());

    pollQuotes();
    setInterval(() => pollQuotes(), POLL_MS);

    loadSymbol(state.watchlist[0] || 'AAPL', '1Y');
  }

  boot();
})();
