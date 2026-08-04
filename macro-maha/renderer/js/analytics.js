// Macro Maha analytics engine — descriptive statistics, technical indicators,
// time-series models (Holt, AR(p)), risk measures and an ML direction signal.
// Pure JavaScript, no dependencies; loadable in the renderer (window.Analytics)
// and in Node for unit tests (module.exports).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analytics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TRADING_DAYS = 252;

  // ---- basic moments --------------------------------------------------------

  function mean(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i];
    return s / x.length;
  }

  function variance(x) {
    if (x.length < 2) return 0;
    const m = mean(x);
    let s = 0;
    for (let i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m);
    return s / (x.length - 1);
  }

  function std(x) {
    return Math.sqrt(variance(x));
  }

  function skewness(x) {
    const n = x.length;
    if (n < 3) return 0;
    const m = mean(x);
    const s = std(x);
    if (s === 0) return 0;
    let s3 = 0;
    for (let i = 0; i < n; i++) s3 += Math.pow((x[i] - m) / s, 3);
    return (n / ((n - 1) * (n - 2))) * s3;
  }

  function excessKurtosis(x) {
    const n = x.length;
    if (n < 4) return 0;
    const m = mean(x);
    const s = std(x);
    if (s === 0) return 0;
    let s4 = 0;
    for (let i = 0; i < n; i++) s4 += Math.pow((x[i] - m) / s, 4);
    const g2 =
      ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s4 -
      (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
    return g2;
  }

  function quantile(x, p) {
    const a = x.slice().sort((u, v) => u - v);
    if (!a.length) return NaN;
    const idx = p * (a.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return a[lo];
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  }

  function logReturns(closes) {
    const r = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > 0 && closes[i - 1] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
    }
    return r;
  }

  function acf(x, maxLag) {
    const n = x.length;
    const m = mean(x);
    let denom = 0;
    for (let i = 0; i < n; i++) denom += (x[i] - m) * (x[i] - m);
    const out = [];
    for (let k = 1; k <= maxLag; k++) {
      let num = 0;
      for (let i = k; i < n; i++) num += (x[i] - m) * (x[i - k] - m);
      out.push(denom === 0 ? 0 : num / denom);
    }
    return out;
  }

  // ---- distribution helpers -------------------------------------------------

  // Acklam's rational approximation of the standard normal inverse CDF.
  function normQuantile(p) {
    if (p <= 0 || p >= 1) throw new Error('normQuantile: p must be in (0,1)');
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416];
    const pl = 0.02425;
    let q, r;
    if (p < pl) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p <= 1 - pl) {
      q = p - 0.5;
      r = q * q;
      return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  function normCDF(z) {
    // Abramowitz–Stegun 7.1.26 via erf.
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const erf =
      1 -
      (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp((-z * z) / 2);
    return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
  }

  function gammaln(x) {
    // Lanczos approximation.
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += g[j] / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
  }

  function betacf(a, b, x) {
    // Continued fraction for the incomplete beta function (Numerical Recipes).
    const MAXIT = 200;
    const EPS = 3e-12;
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function incBeta(a, b, x) {
    // Regularized incomplete beta I_x(a, b).
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(
      gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x)
    );
    if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
    return 1 - (bt * betacf(b, a, 1 - x)) / b;
  }

  function tCDF(t, df) {
    if (!isFinite(t)) return t > 0 ? 1 : 0;
    const x = df / (df + t * t);
    const p = 0.5 * incBeta(df / 2, 0.5, x);
    return t >= 0 ? 1 - p : p;
  }

  function tQuantile(p, df) {
    if (p <= 0 || p >= 1) throw new Error('tQuantile: p must be in (0,1)');
    if (df > 200) return normQuantile(p);
    // Bisection on tCDF — slow-ish but exact and only used for small df.
    let lo = -150;
    let hi = 150;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (tCDF(mid, df) < p) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---- technical indicators -------------------------------------------------
  // All indicator arrays are aligned to the input (nulls where undefined).

  function sma(x, w) {
    const out = new Array(x.length).fill(null);
    let s = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i];
      if (i >= w) s -= x[i - w];
      if (i >= w - 1) out[i] = s / w;
    }
    return out;
  }

  function ema(x, w) {
    const out = new Array(x.length).fill(null);
    const k = 2 / (w + 1);
    let e = null;
    for (let i = 0; i < x.length; i++) {
      if (e === null) {
        if (i === w - 1) {
          let s = 0;
          for (let j = 0; j < w; j++) s += x[j];
          e = s / w;
          out[i] = e;
        }
      } else {
        e = x[i] * k + e * (1 - k);
        out[i] = e;
      }
    }
    return out;
  }

  function bollinger(x, w, k) {
    w = w || 20;
    k = k || 2;
    const mid = sma(x, w);
    const upper = new Array(x.length).fill(null);
    const lower = new Array(x.length).fill(null);
    for (let i = w - 1; i < x.length; i++) {
      const win = x.slice(i - w + 1, i + 1);
      const s = std(win);
      upper[i] = mid[i] + k * s;
      lower[i] = mid[i] - k * s;
    }
    return { mid, upper, lower };
  }

  function rsi(closes, w) {
    w = w || 14;
    const out = new Array(closes.length).fill(null);
    if (closes.length <= w) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= w; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    let avgGain = gain / w;
    let avgLoss = loss / w;
    out[w] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = w + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (w - 1) + Math.max(d, 0)) / w;
      avgLoss = (avgLoss * (w - 1) + Math.max(-d, 0)) / w;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function macd(closes, fast, slow, signalW) {
    fast = fast || 12;
    slow = slow || 26;
    signalW = signalW || 9;
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) =>
      ef[i] != null && es[i] != null ? ef[i] - es[i] : null
    );
    // Signal = EMA of the MACD line over its non-null tail.
    const start = line.findIndex((v) => v != null);
    const sig = new Array(closes.length).fill(null);
    if (start >= 0) {
      const tail = line.slice(start);
      const sigTail = ema(tail, signalW);
      for (let i = 0; i < sigTail.length; i++) sig[start + i] = sigTail[i];
    }
    const hist = line.map((v, i) =>
      v != null && sig[i] != null ? v - sig[i] : null
    );
    return { line, signal: sig, hist };
  }

  function maxDrawdown(closes) {
    let peak = -Infinity;
    let peakIdx = 0;
    let best = { dd: 0, peakIdx: 0, troughIdx: 0 };
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] > peak) {
        peak = closes[i];
        peakIdx = i;
      }
      const dd = peak > 0 ? closes[i] / peak - 1 : 0;
      if (dd < best.dd) best = { dd, peakIdx, troughIdx: i };
    }
    return best;
  }

  // ---- risk -----------------------------------------------------------------

  function varCvar(returns, level) {
    level = level || 0.95;
    const p = 1 - level;
    const hVar = quantile(returns, p); // e.g. 5th percentile daily return
    const tail = returns.filter((r) => r <= hVar);
    const cvar = tail.length ? mean(tail) : hVar;
    const m = mean(returns);
    const s = std(returns);
    const pVar = m + s * normQuantile(p);
    return { level, historicalVaR: hVar, cvar, parametricVaR: pVar };
  }

  // ---- regression -----------------------------------------------------------

  function ols(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 3) throw new Error('ols: need at least 3 points');
    const mx = mean(x.slice(0, n));
    const my = mean(y.slice(0, n));
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (x[i] - mx) * (x[i] - mx);
      sxy += (x[i] - mx) * (y[i] - my);
      syy += (y[i] - my) * (y[i] - my);
    }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const e = y[i] - (intercept + slope * x[i]);
      sse += e * e;
    }
    const sigma2 = sse / (n - 2);
    const seSlope = sxx === 0 ? Infinity : Math.sqrt(sigma2 / sxx);
    const r2 = syy === 0 ? 0 : 1 - sse / syy;
    return {
      slope,
      intercept,
      r2,
      seSlope,
      tSlope: seSlope > 0 ? slope / seSlope : 0,
      sigma2,
      sse,
      n,
      mx,
      sxx
    };
  }

  // OLS trend on log price vs. bar index.
  function linearTrend(closes) {
    const y = closes.map((c) => Math.log(c));
    const x = y.map((_, i) => i);
    const fit = ols(x, y);
    const fitted = x.map((xi) => Math.exp(fit.intercept + fit.slope * xi));
    return {
      fit,
      fitted,
      dailyDrift: fit.slope,
      annualDrift: fit.slope * TRADING_DAYS,
      pValue: 2 * (1 - tCDF(Math.abs(fit.tSlope), fit.n - 2))
    };
  }

  // ---- forecasting ----------------------------------------------------------

  // Holt's linear (double exponential) smoothing on log prices with a small
  // grid search over (alpha, beta). CI widths grow with sqrt(horizon) using
  // the one-step residual sigma — an approximation, clearly labeled in the UI.
  function holtForecast(closes, h, level) {
    level = level || 0.95;
    const y = closes.map((c) => Math.log(c));
    if (y.length < 20) throw new Error('holtForecast: need at least 20 points');
    const grid = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 0.95];
    let best = null;
    for (const alpha of grid) {
      for (const beta of grid) {
        let l = y[0];
        let b = y[1] - y[0];
        let sse = 0;
        for (let i = 1; i < y.length; i++) {
          const f = l + b;
          const e = y[i] - f;
          sse += e * e;
          const lPrev = l;
          l = alpha * y[i] + (1 - alpha) * (l + b);
          b = beta * (l - lPrev) + (1 - beta) * b;
        }
        if (!best || sse < best.sse) best = { alpha, beta, sse, l, b };
      }
    }
    const sigma = Math.sqrt(best.sse / (y.length - 1));
    const z = normQuantile(1 - (1 - level) / 2);
    const path = [];
    for (let j = 1; j <= h; j++) {
      const f = best.l + j * best.b;
      const w = z * sigma * Math.sqrt(j);
      path.push({ mean: Math.exp(f), lo: Math.exp(f - w), hi: Math.exp(f + w) });
    }
    return {
      alpha: best.alpha,
      beta: best.beta,
      sigma,
      dailyTrend: best.b,
      annualTrend: best.b * TRADING_DAYS,
      path
    };
  }

  // AR(p) on log returns, order chosen by AIC, forecast iterated h steps.
  function arForecast(closes, h, maxP, level) {
    maxP = maxP || 8;
    level = level || 0.95;
    const r = logReturns(closes);
    if (r.length < maxP + 20) maxP = Math.max(1, Math.floor(r.length / 4));
    if (r.length < 15) throw new Error('arForecast: not enough data');

    function fitAR(p) {
      const n = r.length - p;
      // Design matrix with intercept; solve normal equations via Gaussian elim.
      const k = p + 1;
      const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
      const Xty = new Array(k).fill(0);
      for (let t = p; t < r.length; t++) {
        const row = [1];
        for (let j = 1; j <= p; j++) row.push(r[t - j]);
        for (let a = 0; a < k; a++) {
          Xty[a] += row[a] * r[t];
          for (let b = 0; b < k; b++) XtX[a][b] += row[a] * row[b];
        }
      }
      const coef = solveLinear(XtX, Xty);
      if (!coef) return null;
      let sse = 0;
      for (let t = p; t < r.length; t++) {
        let f = coef[0];
        for (let j = 1; j <= p; j++) f += coef[j] * r[t - j];
        const e = r[t] - f;
        sse += e * e;
      }
      const aic = n * Math.log(sse / n) + 2 * k;
      return { p, coef, sse, n, aic };
    }

    let best = null;
    for (let p = 1; p <= maxP; p++) {
      const f = fitAR(p);
      if (f && (!best || f.aic < best.aic)) best = f;
    }
    if (!best) throw new Error('arForecast: fit failed');

    const sigma = Math.sqrt(best.sse / (best.n - best.coef.length));
    const z = normQuantile(1 - (1 - level) / 2);
    const hist = r.slice();
    const last = closes[closes.length - 1];
    let logP = Math.log(last);
    let cum = 0;
    const path = [];
    for (let j = 1; j <= h; j++) {
      let f = best.coef[0];
      for (let i = 1; i <= best.p; i++) f += best.coef[i] * hist[hist.length - i];
      hist.push(f);
      cum += f;
      logP = Math.log(last) + cum;
      const w = z * sigma * Math.sqrt(j); // approx: ignores AR error propagation
      path.push({ mean: Math.exp(logP), lo: Math.exp(logP - w), hi: Math.exp(logP + w) });
    }
    return { p: best.p, aic: best.aic, coef: best.coef, sigma, path };
  }

  function solveLinear(A, b) {
    // Gaussian elimination with partial pivoting. Returns null if singular.
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let rIdx = col + 1; rIdx < n; rIdx++) {
        if (Math.abs(M[rIdx][col]) > Math.abs(M[piv][col])) piv = rIdx;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let rIdx = 0; rIdx < n; rIdx++) {
        if (rIdx === col) continue;
        const f = M[rIdx][col] / M[col][col];
        for (let c = col; c <= n; c++) M[rIdx][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // ---- ML direction signal --------------------------------------------------
  // L2-regularized logistic regression on lagged returns + indicator features,
  // trained by gradient descent; chronological 80/20 train/test split so the
  // reported accuracy is out-of-sample.

  function mlSignal(closes, opts) {
    opts = opts || {};
    const lags = opts.lags || 5;
    const lambda = opts.lambda != null ? opts.lambda : 1e-3;
    const epochs = opts.epochs || 600;
    const lr = opts.lr || 0.1;

    const r = logReturns(closes);
    const rsi14 = rsi(closes, 14);
    const m = macd(closes);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);

    // Feature row describing day i (uses info up to close i), label = up/down of day i+1.
    const X = [];
    const Y = [];
    const firstOk = Math.max(lags, 50);
    for (let i = firstOk; i < closes.length - 1; i++) {
      const ri = i - 1; // r[ri] is the return ending at close i
      if (rsi14[i] == null || m.hist[i] == null || sma20[i] == null || sma50[i] == null) continue;
      const row = [];
      for (let j = 0; j < lags; j++) row.push(r[ri - j]);
      row.push(rsi14[i] / 100 - 0.5);
      row.push(m.hist[i] / closes[i]);
      row.push(closes[i] / sma20[i] - 1);
      row.push(closes[i] / sma50[i] - 1);
      const w10 = r.slice(Math.max(0, ri - 9), ri + 1);
      const w30 = r.slice(Math.max(0, ri - 29), ri + 1);
      const v30 = std(w30);
      row.push(v30 > 0 ? std(w10) / v30 - 1 : 0);
      X.push(row);
      Y.push(closes[i + 1] > closes[i] ? 1 : 0);
    }
    if (X.length < 60) throw new Error('mlSignal: not enough data');

    const nTrain = Math.floor(X.length * 0.8);
    const dims = X[0].length;

    // Standardize with training-set statistics only.
    const mu = new Array(dims).fill(0);
    const sd = new Array(dims).fill(0);
    for (let j = 0; j < dims; j++) {
      const col = X.slice(0, nTrain).map((row) => row[j]);
      mu[j] = mean(col);
      sd[j] = std(col) || 1;
    }
    const Z = X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));

    let w = new Array(dims).fill(0);
    let b = 0;
    const sig = (z) => 1 / (1 + Math.exp(-z));
    for (let e = 0; e < epochs; e++) {
      const gw = new Array(dims).fill(0);
      let gb = 0;
      for (let i = 0; i < nTrain; i++) {
        let z = b;
        for (let j = 0; j < dims; j++) z += w[j] * Z[i][j];
        const err = sig(z) - Y[i];
        for (let j = 0; j < dims; j++) gw[j] += err * Z[i][j];
        gb += err;
      }
      for (let j = 0; j < dims; j++) w[j] -= lr * (gw[j] / nTrain + lambda * w[j]);
      b -= lr * (gb / nTrain);
    }

    function predict(row) {
      let z = b;
      for (let j = 0; j < dims; j++) z += w[j] * row[j];
      return sig(z);
    }

    let correct = 0;
    let ups = 0;
    const nTest = Z.length - nTrain;
    for (let i = nTrain; i < Z.length; i++) {
      const p = predict(Z[i]);
      if ((p >= 0.5 ? 1 : 0) === Y[i]) correct++;
      if (Y[i] === 1) ups++;
    }

    // Live signal from the latest bar.
    const iLast = closes.length - 1;
    const riLast = r.length - 1;
    const live = [];
    for (let j = 0; j < lags; j++) live.push(r[riLast - j]);
    live.push(rsi14[iLast] / 100 - 0.5);
    live.push(m.hist[iLast] / closes[iLast]);
    live.push(closes[iLast] / sma20[iLast] - 1);
    live.push(closes[iLast] / sma50[iLast] - 1);
    const lw10 = r.slice(-10);
    const lw30 = r.slice(-30);
    const lv30 = std(lw30);
    live.push(lv30 > 0 ? std(lw10) / lv30 - 1 : 0);
    const liveZ = live.map((v, j) => (v - mu[j]) / sd[j]);

    return {
      probUp: predict(liveZ),
      testAccuracy: nTest ? correct / nTest : NaN,
      baseline: nTest ? Math.max(ups, nTest - ups) / nTest : NaN,
      nTrain,
      nTest,
      features: dims,
      weights: w.slice()
    };
  }

  // ---- cross-asset ----------------------------------------------------------

  // Align several daily series on their common timestamps.
  // seriesMap: { SYM: {t: [...unix], c: [...close]} } -> {t, closes: {SYM: [...]}}
  function alignSeries(seriesMap) {
    const syms = Object.keys(seriesMap);
    if (!syms.length) return { t: [], closes: {} };
    const daykey = (ts) => Math.floor(ts / 86400);
    const maps = syms.map((s) => {
      const m = new Map();
      const ser = seriesMap[s];
      for (let i = 0; i < ser.t.length; i++) m.set(daykey(ser.t[i]), ser.c[i]);
      return m;
    });
    const t = [];
    const closes = {};
    syms.forEach((s) => (closes[s] = []));
    const base = seriesMap[syms[0]];
    for (let i = 0; i < base.t.length; i++) {
      const k = daykey(base.t[i]);
      if (maps.every((m) => m.has(k))) {
        t.push(base.t[i]);
        syms.forEach((s, j) => closes[s].push(maps[j].get(k)));
      }
    }
    return { t, closes };
  }

  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    const ma = mean(a.slice(0, n));
    const mb = mean(b.slice(0, n));
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i++) {
      sab += (a[i] - ma) * (b[i] - mb);
      saa += (a[i] - ma) * (a[i] - ma);
      sbb += (b[i] - mb) * (b[i] - mb);
    }
    return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
  }

  function cov(a, b) {
    const n = Math.min(a.length, b.length);
    if (n < 2) return 0;
    const ma = mean(a.slice(0, n));
    const mb = mean(b.slice(0, n));
    let s = 0;
    for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
    return s / (n - 1);
  }

  // ---- portfolio analytics --------------------------------------------------
  // weights: {SYM: w} with Σw = 1; returnsMap arrays must be pre-aligned.

  function portfolioReturns(returnsMap, weights) {
    const syms = Object.keys(weights);
    const len = Math.min.apply(null, syms.map((s) => returnsMap[s].length));
    const rp = new Array(len).fill(0);
    for (const s of syms) {
      const r = returnsMap[s];
      const off = r.length - len; // align tails
      for (let t = 0; t < len; t++) rp[t] += weights[s] * r[off + t];
    }
    return rp;
  }

  // Fraction of portfolio variance contributed by each position:
  // RC_i = w_i * cov(r_i, r_p) / var(r_p); with fixed weights Σ RC_i = 1.
  function riskContributions(returnsMap, weights) {
    const rp = portfolioReturns(returnsMap, weights);
    const varP = variance(rp);
    const len = rp.length;
    const contribs = {};
    for (const s of Object.keys(weights)) {
      const r = returnsMap[s];
      contribs[s] = varP > 0 ? (weights[s] * cov(r.slice(r.length - len), rp)) / varP : 0;
    }
    return { varP, volDaily: Math.sqrt(varP), contribs };
  }

  function diversificationMetrics(returnsMap, weights) {
    const syms = Object.keys(weights);
    const rp = portfolioReturns(returnsMap, weights);
    const volP = std(rp);
    let wAvgVol = 0;
    let sumW2 = 0;
    for (const s of syms) {
      wAvgVol += weights[s] * std(returnsMap[s]);
      sumW2 += weights[s] * weights[s];
    }
    let pairSum = 0;
    let pairCount = 0;
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        pairSum += corr(returnsMap[syms[i]], returnsMap[syms[j]]);
        pairCount++;
      }
    }
    return {
      diversificationRatio: volP > 0 ? wAvgVol / volP : 1,
      effectiveN: sumW2 > 0 ? 1 / sumW2 : syms.length,
      avgPairCorr: pairCount ? pairSum / pairCount : 1
    };
  }

  function corrMatrix(returnsMap) {
    const syms = Object.keys(returnsMap);
    const m = syms.map(() => new Array(syms.length).fill(1));
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        const c = corr(returnsMap[syms[i]], returnsMap[syms[j]]);
        m[i][j] = c;
        m[j][i] = c;
      }
    }
    return { symbols: syms, matrix: m };
  }

  function betaAlpha(retAsset, retBench) {
    const fit = ols(retBench, retAsset);
    return {
      beta: fit.slope,
      alphaDaily: fit.intercept,
      alphaAnnual: fit.intercept * TRADING_DAYS,
      r2: fit.r2
    };
  }

  function rollingCorr(a, b, w) {
    const out = new Array(Math.min(a.length, b.length)).fill(null);
    for (let i = w - 1; i < out.length; i++) {
      out[i] = corr(a.slice(i - w + 1, i + 1), b.slice(i - w + 1, i + 1));
    }
    return out;
  }

  // Pair/spread analysis: hedge ratio by OLS, z-score of the spread and the
  // Ornstein–Uhlenbeck half-life of mean reversion.
  function spreadAnalysis(closesA, closesB) {
    const n = Math.min(closesA.length, closesB.length);
    const la = closesA.slice(0, n).map(Math.log);
    const lb = closesB.slice(0, n).map(Math.log);
    const fit = ols(lb, la); // log A = c + hedge * log B + spread
    const spread = la.map((v, i) => v - (fit.intercept + fit.slope * lb[i]));
    const ms = mean(spread);
    const ss = std(spread);
    const z = spread.map((v) => (ss > 0 ? (v - ms) / ss : 0));
    // Δs_t = λ s_{t-1} + ε ; half-life = -ln 2 / λ for λ < 0.
    const ds = [];
    const sLag = [];
    for (let i = 1; i < spread.length; i++) {
      ds.push(spread[i] - spread[i - 1]);
      sLag.push(spread[i - 1] - ms);
    }
    const rev = ols(sLag, ds);
    const halfLife = rev.slope < 0 ? Math.LN2 / -rev.slope : Infinity;
    const ra = logReturns(closesA.slice(0, n));
    const rb = logReturns(closesB.slice(0, n));
    return {
      hedgeRatio: fit.slope,
      r2: fit.r2,
      spread,
      z,
      zNow: z[z.length - 1],
      halfLife,
      lambdaT: rev.tSlope,
      corrReturns: corr(ra, rb)
    };
  }

  // ---- summary bundle used by the STAT panel --------------------------------

  function describe(closes, opts) {
    opts = opts || {};
    const rf = opts.riskFree || 0; // annual risk-free rate
    const r = logReturns(closes);
    const m = mean(r);
    const s = std(r);
    const annRet = m * TRADING_DAYS;
    const annVol = s * Math.sqrt(TRADING_DAYS);
    const dd = maxDrawdown(closes);
    const risk95 = varCvar(r, 0.95);
    const risk99 = varCvar(r, 0.99);
    const trend = linearTrend(closes);
    const rhos = acf(r, 10);
    return {
      n: closes.length,
      nReturns: r.length,
      meanDaily: m,
      stdDaily: s,
      annReturn: annRet,
      annVol,
      sharpe: annVol > 0 ? (annRet - rf) / annVol : 0,
      skew: skewness(r),
      kurtosis: excessKurtosis(r),
      maxDrawdown: dd,
      var95: risk95,
      var99: risk99,
      trend,
      acf: rhos,
      best: Math.max.apply(null, r),
      worst: Math.min.apply(null, r)
    };
  }

  return {
    TRADING_DAYS,
    mean,
    variance,
    std,
    skewness,
    excessKurtosis,
    quantile,
    logReturns,
    acf,
    normQuantile,
    normCDF,
    tCDF,
    tQuantile,
    gammaln,
    incBeta,
    sma,
    ema,
    bollinger,
    rsi,
    macd,
    maxDrawdown,
    varCvar,
    ols,
    solveLinear,
    linearTrend,
    holtForecast,
    arForecast,
    mlSignal,
    alignSeries,
    corr,
    cov,
    portfolioReturns,
    riskContributions,
    diversificationMetrics,
    corrMatrix,
    betaAlpha,
    rollingCorr,
    spreadAnalysis,
    describe
  };
});
