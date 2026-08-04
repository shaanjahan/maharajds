// Yahoo Finance client (main process, Node's global fetch).
//
// Endpoint notes:
//  - v8 chart:        no auth needed. OHLCV history + a live-ish meta quote.
//  - v1 search:       no auth needed. Symbol lookup + news headlines.
//  - v7 quote,
//    v10 quoteSummary: require a cookie + "crumb" pair since 2023. We fetch a
//    cookie from fc.yahoo.com, exchange it for a crumb, cache both and retry
//    once on 401/403. If crumb auth fails entirely we degrade gracefully
//    (quotes fall back to v8 chart meta; summary returns what it can).

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CRUMB_TTL_MS = 25 * 60 * 1000;

let auth = { cookie: null, crumb: null, at: 0 };

function baseHeaders(extra) {
  return Object.assign(
    { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    extra || {}
  );
}

function setCookieHeader(res) {
  // undici exposes getSetCookie(); fall back to the joined header otherwise.
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const joined = res.headers.get('set-cookie');
    if (joined) raw = [joined];
  }
  return raw
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

async function refreshAuth() {
  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: baseHeaders(),
    redirect: 'manual'
  }).catch(() => null);
  const cookie = r1 ? setCookieHeader(r1) : '';
  if (!cookie) throw new Error('Could not obtain Yahoo cookie');

  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: baseHeaders({ Cookie: cookie })
  });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) {
    throw new Error('Could not obtain Yahoo crumb');
  }
  auth = { cookie, crumb, at: Date.now() };
}

async function ensureAuth() {
  if (auth.crumb && Date.now() - auth.at < CRUMB_TTL_MS) return;
  await refreshAuth();
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: baseHeaders(headers) });
  if (!res.ok) {
    const err = new Error(`Yahoo HTTP ${res.status} for ${url.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function authedJson(buildUrl) {
  await ensureAuth();
  try {
    return await getJson(buildUrl(auth.crumb), { Cookie: auth.cookie });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      await refreshAuth();
      return getJson(buildUrl(auth.crumb), { Cookie: auth.cookie });
    }
    throw err;
  }
}

// ---- history ----------------------------------------------------------------

async function history(symbol, range = '1y', interval = '1d') {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}` +
    '&includeAdjustedClose=true&events=div%2Csplit';
  const json = await getJson(url);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) {
    const msg =
      (json && json.chart && json.chart.error && json.chart.error.description) ||
      `No chart data for ${symbol}`;
    throw new Error(msg);
  }

  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adj =
    (result.indicators &&
      result.indicators.adjclose &&
      result.indicators.adjclose[0] &&
      result.indicators.adjclose[0].adjclose) ||
    null;

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (c == null) continue; // skip halted/empty buckets
    bars.push({
      t: ts[i],
      o: q.open && q.open[i] != null ? q.open[i] : c,
      h: q.high && q.high[i] != null ? q.high[i] : c,
      l: q.low && q.low[i] != null ? q.low[i] : c,
      c,
      v: (q.volume && q.volume[i]) || 0,
      ac: adj && adj[i] != null ? adj[i] : c
    });
  }

  return { symbol, meta: result.meta || {}, bars };
}

// ---- quotes -----------------------------------------------------------------

function pickQuoteFields(q) {
  return {
    symbol: q.symbol,
    shortName: q.shortName || q.longName || q.symbol,
    currency: q.currency,
    exchange: q.fullExchangeName || q.exchange,
    marketState: q.marketState,
    price: q.regularMarketPrice,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    previousClose: q.regularMarketPreviousClose,
    open: q.regularMarketOpen,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    volume: q.regularMarketVolume,
    marketCap: q.marketCap,
    trailingPE: q.trailingPE,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    postMarketPrice: q.postMarketPrice,
    preMarketPrice: q.preMarketPrice
  };
}

async function quoteViaChartMeta(symbol) {
  const { meta } = await history(symbol, '1d', '1m');
  const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
  const price = meta.regularMarketPrice;
  return {
    symbol: meta.symbol || symbol,
    shortName: meta.shortName || meta.longName || symbol,
    currency: meta.currency,
    exchange: meta.exchangeName,
    marketState: null,
    price,
    change: price != null && prev != null ? price - prev : null,
    changePercent:
      price != null && prev ? ((price - prev) / prev) * 100 : null,
    previousClose: prev,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume
  };
}

async function quote(symbols) {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean);
  if (!list.length) return [];
  try {
    const json = await authedJson(
      (crumb) =>
        'https://query1.finance.yahoo.com/v7/finance/quote' +
        `?symbols=${encodeURIComponent(list.join(','))}&crumb=${encodeURIComponent(crumb)}`
    );
    const rows =
      (json && json.quoteResponse && json.quoteResponse.result) || [];
    if (rows.length) return rows.map(pickQuoteFields);
    throw new Error('empty v7 quote response');
  } catch (_err) {
    // Crumb auth flaky or blocked — fall back to per-symbol chart meta.
    const out = await Promise.allSettled(list.map((s) => quoteViaChartMeta(s)));
    return out
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);
  }
}

// ---- search + news ----------------------------------------------------------

async function search(query) {
  const url =
    'https://query1.finance.yahoo.com/v1/finance/search' +
    `?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=12` +
    '&enableFuzzyQuery=false&enableEnhancedTrivialQuery=true';
  const json = await getJson(url);
  return {
    quotes: (json.quotes || [])
      .filter((q) => q.symbol)
      .map((q) => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || '',
        exchange: q.exchDisp || q.exchange || '',
        type: q.typeDisp || q.quoteType || ''
      })),
    news: (json.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      time: n.providerPublishTime,
      link: n.link
    }))
  };
}

// ---- company summary --------------------------------------------------------

const SUMMARY_MODULES = [
  'assetProfile',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'price'
].join(',');

async function quoteSummary(symbol) {
  const json = await authedJson(
    (crumb) =>
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${SUMMARY_MODULES}&crumb=${encodeURIComponent(crumb)}`
  );
  const result =
    json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!result) {
    const msg =
      (json && json.quoteSummary && json.quoteSummary.error && json.quoteSummary.error.description) ||
      `No summary for ${symbol}`;
    throw new Error(msg);
  }
  return result;
}

module.exports = { quote, history, search, quoteSummary };
