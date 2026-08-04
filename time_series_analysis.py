"""
Time series analysis toolkit for annual data.

Takes a pandas DataFrame with a numeric "Value" column and a "Year" column
and produces a full analytical workup:

  * Trend analysis        — OLS fit, Mann-Kendall test, Sen's slope
  * Growth rates          — year-over-year, CAGR, rolling growth, acceleration
  * Outlier analysis      — IQR, modified z-score (MAD), detrended residuals
  * Bayesian analysis     — conjugate Bayesian linear regression with
                            posterior credible intervals, P(trend > 0),
                            and a five-year posterior predictive forecast
  * Change-point detection — binary segmentation with a BIC-style penalty
  * Visualization         — dark-theme chart with the series in teal and
                            key events (outliers, change points, peak,
                            trough, latest value) highlighted

Dependencies: numpy, pandas, matplotlib, scipy.

Usage:
    from time_series_analysis import TimeSeriesAnalyzer

    tsa = TimeSeriesAnalyzer(df)            # expects "Year" and "Value"
    results = tsa.run_full_analysis()       # prints report, shows chart
    tsa.plot(save_path="series.png")        # chart only

    # Custom column names:
    tsa = TimeSeriesAnalyzer(df, value_col="GDP", year_col="Period")
"""

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import stats


DARK = {
    "page": "#0b0e13",
    "surface": "#101418",
    "ink": "#f2f5f7",
    "ink_secondary": "#c3c2b7",
    "ink_muted": "#898781",
    "grid": "#232a31",
    "baseline": "#383835",
    "series": "#2dd4bf",
    "band": "#2dd4bf",
    "trend": "#9085e9",
    "outlier": "#eda100",
    "changepoint": "#d55181",
}


class TimeSeriesAnalyzer:
    """Full analytical workup for a single annual time series."""

    def __init__(self, df, value_col="Value", year_col="Year"):
        if value_col not in df.columns or year_col not in df.columns:
            raise ValueError(
                f"DataFrame must contain columns '{year_col}' and '{value_col}'. "
                f"Found: {list(df.columns)}"
            )
        data = df[[year_col, value_col]].copy()
        data[year_col] = pd.to_numeric(data[year_col], errors="coerce")
        data[value_col] = pd.to_numeric(data[value_col], errors="coerce")
        data = data.dropna()
        # Collapse duplicate years to their mean so the series is strictly ordered
        data = data.groupby(year_col, as_index=False)[value_col].mean()
        data = data.sort_values(year_col).reset_index(drop=True)
        if len(data) < 4:
            raise ValueError(
                f"Need at least 4 valid observations, got {len(data)}."
            )
        self.value_col = value_col
        self.year_col = year_col
        self.years = data[year_col].to_numpy(dtype=float)
        self.values = data[value_col].to_numpy(dtype=float)
        self.n = len(data)
        self._results = {}

    # ------------------------------------------------------------------
    # Trend analysis
    # ------------------------------------------------------------------

    def trend_analysis(self):
        """OLS trend, Mann-Kendall test, and Sen's slope."""
        y, v, n = self.years, self.values, self.n

        ols = stats.linregress(y, v)

        # Mann-Kendall S statistic with tie-corrected variance
        s = 0
        for i in range(n - 1):
            s += np.sign(v[i + 1:] - v[i]).sum()
        _, tie_counts = np.unique(v, return_counts=True)
        var_s = (
            n * (n - 1) * (2 * n + 5)
            - (tie_counts * (tie_counts - 1) * (2 * tie_counts + 5)).sum()
        ) / 18.0
        if s > 0:
            z_mk = (s - 1) / np.sqrt(var_s)
        elif s < 0:
            z_mk = (s + 1) / np.sqrt(var_s)
        else:
            z_mk = 0.0
        p_mk = 2 * (1 - stats.norm.cdf(abs(z_mk)))

        # Sen's slope: median of all pairwise slopes (robust to outliers)
        pairwise = [
            (v[j] - v[i]) / (y[j] - y[i])
            for i in range(n - 1)
            for j in range(i + 1, n)
            if y[j] != y[i]
        ]
        sen_slope = float(np.median(pairwise))
        sen_intercept = float(np.median(v - sen_slope * y))

        tau, p_tau = stats.kendalltau(y, v)

        if p_mk < 0.05:
            direction = "increasing" if s > 0 else "decreasing"
            verdict = f"statistically significant {direction} trend"
        else:
            verdict = "no statistically significant monotonic trend"

        result = {
            "ols_slope": ols.slope,
            "ols_intercept": ols.intercept,
            "ols_r_squared": ols.rvalue ** 2,
            "ols_p_value": ols.pvalue,
            "ols_std_err": ols.stderr,
            "mann_kendall_s": int(s),
            "mann_kendall_z": z_mk,
            "mann_kendall_p": p_mk,
            "kendall_tau": tau,
            "sen_slope": sen_slope,
            "sen_intercept": sen_intercept,
            "verdict": verdict,
        }
        self._results["trend"] = result
        return result

    # ------------------------------------------------------------------
    # Growth rates
    # ------------------------------------------------------------------

    def growth_rates(self):
        """Year-over-year growth, CAGR, rolling growth, and acceleration."""
        y, v = self.years, self.values
        gaps = np.diff(y)
        yoy = np.full(self.n - 1, np.nan)
        for i in range(self.n - 1):
            prev, curr, gap = v[i], v[i + 1], gaps[i]
            if prev > 0 and curr > 0 and gap >= 1:
                # Annualize across any gap in the yearly record
                yoy[i] = (curr / prev) ** (1.0 / gap) - 1.0
            elif prev != 0:
                yoy[i] = (curr - prev) / abs(prev) / gap

        span = y[-1] - y[0]
        if v[0] > 0 and v[-1] > 0 and span > 0:
            cagr = (v[-1] / v[0]) ** (1.0 / span) - 1.0
        else:
            cagr = None

        valid = yoy[~np.isnan(yoy)]
        window = max(3, self.n // 5)
        rolling = (
            pd.Series(yoy).rolling(window, min_periods=window).mean().to_numpy()
        )

        # Acceleration: OLS slope of the second half minus the first half
        mid = self.n // 2
        first = stats.linregress(y[: mid + 1], v[: mid + 1]).slope
        second = stats.linregress(y[mid:], v[mid:]).slope
        accel = second - first

        result = {
            "yoy_growth": yoy,
            "yoy_years": y[1:],
            "mean_growth": float(valid.mean()) if valid.size else None,
            "median_growth": float(np.median(valid)) if valid.size else None,
            "growth_volatility": float(valid.std(ddof=1)) if valid.size > 1 else None,
            "cagr": cagr,
            "rolling_growth": rolling,
            "rolling_window": window,
            "first_half_slope": first,
            "second_half_slope": second,
            "acceleration": accel,
            "best_year": (float(y[1:][np.nanargmax(yoy)]), float(np.nanmax(yoy)))
            if valid.size
            else None,
            "worst_year": (float(y[1:][np.nanargmin(yoy)]), float(np.nanmin(yoy)))
            if valid.size
            else None,
        }
        self._results["growth"] = result
        return result

    # ------------------------------------------------------------------
    # Outlier analysis
    # ------------------------------------------------------------------

    def outlier_analysis(self, hampel_window=5, hampel_threshold=3.0):
        """Flag outliers by IQR, modified z-score, and a Hampel filter.

        The Hampel filter compares each point with a centered rolling median,
        so one-off shocks stand out while trends and level shifts do not.
        A point is a *consensus* outlier when at least two methods agree, and
        the chart highlights consensus and Hampel hits.
        """
        v = self.values

        q1, q3 = np.percentile(v, [25, 75])
        iqr = q3 - q1
        iqr_mask = (v < q1 - 1.5 * iqr) | (v > q3 + 1.5 * iqr)

        med = np.median(v)
        mad = np.median(np.abs(v - med))
        if mad > 0:
            mod_z = 0.6745 * (v - med) / mad
            z_mask = np.abs(mod_z) > 3.5
        else:
            mod_z = np.zeros_like(v)
            z_mask = np.zeros(self.n, dtype=bool)

        roll_med = (
            pd.Series(v).rolling(hampel_window, center=True, min_periods=2)
            .median().to_numpy()
        )
        resid = v - roll_med
        # Scale by a trend-robust noise estimate from first differences; the
        # residuals' own MAD understates noise because the window contains
        # the point it is testing.
        d = np.diff(v)
        noise = 1.4826 * np.median(np.abs(d - np.median(d))) / np.sqrt(2)
        if noise <= 0:
            noise = max(float(np.std(resid, ddof=1)), 1e-12)
        resid_z = resid / noise
        resid_mask = np.abs(resid_z) > hampel_threshold

        votes = iqr_mask.astype(int) + z_mask.astype(int) + resid_mask.astype(int)
        consensus = votes >= 2

        def _pack(mask):
            return [
                {"year": float(self.years[i]), "value": float(v[i])}
                for i in np.where(mask)[0]
            ]

        result = {
            "iqr_outliers": _pack(iqr_mask),
            "zscore_outliers": _pack(z_mask),
            "hampel_outliers": _pack(resid_mask),
            "consensus_outliers": _pack(consensus),
            "consensus_mask": consensus,
            "hampel_mask": resid_mask,
            "modified_z": mod_z,
            "hampel_z": resid_z,
        }
        self._results["outliers"] = result
        return result

    # ------------------------------------------------------------------
    # Bayesian analysis
    # ------------------------------------------------------------------

    def bayesian_analysis(self, n_samples=20000, cred_level=0.95, forecast_years=5,
                          seed=42):
        """Bayesian linear regression under the noninformative Jeffreys prior.

        With prior p(beta, sigma^2) proportional to 1/sigma^2 the posterior is
        available in closed form: sigma^2 is inverse-gamma and beta | sigma^2
        is Gaussian, so exact posterior draws need no MCMC. Reports credible
        intervals for the slope, the posterior probability the trend is
        positive, a credible band for the mean trend, and a posterior
        predictive forecast.
        """
        rng = np.random.default_rng(seed)
        y, v, n = self.years, self.values, self.n
        t = y - y.mean()
        X = np.column_stack([np.ones(n), t])
        k = X.shape[1]

        XtX_inv = np.linalg.inv(X.T @ X)
        beta_hat = XtX_inv @ X.T @ v
        resid = v - X @ beta_hat
        dof = n - k
        s2 = float(resid @ resid) / dof

        # sigma^2 | data ~ Inv-Gamma(dof/2, dof*s2/2); beta | sigma^2 ~ Normal
        sigma2 = dof * s2 / rng.chisquare(dof, size=n_samples)
        chol = np.linalg.cholesky(XtX_inv)
        z = rng.standard_normal((n_samples, k))
        betas = beta_hat + np.sqrt(sigma2)[:, None] * (z @ chol.T)

        slopes = betas[:, 1]
        alpha = 1 - cred_level
        lo, hi = 100 * alpha / 2, 100 * (1 - alpha / 2)

        mean_draws = betas @ np.column_stack([np.ones(n), t]).T
        band_lo = np.percentile(mean_draws, lo, axis=0)
        band_hi = np.percentile(mean_draws, hi, axis=0)
        band_mid = np.percentile(mean_draws, 50, axis=0)

        step = np.median(np.diff(y)) if n > 1 else 1.0
        fut_years = y[-1] + step * np.arange(1, forecast_years + 1)
        fut_t = fut_years - y.mean()
        fut_X = np.column_stack([np.ones(forecast_years), fut_t])
        fut_mean = betas @ fut_X.T
        fut_pred = fut_mean + np.sqrt(sigma2)[:, None] * rng.standard_normal(
            (n_samples, forecast_years)
        )

        result = {
            "slope_mean": float(slopes.mean()),
            "slope_median": float(np.median(slopes)),
            "slope_ci": (float(np.percentile(slopes, lo)),
                         float(np.percentile(slopes, hi))),
            "prob_positive_trend": float((slopes > 0).mean()),
            "prob_negative_trend": float((slopes < 0).mean()),
            "sigma_mean": float(np.sqrt(sigma2).mean()),
            "cred_level": cred_level,
            "trend_band_years": y,
            "trend_band_low": band_lo,
            "trend_band_mid": band_mid,
            "trend_band_high": band_hi,
            "forecast_years": fut_years,
            "forecast_median": np.percentile(fut_pred, 50, axis=0),
            "forecast_low": np.percentile(fut_pred, lo, axis=0),
            "forecast_high": np.percentile(fut_pred, hi, axis=0),
        }
        self._results["bayesian"] = result
        return result

    # ------------------------------------------------------------------
    # Change-point detection
    # ------------------------------------------------------------------

    def change_point_detection(self, penalty_scale=3.0, min_segment=3,
                               max_changepoints=5, detrend=True):
        """Detect level shifts by binary segmentation with a BIC-style penalty.

        With ``detrend=True`` (default) the search runs on the series minus
        its Sen's-slope trend line, so a steady trend is not itself reported
        as a stack of change points — only genuine structural breaks are.
        A split is accepted only when the reduction in within-segment squared
        error exceeds ``penalty_scale * sigma^2 * log(n)``, where sigma^2 is a
        trend-robust noise estimate from first differences. Larger
        ``penalty_scale`` means fewer, stronger change points.
        """
        y, n = self.years, self.n
        if detrend:
            trend = self._results.get("trend") or self.trend_analysis()
            v = self.values - (trend["sen_intercept"] + trend["sen_slope"] * y)
        else:
            v = self.values
        diffs = np.diff(v)
        sigma2 = float(np.var(diffs, ddof=1)) / 2.0 if len(diffs) > 1 else 1.0
        if sigma2 <= 0:
            sigma2 = max(float(np.var(v, ddof=1)), 1e-12)
        penalty = penalty_scale * sigma2 * np.log(n)

        def sse(a, b):
            seg = v[a:b]
            return float(((seg - seg.mean()) ** 2).sum())

        def best_split(a, b):
            best_gain, best_idx = -np.inf, None
            for i in range(a + min_segment, b - min_segment + 1):
                gain = sse(a, b) - sse(a, i) - sse(i, b)
                if gain > best_gain:
                    best_gain, best_idx = gain, i
            return best_gain, best_idx

        breakpoints = []
        queue = [(0, n)]
        while queue and len(breakpoints) < max_changepoints:
            a, b = queue.pop(0)
            if b - a < 2 * min_segment:
                continue
            gain, idx = best_split(a, b)
            if idx is not None and gain > penalty:
                breakpoints.append(idx)
                queue.append((a, idx))
                queue.append((idx, b))
        breakpoints.sort()

        segments = []
        bounds = [0] + breakpoints + [n]
        for a, b in zip(bounds[:-1], bounds[1:]):
            segments.append({
                "start_year": float(y[a]),
                "end_year": float(y[b - 1]),
                "mean": float(self.values[a:b].mean()),
                "level_net_of_trend": float(v[a:b].mean()),
                "n_obs": b - a,
            })

        change_points = []
        for a, b, idx in zip(range(len(segments) - 1), range(1, len(segments)),
                             breakpoints):
            change_points.append({
                "year": float(y[idx]),
                "index": idx,
                "mean_before": segments[a]["mean"],
                "mean_after": segments[b]["mean"],
                "shift": (segments[b]["level_net_of_trend"]
                          - segments[a]["level_net_of_trend"]),
            })

        result = {
            "change_points": change_points,
            "segments": segments,
            "penalty": penalty,
            "noise_variance": sigma2,
            "detrended": detrend,
        }
        self._results["changepoints"] = result
        return result

    # ------------------------------------------------------------------
    # Descriptive statistics and diagnostics
    # ------------------------------------------------------------------

    def descriptive_statistics(self):
        v = self.values
        varies = v.std(ddof=1) > 0
        lag1 = (
            float(np.corrcoef(v[:-1], v[1:])[0, 1])
            if self.n > 2 and varies else np.nan
        )
        result = {
            "n_obs": self.n,
            "start_year": float(self.years[0]),
            "end_year": float(self.years[-1]),
            "mean": float(v.mean()),
            "median": float(np.median(v)),
            "std": float(v.std(ddof=1)),
            "min": (float(self.years[v.argmin()]), float(v.min())),
            "max": (float(self.years[v.argmax()]), float(v.max())),
            "skewness": float(stats.skew(v)) if varies else 0.0,
            "kurtosis": float(stats.kurtosis(v)) if varies else 0.0,
            "coef_variation": float(v.std(ddof=1) / v.mean()) if v.mean() != 0 else None,
            "lag1_autocorr": lag1,
        }
        self._results["descriptive"] = result
        return result

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def summary(self):
        """Return the full analysis as a formatted text report."""
        desc = self._results.get("descriptive") or self.descriptive_statistics()
        trend = self._results.get("trend") or self.trend_analysis()
        growth = self._results.get("growth") or self.growth_rates()
        outl = self._results.get("outliers") or self.outlier_analysis()
        bayes = self._results.get("bayesian") or self.bayesian_analysis()
        cps = self._results.get("changepoints") or self.change_point_detection()

        def pct(x):
            return "n/a" if x is None or np.isnan(x) else f"{x * 100:+.2f}%"

        lines = []
        w = 66
        lines.append("=" * w)
        lines.append("TIME SERIES ANALYSIS REPORT".center(w))
        lines.append(
            f"{self.value_col} by {self.year_col}, "
            f"{desc['start_year']:.0f}-{desc['end_year']:.0f} "
            f"({desc['n_obs']} obs)".center(w)
        )
        lines.append("=" * w)

        lines.append("\n-- Descriptive statistics " + "-" * (w - 26))
        lines.append(f"  Mean {desc['mean']:,.3f}   Median {desc['median']:,.3f}   "
                     f"Std {desc['std']:,.3f}")
        lines.append(f"  Min  {desc['min'][1]:,.3f} ({desc['min'][0]:.0f})   "
                     f"Max {desc['max'][1]:,.3f} ({desc['max'][0]:.0f})")
        lines.append(f"  Skewness {desc['skewness']:+.3f}   "
                     f"Kurtosis {desc['kurtosis']:+.3f}   "
                     f"Lag-1 autocorr {desc['lag1_autocorr']:+.3f}")

        lines.append("\n-- Trend analysis " + "-" * (w - 18))
        lines.append(f"  OLS slope        {trend['ols_slope']:+,.4f} per year "
                     f"(R^2 {trend['ols_r_squared']:.3f}, p {trend['ols_p_value']:.4g})")
        lines.append(f"  Sen's slope      {trend['sen_slope']:+,.4f} per year (robust)")
        lines.append(f"  Mann-Kendall     Z {trend['mann_kendall_z']:+.2f}, "
                     f"p {trend['mann_kendall_p']:.4g}, "
                     f"tau {trend['kendall_tau']:+.3f}")
        lines.append(f"  Verdict          {trend['verdict']}")

        lines.append("\n-- Growth rates " + "-" * (w - 16))
        lines.append(f"  CAGR             {pct(growth['cagr'])}")
        lines.append(f"  Mean YoY growth  {pct(growth['mean_growth'])}   "
                     f"Median {pct(growth['median_growth'])}")
        if growth["growth_volatility"] is not None:
            lines.append(f"  Growth volatility {growth['growth_volatility'] * 100:.2f} pp")
        if growth["best_year"]:
            by, bg = growth["best_year"]
            wy, wg = growth["worst_year"]
            lines.append(f"  Best year        {by:.0f} ({pct(bg)})   "
                         f"Worst {wy:.0f} ({pct(wg)})")
        accel_word = "accelerating" if growth["acceleration"] > 0 else "decelerating"
        lines.append(f"  Momentum         {accel_word} "
                     f"(slope {growth['first_half_slope']:+,.3f} -> "
                     f"{growth['second_half_slope']:+,.3f})")

        lines.append("\n-- Bayesian analysis " + "-" * (w - 21))
        ci = bayes["slope_ci"]
        lines.append(f"  Posterior slope  {bayes['slope_mean']:+,.4f} per year")
        lines.append(f"  {bayes['cred_level'] * 100:.0f}% credible int. "
                     f"[{ci[0]:+,.4f}, {ci[1]:+,.4f}]")
        lines.append(f"  P(trend > 0)     {bayes['prob_positive_trend'] * 100:.1f}%   "
                     f"P(trend < 0) {bayes['prob_negative_trend'] * 100:.1f}%")
        fy = bayes["forecast_years"]
        fm = bayes["forecast_median"]
        fl, fh = bayes["forecast_low"], bayes["forecast_high"]
        lines.append(f"  Forecast {fy[0]:.0f}    {fm[0]:,.3f} "
                     f"[{fl[0]:,.3f}, {fh[0]:,.3f}]")
        lines.append(f"  Forecast {fy[-1]:.0f}    {fm[-1]:,.3f} "
                     f"[{fl[-1]:,.3f}, {fh[-1]:,.3f}]")

        lines.append("\n-- Outlier analysis " + "-" * (w - 20))
        for name, key in [("IQR method", "iqr_outliers"),
                          ("Modified z-score", "zscore_outliers"),
                          ("Hampel filter", "hampel_outliers")]:
            pts = outl[key]
            desc_str = (", ".join(f"{p['year']:.0f} ({p['value']:,.2f})" for p in pts)
                        if pts else "none")
            lines.append(f"  {name:<19} {desc_str}")
        cons = outl["consensus_outliers"]
        cons_str = ", ".join("{:.0f}".format(p["year"]) for p in cons) or "none"
        lines.append(f"  Consensus (2+ methods) {cons_str}")

        lines.append("\n-- Change-point detection " + "-" * (w - 26))
        if cps["change_points"]:
            note = " (net of trend)" if cps["detrended"] else ""
            for cp in cps["change_points"]:
                lines.append(f"  {cp['year']:.0f}: level shift "
                             f"{cp['shift']:+,.3f}{note}, segment mean "
                             f"{cp['mean_before']:,.3f} -> {cp['mean_after']:,.3f}")
        else:
            lines.append("  No structural breaks detected at current penalty.")
        lines.append("=" * w)
        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Visualization
    # ------------------------------------------------------------------

    def plot(self, save_path=None, title=None, show=False, figsize=(12, 6.75),
             dpi=200):
        """Dark-theme chart: teal series, Bayesian credible band, robust trend
        line, and highlighted outliers, change points, peak, and trough."""
        desc = self._results.get("descriptive") or self.descriptive_statistics()
        trend = self._results.get("trend") or self.trend_analysis()
        growth = self._results.get("growth") or self.growth_rates()
        outl = self._results.get("outliers") or self.outlier_analysis()
        bayes = self._results.get("bayesian") or self.bayesian_analysis()
        cps = self._results.get("changepoints") or self.change_point_detection()

        y, v = self.years, self.values
        c = DARK

        fig, ax = plt.subplots(figsize=figsize, dpi=dpi)
        fig.patch.set_facecolor(c["page"])
        ax.set_facecolor(c["surface"])

        ax.fill_between(
            bayes["trend_band_years"], bayes["trend_band_low"],
            bayes["trend_band_high"], color=c["band"], alpha=0.12,
            linewidth=0, zorder=1,
            label=f"{bayes['cred_level'] * 100:.0f}% Bayesian credible band",
        )
        ax.plot(
            bayes["trend_band_years"], bayes["trend_band_mid"],
            color=c["trend"], linewidth=1.4, linestyle=(0, (5, 3)),
            alpha=0.9, zorder=2, label="Posterior mean trend",
        )
        ax.plot(
            y, v, color=c["series"], linewidth=2.2, zorder=4,
            solid_capstyle="round", label=self.value_col,
        )
        ax.plot(
            y, v, linestyle="none", marker="o", markersize=4.5,
            markerfacecolor=c["series"], markeredgecolor=c["surface"],
            markeredgewidth=1.2, zorder=5,
        )

        for i, cp in enumerate(cps["change_points"]):
            ax.axvline(
                cp["year"], color=c["changepoint"], linewidth=1.3,
                linestyle=(0, (3, 3)), alpha=0.85, zorder=3,
                label="Change point" if i == 0 else None,
            )
            ax.annotate(
                f"{cp['year']:.0f}", xy=(cp["year"], 1.0),
                xycoords=("data", "axes fraction"), xytext=(0, -2),
                textcoords="offset points", ha="center", va="top",
                fontsize=8.5, color=c["changepoint"], fontweight="bold",
            )

        mask = outl["consensus_mask"] | outl["hampel_mask"]
        if mask.any():
            ax.plot(
                y[mask], v[mask], linestyle="none", marker="D", markersize=8,
                markerfacecolor="none", markeredgecolor=c["outlier"],
                markeredgewidth=1.8, zorder=6, label="Outlier",
            )

        peak_yr, peak_val = desc["max"]
        trough_yr, trough_val = desc["min"]
        span = v.max() - v.min() or 1.0
        ax.annotate(
            f"Peak {peak_val:,.1f}", xy=(peak_yr, peak_val),
            xytext=(0, 11), textcoords="offset points", ha="center",
            fontsize=9, color=c["ink"], fontweight="bold",
        )
        ax.annotate(
            f"Trough {trough_val:,.1f}", xy=(trough_yr, trough_val),
            xytext=(0, -15), textcoords="offset points", ha="center",
            fontsize=9, color=c["ink"], fontweight="bold",
        )
        if y[-1] != peak_yr and y[-1] != trough_yr:
            ax.annotate(
                f"{v[-1]:,.1f}", xy=(y[-1], v[-1]), xytext=(8, 0),
                textcoords="offset points", ha="left", va="center",
                fontsize=9, color=c["series"], fontweight="bold",
            )

        ax.set_ylim(v.min() - 0.14 * span, v.max() + 0.14 * span)
        ax.set_xlabel(self.year_col, fontsize=10, color=c["ink_muted"])
        ax.set_ylabel(self.value_col, fontsize=10, color=c["ink_muted"])
        ax.grid(axis="y", color=c["grid"], linewidth=0.8)
        ax.set_axisbelow(True)
        for spine in ("top", "right", "left"):
            ax.spines[spine].set_visible(False)
        ax.spines["bottom"].set_color(c["baseline"])
        ax.tick_params(colors=c["ink_muted"], labelsize=9)
        for lab in ax.get_xticklabels() + ax.get_yticklabels():
            lab.set_fontfamily("DejaVu Sans")

        chart_title = title or f"{self.value_col} over time"
        pct_pos = bayes["prob_positive_trend"] * 100
        cagr_txt = (f"CAGR {growth['cagr'] * 100:+.1f}%  ·  "
                    if growth["cagr"] is not None else "")
        subtitle = (
            f"Sen's slope {trend['sen_slope']:+,.2f}/yr  ·  {cagr_txt}"
            f"P(positive trend) {pct_pos:.0f}%  ·  "
            f"{len(cps['change_points'])} change point(s)  ·  "
            f"{int(mask.sum())} outlier(s)"
        )
        ax.text(0, 1.115, chart_title, transform=ax.transAxes, fontsize=15,
                fontweight="bold", color=c["ink"], va="bottom")
        ax.text(0, 1.045, subtitle, transform=ax.transAxes, fontsize=9.5,
                color=c["ink_secondary"], va="bottom")

        leg = ax.legend(
            loc="upper left", frameon=False, fontsize=8.5,
            labelcolor=c["ink_secondary"], handlelength=1.8,
            borderaxespad=0.6, ncols=2, columnspacing=1.4,
        )
        for line in leg.get_lines():
            line.set_linewidth(2)

        fig.text(
            0.01, 0.012,
            "Band: Bayesian credible interval for the mean trend  ·  "
            "Outliers: Hampel filter + IQR / MAD z-score consensus  ·  "
            "Change points: binary segmentation, BIC penalty",
            fontsize=7.5, color=c["ink_muted"],
        )

        fig.subplots_adjust(left=0.075, right=0.97, top=0.86, bottom=0.13)
        if save_path:
            fig.savefig(save_path, dpi=dpi, facecolor=fig.get_facecolor(),
                        bbox_inches="tight")
        if show:
            plt.show()
        return fig

    # ------------------------------------------------------------------
    # One-call driver
    # ------------------------------------------------------------------

    def run_full_analysis(self, save_path=None, title=None, show=True,
                          print_report=True):
        """Run every analysis, print the report, draw the chart, and return
        all results in one dictionary."""
        self.descriptive_statistics()
        self.trend_analysis()
        self.growth_rates()
        self.outlier_analysis()
        self.bayesian_analysis()
        self.change_point_detection()
        if print_report:
            print(self.summary())
        fig = self.plot(save_path=save_path, title=title, show=show)
        return {**self._results, "figure": fig}


def analyze(df, value_col="Value", year_col="Year", save_path=None, title=None,
            show=True):
    """Convenience wrapper: full analysis of ``df`` in a single call."""
    return TimeSeriesAnalyzer(df, value_col, year_col).run_full_analysis(
        save_path=save_path, title=title, show=show
    )


if __name__ == "__main__":
    rng = np.random.default_rng(7)
    years = np.arange(1990, 2026)
    base = 100 + 2.4 * (years - years[0]) + rng.normal(0, 4, years.size)
    base[years >= 2008] -= 18          # structural break
    base[years >= 2015] += 30          # recovery and regime shift
    base[years == 2001] += 32          # positive shock
    base[years == 2020] -= 26          # negative shock
    demo = pd.DataFrame({"Year": years, "Value": base})

    results = analyze(
        demo,
        save_path="time_series_analysis_demo.png",
        title="Annual series with structural breaks",
        show=False,
    )
    print("\nChart saved to time_series_analysis_demo.png")
