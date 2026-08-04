// Unit tests for the Macro Maha analytics + Bayes engines. Run: npm test
const assert = require('assert');
const A = require('../renderer/js/analytics.js');
const B = require('../renderer/js/bayes.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('FAIL  ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}
const near = (a, b, tol) => {
  if (!(Math.abs(a - b) <= tol)) throw new assert.AssertionError({ message: `${a} !~ ${b} (tol ${tol})` });
};

// Deterministic pseudo-random walk for model tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gbmSeries(n, mu, sigma, seed) {
  const rand = mulberry32(seed);
  let spare = null;
  const gauss = () => {
    if (spare != null) { const v = spare; spare = null; return v; }
    let u = 0; while (u === 0) u = rand();
    const v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * Math.exp(mu + sigma * gauss()));
  return out;
}

// ---- moments ----------------------------------------------------------------
test('mean/std/variance', () => {
  const x = [2, 4, 4, 4, 5, 5, 7, 9];
  near(A.mean(x), 5, 1e-12);
  near(A.variance(x), 32 / 7, 1e-12);
  near(A.std(x), Math.sqrt(32 / 7), 1e-12);
});

test('skewness symmetric ~ 0', () => {
  near(A.skewness([1, 2, 3, 4, 5, 6, 7]), 0, 1e-9);
});

test('quantile interpolation', () => {
  near(A.quantile([1, 2, 3, 4, 5], 0.5), 3, 1e-12);
  near(A.quantile([1, 2, 3, 4], 0.5), 2.5, 1e-12);
});

test('logReturns', () => {
  const r = A.logReturns([100, 110, 99]);
  near(r[0], Math.log(1.1), 1e-12);
  near(r[1], Math.log(0.9), 1e-12);
});

// ---- distributions ----------------------------------------------------------
test('normQuantile matches known values', () => {
  near(A.normQuantile(0.975), 1.959964, 1e-4);
  near(A.normQuantile(0.5), 0, 1e-8);
  near(A.normQuantile(0.05), -1.644854, 1e-4);
});

test('normCDF inverse consistency', () => {
  near(A.normCDF(1.959964), 0.975, 1e-3);
  near(A.normCDF(0), 0.5, 1e-9);
});

test('tCDF / tQuantile match tables', () => {
  near(A.tQuantile(0.975, 10), 2.228, 2e-3);
  near(A.tQuantile(0.95, 5), 2.015, 2e-3);
  near(A.tQuantile(0.975, 120), 1.98, 2e-2);
  near(A.tCDF(2.228, 10), 0.975, 1e-3);
  near(A.tCDF(0, 7), 0.5, 1e-9);
});

// ---- indicators -------------------------------------------------------------
test('sma', () => {
  const s = A.sma([1, 2, 3, 4, 5], 3);
  assert.strictEqual(s[0], null);
  assert.strictEqual(s[1], null);
  near(s[2], 2, 1e-12);
  near(s[4], 4, 1e-12);
});

test('ema seeds with sma and responds', () => {
  const e = A.ema([1, 1, 1, 1, 10], 3);
  near(e[2], 1, 1e-12);
  assert.ok(e[4] > 1 && e[4] < 10);
});

test('rsi bounded and directional', () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const r = A.rsi(up, 14);
  assert.ok(r[39] > 95);
  const down = Array.from({ length: 40 }, (_, i) => 100 - i);
  const r2 = A.rsi(down, 14);
  assert.ok(r2[39] < 5);
});

test('macd hist positive in strong uptrend', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * Math.exp(0.01 * i));
  const m = A.macd(up);
  assert.ok(m.hist[79] > 0);
});

test('bollinger ordering', () => {
  const x = gbmSeries(100, 0, 0.01, 7);
  const bb = A.bollinger(x, 20, 2);
  for (let i = 19; i < x.length; i++) {
    assert.ok(bb.lower[i] < bb.mid[i] && bb.mid[i] < bb.upper[i]);
  }
});

test('maxDrawdown on known path', () => {
  const dd = A.maxDrawdown([100, 120, 60, 90]);
  near(dd.dd, -0.5, 1e-12);
  assert.strictEqual(dd.peakIdx, 1);
  assert.strictEqual(dd.troughIdx, 2);
});

// ---- regression & risk ------------------------------------------------------
test('ols recovers a perfect line', () => {
  const x = [0, 1, 2, 3, 4, 5];
  const y = x.map((v) => 3 + 2 * v);
  const f = A.ols(x, y);
  near(f.slope, 2, 1e-10);
  near(f.intercept, 3, 1e-10);
  near(f.r2, 1, 1e-10);
});

test('linearTrend annual drift ~ n*daily', () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 * Math.exp(0.001 * i));
  const tr = A.linearTrend(closes);
  near(tr.dailyDrift, 0.001, 1e-9);
  near(tr.annualDrift, 0.252, 1e-6);
  assert.ok(tr.pValue < 1e-6);
});

test('varCvar sane ordering', () => {
  const r = gbmSeries(500, 0, 0.02, 11).slice(1).map((v, i, arr) =>
    Math.log(v / (i === 0 ? 100 : arr[i - 1]))
  );
  const rr = A.logReturns(gbmSeries(500, 0, 0.02, 11));
  const v = A.varCvar(rr, 0.95);
  assert.ok(v.historicalVaR < 0);
  assert.ok(v.cvar <= v.historicalVaR);
});

// ---- forecasting ------------------------------------------------------------
test('holtForecast continues a deterministic trend', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(0.002 * i));
  const f = A.holtForecast(closes, 10);
  const expected = 100 * Math.exp(0.002 * 129);
  near(f.path[9].mean / expected, 1, 0.02);
  assert.ok(f.path[9].lo <= f.path[9].mean && f.path[9].mean <= f.path[9].hi);
});

test('arForecast runs and orders bands', () => {
  const closes = gbmSeries(300, 0.0005, 0.015, 3);
  const f = A.arForecast(closes, 21);
  assert.strictEqual(f.path.length, 21);
  for (const step of f.path) assert.ok(step.lo < step.mean && step.mean < step.hi);
  assert.ok(f.p >= 1 && f.p <= 8);
});

test('solveLinear solves 3x3', () => {
  const x = A.solveLinear(
    [[2, 1, 1], [1, 3, 2], [1, 0, 0]],
    [4, 5, 6]
  );
  near(x[0], 6, 1e-9);
  near(2 * x[0] + x[1] + x[2], 4, 1e-9);
});

test('mlSignal trains and reports sane numbers', () => {
  const closes = gbmSeries(600, 0.0004, 0.015, 21);
  const s = A.mlSignal(closes);
  assert.ok(s.probUp > 0 && s.probUp < 1);
  assert.ok(s.testAccuracy >= 0 && s.testAccuracy <= 1);
  assert.ok(s.nTrain > s.nTest);
});

// ---- cross-asset ------------------------------------------------------------
test('corr of identical series = 1, inverted = -1', () => {
  const a = A.logReturns(gbmSeries(200, 0, 0.02, 5));
  near(A.corr(a, a), 1, 1e-12);
  near(A.corr(a, a.map((v) => -v)), -1, 1e-12);
});

test('corrMatrix symmetric with unit diagonal', () => {
  const a = A.logReturns(gbmSeries(200, 0, 0.02, 5));
  const b = A.logReturns(gbmSeries(200, 0, 0.02, 6));
  const cm = A.corrMatrix({ A: a, B: b });
  near(cm.matrix[0][0], 1, 1e-12);
  near(cm.matrix[0][1], cm.matrix[1][0], 1e-12);
});

test('betaAlpha of scaled series', () => {
  const bench = A.logReturns(gbmSeries(300, 0, 0.01, 9));
  const asset = bench.map((v) => 1.5 * v);
  const ba = A.betaAlpha(asset, bench);
  near(ba.beta, 1.5, 1e-9);
  near(ba.r2, 1, 1e-9);
});

test('alignSeries intersects timestamps', () => {
  const day = 86400;
  const out = A.alignSeries({
    X: { t: [day, 2 * day, 3 * day], c: [1, 2, 3] },
    Y: { t: [2 * day, 3 * day, 4 * day], c: [20, 30, 40] }
  });
  assert.deepStrictEqual(out.t, [2 * day, 3 * day]);
  assert.deepStrictEqual(out.closes.X, [2, 3]);
  assert.deepStrictEqual(out.closes.Y, [20, 30]);
});

test('spreadAnalysis detects mean reversion in a stationary spread', () => {
  // B is a noisy multiple of A -> spread is stationary AR-ish noise.
  const a = gbmSeries(400, 0.0002, 0.01, 13);
  const rand = mulberry32(99);
  const b = a.map((v) => v * 2 * Math.exp((rand() - 0.5) * 0.02));
  const pa = A.spreadAnalysis(a, b);
  assert.ok(Math.abs(pa.hedgeRatio - 1) < 0.1); // log-log slope ~ 1
  assert.ok(isFinite(pa.halfLife) && pa.halfLife > 0 && pa.halfLife < 30);
  assert.ok(pa.lambdaT < -3);
});

// ---- portfolio --------------------------------------------------------------
test('cov(a,a) equals variance', () => {
  const a = A.logReturns(gbmSeries(200, 0, 0.02, 41));
  near(A.cov(a, a), A.variance(a), 1e-15);
});

test('portfolioReturns is the weighted sum', () => {
  const a = [0.01, -0.02, 0.03];
  const b = [0.02, 0.02, -0.01];
  const rp = A.portfolioReturns({ A: a, B: b }, { A: 0.6, B: 0.4 });
  near(rp[0], 0.6 * 0.01 + 0.4 * 0.02, 1e-15);
  near(rp[2], 0.6 * 0.03 + 0.4 * -0.01, 1e-15);
});

test('riskContributions sum to 1 and split identical assets evenly', () => {
  const a = A.logReturns(gbmSeries(300, 0, 0.02, 43));
  const b = A.logReturns(gbmSeries(300, 0, 0.02, 44));
  const rc = A.riskContributions({ A: a, B: b }, { A: 0.7, B: 0.3 });
  near(rc.contribs.A + rc.contribs.B, 1, 1e-9);
  const rcSame = A.riskContributions({ A: a, B: a.slice() }, { A: 0.5, B: 0.5 });
  near(rcSame.contribs.A, 0.5, 1e-9);
  near(rcSame.contribs.B, 0.5, 1e-9);
});

test('diversificationMetrics: effective N and ratio behave', () => {
  const a = A.logReturns(gbmSeries(400, 0, 0.02, 45));
  const b = A.logReturns(gbmSeries(400, 0, 0.02, 46));
  const d = A.diversificationMetrics({ A: a, B: b }, { A: 0.5, B: 0.5 });
  near(d.effectiveN, 2, 1e-12);
  assert.ok(d.diversificationRatio > 1.15); // independent assets diversify
  const same = A.diversificationMetrics({ A: a, B: a.slice() }, { A: 0.5, B: 0.5 });
  near(same.diversificationRatio, 1, 1e-9); // perfectly correlated: no benefit
});

// ---- Bayes ------------------------------------------------------------------
test('posteriorReturns centers on sample mean with weak prior', () => {
  const r = A.logReturns(gbmSeries(500, 0.001, 0.01, 17));
  const post = B.posteriorReturns(r);
  near(post.muDaily.mean, A.mean(r), 1e-5);
  assert.ok(post.muDaily.lo < post.muDaily.mean && post.muDaily.mean < post.muDaily.hi);
  assert.ok(post.probPositive > 0.5); // positive drift series
  near(post.sigmaDaily, A.std(r), 2e-3);
});

test('posteriorReturns probPositive ~ 1 for strong drift', () => {
  const r = Array.from({ length: 300 }, () => 0.002 + (Math.sin(Math.random()) - 0.45) * 1e-4);
  const post = B.posteriorReturns(r);
  assert.ok(post.probPositive > 0.99);
});

test('bayesTrend recovers deterministic slope, fan widens', () => {
  const closes = Array.from({ length: 300 }, (_, i) => 100 * Math.exp(0.001 * i));
  const tr = B.bayesTrend(closes, 30, { window: 252 });
  near(tr.slopeDaily.mean, 0.001, 1e-8);
  assert.ok(tr.probPositive > 0.999);
  const w1 = tr.fan[0].hi - tr.fan[0].lo;
  const w30 = tr.fan[29].hi - tr.fan[29].lo;
  assert.ok(w30 > w1);
});

test('monteCarlo reproducible, bands ordered, prob sane', () => {
  const closes = gbmSeries(300, 0.0005, 0.015, 23);
  const mc1 = B.monteCarlo(closes, 21, { nPaths: 500, seed: 7 });
  const mc2 = B.monteCarlo(closes, 21, { nPaths: 500, seed: 7 });
  near(mc1.bands.p50[20], mc2.bands.p50[20], 1e-12); // seeded => identical
  for (let j = 0; j < 21; j++) {
    assert.ok(mc1.bands.p5[j] < mc1.bands.p50[j] && mc1.bands.p50[j] < mc1.bands.p95[j]);
  }
  assert.ok(mc1.probUp > 0 && mc1.probUp < 1);
});

test('describe bundle is coherent', () => {
  const closes = gbmSeries(400, 0.0004, 0.012, 31);
  const d = A.describe(closes);
  assert.strictEqual(d.nReturns, 399);
  near(d.annVol, A.std(A.logReturns(closes)) * Math.sqrt(252), 1e-9);
  assert.ok(d.maxDrawdown.dd <= 0);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}.`);
