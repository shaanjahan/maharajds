// Macro Maha — Bayesian analytics + Monte Carlo simulation.
// Conjugate Normal-Inverse-Gamma inference on returns, Bayesian linear
// regression on the log-price trend (with proper Student-t predictive bands),
// and seeded GBM Monte Carlo. Loads in the renderer and in Node for tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./analytics.js'));
  } else {
    root.Bayes = factory(root.Analytics);
  }
})(typeof self !== 'undefined' ? self : this, function (A) {
  'use strict';

  const DAYS = A.TRADING_DAYS;

  // ---- Bayesian inference on daily log returns ------------------------------
  // Model: r_t ~ N(mu, sigma^2), conjugate NIG prior (weak by default).
  // Marginal posterior of mu is Student-t with 2*an degrees of freedom.
  function posteriorReturns(returns, opts) {
    opts = opts || {};
    const m0 = opts.m0 != null ? opts.m0 : 0; // prior mean of mu
    const k0 = opts.k0 != null ? opts.k0 : 1e-3; // prior pseudo-observations
    const a0 = opts.a0 != null ? opts.a0 : 1e-3;
    const b0 = opts.b0 != null ? opts.b0 : 1e-3;
    const level = opts.level || 0.95;

    const n = returns.length;
    if (n < 10) throw new Error('posteriorReturns: need at least 10 returns');
    const ybar = A.mean(returns);
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (returns[i] - ybar) * (returns[i] - ybar);

    const kn = k0 + n;
    const mn = (k0 * m0 + n * ybar) / kn;
    const an = a0 + n / 2;
    const bn = b0 + 0.5 * ss + (k0 * n * (ybar - m0) * (ybar - m0)) / (2 * kn);

    const df = 2 * an;
    const scaleMu = Math.sqrt(bn / (an * kn)); // scale of t marginal for mu
    const tq = A.tQuantile(1 - (1 - level) / 2, df);

    // P(mu > 0) under the Student-t marginal.
    const probPositive = 1 - A.tCDF((0 - mn) / scaleMu, df);

    // Posterior mean of sigma^2 = bn / (an - 1).
    const sig2 = an > 1 ? bn / (an - 1) : bn / an;
    const sigDaily = Math.sqrt(sig2);

    // One-day-ahead predictive: t_df(mn, bn*(kn+1)/(an*kn)).
    const scalePred = Math.sqrt((bn * (kn + 1)) / (an * kn));

    return {
      n,
      df,
      muDaily: { mean: mn, lo: mn - tq * scaleMu, hi: mn + tq * scaleMu },
      muAnnual: {
        mean: mn * DAYS,
        lo: (mn - tq * scaleMu) * DAYS,
        hi: (mn + tq * scaleMu) * DAYS
      },
      probPositive,
      sigmaDaily: sigDaily,
      sigmaAnnual: sigDaily * Math.sqrt(DAYS),
      predictiveNextDay: {
        mean: mn,
        lo: mn - tq * scalePred,
        hi: mn + tq * scalePred
      },
      level
    };
  }

  // ---- Bayesian linear trend on log price -----------------------------------
  // y = a + b*t + eps with the reference (noninformative) prior, so the
  // posterior of b is t_{n-2}(b_ols, se^2) and the predictive at t* is
  // t_{n-2}(yhat*, s^2 * (1 + 1/n + (t*-tbar)^2/Sxx)) — a genuinely widening fan.
  function bayesTrend(closes, h, opts) {
    opts = opts || {};
    const level = opts.level || 0.95;
    const window = Math.min(opts.window || 252, closes.length);
    const y = closes.slice(-window).map(Math.log);
    const x = y.map((_, i) => i);
    const fit = A.ols(x, y);
    const n = fit.n;
    const df = n - 2;
    const tq = A.tQuantile(1 - (1 - level) / 2, df);
    const s = Math.sqrt(fit.sigma2);

    const slope = {
      mean: fit.slope,
      lo: fit.slope - tq * fit.seSlope,
      hi: fit.slope + tq * fit.seSlope
    };
    const probPositive = 1 - A.tCDF((0 - fit.slope) / fit.seSlope, df);

    const fan = [];
    const lastIdx = x[x.length - 1];
    for (let j = 1; j <= h; j++) {
      const xstar = lastIdx + j;
      const yhat = fit.intercept + fit.slope * xstar;
      const lever = 1 + 1 / n + ((xstar - fit.mx) * (xstar - fit.mx)) / fit.sxx;
      const w = tq * s * Math.sqrt(lever);
      fan.push({ mean: Math.exp(yhat), lo: Math.exp(yhat - w), hi: Math.exp(yhat + w) });
    }

    // In-sample fitted trend (price space) for overlaying on the chart.
    const fitted = x.map((xi) => Math.exp(fit.intercept + fit.slope * xi));

    return {
      window,
      n,
      df,
      r2: fit.r2,
      residSigma: s,
      slopeDaily: slope,
      driftAnnual: {
        mean: slope.mean * DAYS,
        lo: slope.lo * DAYS,
        hi: slope.hi * DAYS
      },
      probPositive,
      fan,
      fitted,
      level
    };
  }

  // ---- Monte Carlo (GBM on log returns, seeded + reproducible) --------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function monteCarlo(closes, h, opts) {
    opts = opts || {};
    const nPaths = opts.nPaths || 2000;
    const seed = opts.seed != null ? opts.seed : 42;
    const r = A.logReturns(closes);
    if (r.length < 30) throw new Error('monteCarlo: need at least 30 returns');
    const mu = A.mean(r);
    const sd = A.std(r);
    const s0 = closes[closes.length - 1];

    const rand = mulberry32(seed);
    // Box–Muller.
    let spare = null;
    function gauss() {
      if (spare != null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u = 0;
      let v = 0;
      while (u === 0) u = rand();
      v = rand();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    }

    // logs[j][k] = log price of path k at step j+1
    const steps = Array.from({ length: h }, () => new Float64Array(nPaths));
    for (let k = 0; k < nPaths; k++) {
      let lp = Math.log(s0);
      for (let j = 0; j < h; j++) {
        lp += mu + sd * gauss();
        steps[j][k] = lp;
      }
    }

    function pct(arr, p) {
      const a = Array.from(arr).sort((u, v) => u - v);
      const idx = p * (a.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
    }

    const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    for (let j = 0; j < h; j++) {
      bands.p5.push(Math.exp(pct(steps[j], 0.05)));
      bands.p25.push(Math.exp(pct(steps[j], 0.25)));
      bands.p50.push(Math.exp(pct(steps[j], 0.5)));
      bands.p75.push(Math.exp(pct(steps[j], 0.75)));
      bands.p95.push(Math.exp(pct(steps[j], 0.95)));
    }

    const terminal = steps[h - 1];
    let above = 0;
    let sum = 0;
    for (let k = 0; k < nPaths; k++) {
      const price = Math.exp(terminal[k]);
      if (price > s0) above++;
      sum += price;
    }

    return {
      nPaths,
      horizon: h,
      muDaily: mu,
      sigmaDaily: sd,
      s0,
      bands,
      probUp: above / nPaths,
      expectedTerminal: sum / nPaths,
      terminalP5: Math.exp(pct(terminal, 0.05)),
      terminalP95: Math.exp(pct(terminal, 0.95))
    };
  }

  return { posteriorReturns, bayesTrend, monteCarlo };
});
