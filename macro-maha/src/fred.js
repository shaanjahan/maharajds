// FRED (St. Louis Fed) client — main process.
// Uses the keyless fredgraph.csv endpoint: it returns the full observation
// history for one or more series ids as CSV, no API key required.
// Series are fetched in frequency-grouped batches so one bad id can only
// take down its own batch; results are cached for 6 hours (macro data is slow).

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Grouped by native frequency (daily/weekly series get a shorter window).
const BATCHES = [
  { start: '2015-01-01', ids: ['DGS2', 'DGS10', 'T10Y2Y', 'ICSA'] },
  {
    start: '1990-01-01',
    ids: [
      'UNRATE', 'PAYEMS', 'CIVPART', 'CPIAUCSL', 'CPILFESL', 'PCEPILFE',
      'FEDFUNDS', 'M2SL', 'INDPRO', 'RSAFS', 'UMCSENT', 'HOUST'
    ]
  },
  { start: '1980-01-01', ids: ['GDPC1', 'A191RL1Q225SBEA', 'OPHNFB', 'GFDEGDQ188S'] },
  { start: '1955-01-01', ids: ['RTFPNAUSA632NRUG'] }
];

let cache = { at: 0, data: null };

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('FRED returned an empty CSV');
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  // First column is the date (named DATE or observation_date depending on era).
  const out = {};
  for (let c = 1; c < header.length; c++) out[header[c]] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    if (cells.length < 2) continue;
    const t = Date.parse(cells[0] + 'T00:00:00Z');
    if (!isFinite(t)) continue;
    for (let c = 1; c < header.length && c < cells.length; c++) {
      const raw = cells[c].trim();
      if (raw === '' || raw === '.') continue;
      const v = parseFloat(raw);
      if (isFinite(v)) out[header[c]].push({ t: Math.floor(t / 1000), v });
    }
  }
  return out;
}

async function fetchBatch(ids, start) {
  const url =
    'https://fred.stlouisfed.org/graph/fredgraph.csv' +
    `?id=${encodeURIComponent(ids.join(','))}&cosd=${start}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' }
  });
  if (!res.ok) throw new Error(`FRED HTTP ${res.status} for [${ids.join(',')}]`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error('FRED returned non-CSV (blocked or bad ids)');
  return parseCsv(text);
}

async function all() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const settled = await Promise.allSettled(
    BATCHES.map((b) => fetchBatch(b.ids, b.start))
  );
  const series = {};
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') Object.assign(series, r.value);
    else errors.push(`[${BATCHES[i].ids.join(',')}]: ${r.reason && r.reason.message}`);
  });
  if (!Object.keys(series).length) {
    throw new Error('Could not reach FRED: ' + errors.join(' | '));
  }
  const data = { series, errors, fetchedAt: Date.now() };
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { all, parseCsv };
