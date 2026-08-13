"""Outlier analysis for long-format industry panels (NAICS x Measure x Year).

The input is one row per observation with four columns:

    NAICS    industry code (string; leading zeros and hierarchy levels preserved)
    Measure  what is being measured (employment, value added, price index, ...)
    Value    the numeric column
    Year     the time index

Because measures carry different units and industries sit at different levels,
every statistic is computed *within* a (NAICS, Measure) series. Comparing a
motor-vehicle employment level against a price index would only ever tell you
that they are different measures.

Four detection methods:

    "mad"       modified z-score on the level, robust to the outliers it looks
                for (Iglewicz & Hoaglin 1993). Default.
    "iqr"       Tukey fences on the level.
    "residual"  modified z-score on residuals from a within-series linear trend.
                Use when a series grows steadily — a 2024 level is "high" by
                construction and "mad" will flag the end of every rising series.
    "yoy"       modified z-score on year-over-year percent change. Finds breaks
                rather than levels.

Usage:

    from outlier_analysis import analyze_outliers

    result = analyze_outliers("industry_panel.csv", method="residual")
    print(result.summary)
    result.outliers.head(20)
    result.save("figures/")

Requires pandas, numpy, matplotlib.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.figure import Figure
from matplotlib.ticker import MaxNLocator

__all__ = ["analyze_outliers", "detect_outliers", "plot_outliers", "OutlierResult"]

# Consistency constant: E[MAD] = 0.6745 * sigma for a normal distribution, so
# dividing by it puts the modified z-score on the same scale as a standard one.
_MAD_TO_SIGMA = 0.6745
# Same idea for the mean-absolute-deviation fallback used when MAD == 0.
_MEANAD_TO_SIGMA = 1.253314

METHODS = ("mad", "iqr", "residual", "yoy")

# --- palette -----------------------------------------------------------------
# Series color is categorical slot 1 (blue). Flagged points use the critical
# status color, which is what "outlier" means here — and they also carry a
# different marker with a surface ring, so identity never rests on color alone.
_THEMES: Mapping[str, Mapping[str, str]] = {
    "light": {
        "surface": "#fcfcfb",
        "text": "#0b0b0b",
        "muted": "#52514e",
        "grid": "#e6e5e1",
        "series": "#2a78d6",
        "flag": "#e34948",
        # Ordinal ramp: the step nearest the surface is dropped so a count of 1
        # still reads as shaded against an unshaded (zero) cell.
        "ramp": ["#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
    },
    "dark": {
        "surface": "#1a1a19",
        "text": "#ffffff",
        "muted": "#c3c2b7",
        "grid": "#383835",
        "series": "#3987e5",
        "flag": "#e66767",
        "ramp": ["#104281", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"],
    },
}


@dataclass
class OutlierResult:
    """Everything the analysis produced.

    Attributes:
        data:     every input row, plus center/spread/score/is_outlier columns.
        outliers: the flagged subset, sorted by |score| descending.
        summary:  one row per (NAICS, Measure) series with its outlier count.
        figures:  name -> matplotlib Figure.
        method:   the detection method used.
        threshold: the cutoff applied to |score|.
    """

    data: pd.DataFrame
    outliers: pd.DataFrame
    summary: pd.DataFrame
    method: str
    threshold: float
    figures: dict[str, Figure] = field(default_factory=dict)

    def save(self, outdir: str | Path, dpi: int = 200, formats: Sequence[str] = ("png",)) -> list[Path]:
        """Write every figure and the flagged rows to `outdir`. Returns paths."""
        outdir = Path(outdir)
        outdir.mkdir(parents=True, exist_ok=True)
        written: list[Path] = []
        for name, fig in self.figures.items():
            for ext in formats:
                path = outdir / f"{name}.{ext}"
                fig.savefig(path, dpi=dpi, bbox_inches="tight", facecolor=fig.get_facecolor())
                written.append(path)
        path = outdir / "outliers.csv"
        self.outliers.to_csv(path, index=False)
        written.append(path)
        return written

    def __repr__(self) -> str:  # keeps notebook output short
        return (
            f"OutlierResult(method={self.method!r}, threshold={self.threshold}, "
            f"rows={len(self.data)}, outliers={len(self.outliers)}, "
            f"figures={list(self.figures)})"
        )


# --- loading -----------------------------------------------------------------


def _load(source: str | Path | pd.DataFrame) -> pd.DataFrame:
    if isinstance(source, pd.DataFrame):
        return source.copy()
    path = Path(source)
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xls", ".xlsm"):
        # NAICS as string keeps leading zeros and stops 3-digit codes becoming ints.
        return pd.read_excel(path, dtype={"NAICS": str})
    if suffix in (".parquet", ".pq"):
        return pd.read_parquet(path)
    return pd.read_csv(path, dtype={"NAICS": str})


def _prepare(
    df: pd.DataFrame,
    naics_col: str,
    measure_col: str,
    value_col: str,
    year_col: str,
    dropna: bool,
) -> pd.DataFrame:
    missing = [c for c in (naics_col, measure_col, value_col, year_col) if c not in df.columns]
    if missing:
        raise KeyError(f"Missing column(s) {missing}. Found: {list(df.columns)}")

    out = df.rename(
        columns={naics_col: "NAICS", measure_col: "Measure", value_col: "Value", year_col: "Year"}
    )[["NAICS", "Measure", "Value", "Year"]].copy()

    out["NAICS"] = out["NAICS"].astype(str).str.strip()
    out["Measure"] = out["Measure"].astype(str).str.strip()
    # Strip thousands separators, currency symbols and footnote markers that
    # survive most published spreadsheets; "(D)"/"(S)" suppression flags -> NaN.
    if not pd.api.types.is_numeric_dtype(out["Value"]):
        cleaned = (
            out["Value"].astype(str).str.replace(r"[,$%\s]", "", regex=True).str.replace(r"^\((.*)\)$", r"-\1", regex=True)
        )
        out["Value"] = pd.to_numeric(cleaned, errors="coerce")
    out["Year"] = pd.to_numeric(out["Year"], errors="coerce").astype("Int64")

    n_bad = int(out["Value"].isna().sum() + out["Year"].isna().sum())
    if dropna and n_bad:
        out = out.dropna(subset=["Value", "Year"])
    out["Year"] = out["Year"].astype(int)

    dupes = out.duplicated(subset=["NAICS", "Measure", "Year"]).sum()
    if dupes:
        raise ValueError(
            f"{dupes} duplicate (NAICS, Measure, Year) rows. Aggregate or subset them "
            "before running — a duplicated year silently distorts the within-series spread."
        )
    return out.sort_values(["Measure", "NAICS", "Year"]).reset_index(drop=True)


# --- detection ---------------------------------------------------------------


def _robust_spread(x: np.ndarray) -> float:
    """MAD in sigma units, falling back to mean absolute deviation when MAD == 0.

    MAD collapses to zero whenever more than half a series holds the same value
    (common in suppressed or rounded data); without the fallback every other
    point scores infinity.
    """
    med = np.median(x)
    mad = np.median(np.abs(x - med))
    if mad > 0:
        return float(mad / _MAD_TO_SIGMA)
    mean_ad = float(np.mean(np.abs(x - med)))
    return mean_ad / _MEANAD_TO_SIGMA if mean_ad > 0 else 0.0


def _linear_residuals(year: np.ndarray, value: np.ndarray) -> np.ndarray:
    """Residuals from a least-squares line on Year. Falls back to demeaning."""
    if len(np.unique(year)) < 2:
        return value - np.mean(value)
    slope, intercept = np.polyfit(year.astype(float), value, 1)
    return value - (slope * year.astype(float) + intercept)


def _score_series(sub: pd.DataFrame, method: str) -> pd.DataFrame:
    """Score one (NAICS, Measure) series. Returns center/spread/score/basis."""
    value = sub["Value"].to_numpy(dtype=float)
    year = sub["Year"].to_numpy()

    if method == "residual":
        basis = _linear_residuals(year, value)
    elif method == "yoy":
        prev = np.concatenate([[np.nan], value[:-1]])
        with np.errstate(divide="ignore", invalid="ignore"):
            basis = np.where(prev == 0, np.nan, (value - prev) / np.abs(prev) * 100.0)
    else:
        basis = value

    finite = np.isfinite(basis)
    center = float(np.median(basis[finite])) if finite.any() else np.nan

    if method == "iqr":
        q1, q3 = np.percentile(basis[finite], [25, 75]) if finite.any() else (np.nan, np.nan)
        iqr = q3 - q1
        spread = float(iqr)
        # Signed distance from the median in IQR units, so scores stay
        # comparable across series and the Tukey fence sits at k * 0.5 + ...
        score = np.divide(basis - center, iqr, out=np.full_like(basis, np.nan), where=iqr > 0)
        fences = (q1, q3, iqr)
    else:
        spread = _robust_spread(basis[finite]) if finite.any() else 0.0
        score = np.divide(
            basis - center, spread, out=np.full_like(basis, np.nan), where=spread > 0
        )
        fences = None

    out = pd.DataFrame(
        {
            "basis": basis,
            "center": center,
            "spread": spread,
            "score": score,
        },
        index=sub.index,
    )
    if fences is not None:
        out["q1"], out["q3"], out["iqr"] = fences
    return out


def detect_outliers(
    df: pd.DataFrame,
    method: str = "mad",
    threshold: float | None = None,
    min_obs: int = 5,
    group_cols: Sequence[str] = ("NAICS", "Measure"),
) -> pd.DataFrame:
    """Score every row within its series and flag the ones past `threshold`.

    Args:
        df: prepared frame with NAICS / Measure / Value / Year columns.
        method: one of METHODS.
        threshold: cutoff on |score|. Defaults to 3.5 for the modified z-score
            methods and 1.5 (Tukey's k) for "iqr".
        min_obs: series shorter than this are scored but never flagged — a
            robust spread from four points is not a spread.
        group_cols: what defines a series. Drop "Measure" only if every row
            already shares one measure.

    Returns:
        `df` plus: basis, center, spread, score, is_outlier, n_obs, direction.
    """
    if method not in METHODS:
        raise ValueError(f"method must be one of {METHODS}, got {method!r}")
    if threshold is None:
        threshold = 1.5 if method == "iqr" else 3.5

    group_cols = list(group_cols)
    scored = df.copy()
    parts = [_score_series(sub, method) for _, sub in scored.groupby(group_cols, sort=False)]
    scored = scored.join(pd.concat(parts).sort_index())

    scored["n_obs"] = scored.groupby(group_cols)["Value"].transform("size")

    if method == "iqr":
        # Tukey: outside Q1 - k*IQR or Q3 + k*IQR.
        below = scored["basis"] < scored["q1"] - threshold * scored["iqr"]
        above = scored["basis"] > scored["q3"] + threshold * scored["iqr"]
        flag = below | above
    else:
        flag = scored["score"].abs() >= threshold

    scored["is_outlier"] = (flag & (scored["n_obs"] >= min_obs)).fillna(False)
    scored["direction"] = np.where(
        ~scored["is_outlier"], "", np.where(scored["score"] > 0, "high", "low")
    )
    return scored


def _summarize(scored: pd.DataFrame) -> pd.DataFrame:
    g = scored.groupby(["Measure", "NAICS"], sort=False)
    summary = g.agg(
        n_obs=("Value", "size"),
        first_year=("Year", "min"),
        last_year=("Year", "max"),
        median=("Value", "median"),
        n_outliers=("is_outlier", "sum"),
        max_abs_score=("score", lambda s: float(np.nanmax(np.abs(s))) if s.notna().any() else np.nan),
    ).reset_index()
    summary["outlier_rate"] = summary["n_outliers"] / summary["n_obs"]
    return summary.sort_values(["n_outliers", "max_abs_score"], ascending=False).reset_index(drop=True)


# --- plotting ----------------------------------------------------------------


def _style_axes(ax: plt.Axes, t: Mapping[str, str], grid_axis: str = "y") -> None:
    """Hairline grid, two spines, recessive chrome."""
    ax.set_facecolor(t["surface"])
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(t["grid"])
        ax.spines[side].set_linewidth(0.8)
    if grid_axis != "none":
        ax.grid(axis=grid_axis, color=t["grid"], linewidth=0.8, linestyle="-")
    ax.set_axisbelow(True)
    ax.tick_params(colors=t["muted"], labelsize=9, length=0)


def _new_fig(t: Mapping[str, str], **kwargs) -> tuple[Figure, np.ndarray | plt.Axes]:
    fig, ax = plt.subplots(**kwargs)
    fig.patch.set_facecolor(t["surface"])
    return fig, ax


def _title(ax: plt.Axes, title: str, subtitle: str, t: Mapping[str, str]) -> None:
    ax.set_title(title, color=t["text"], fontsize=13, fontweight="600", loc="left", pad=18)
    ax.text(
        0, 1.02, subtitle, transform=ax.transAxes, color=t["muted"], fontsize=10, va="bottom", ha="left"
    )


def _fmt_value(v: float) -> str:
    if not np.isfinite(v):
        return "n/a"
    a = abs(v)
    if a >= 1e9:
        return f"{v/1e9:,.1f}B"
    if a >= 1e6:
        return f"{v/1e6:,.1f}M"
    if a >= 1e3:
        return f"{v/1e3:,.1f}K"
    return f"{v:,.2f}".rstrip("0").rstrip(".")


def _plot_distribution(scored: pd.DataFrame, t: Mapping[str, str], threshold: float, method: str) -> Figure:
    """Score distribution per measure: hairline box + jittered points."""
    measures = list(pd.unique(scored["Measure"]))
    height = max(2.6, 0.75 * len(measures) + 1.9)
    fig, ax = _new_fig(t, figsize=(9.5, height))
    _style_axes(ax, t, grid_axis="x")

    rng = np.random.default_rng(7)  # fixed jitter: the same data draws the same chart
    for i, measure in enumerate(measures):
        sub = scored[(scored["Measure"] == measure) & scored["score"].notna()]
        y = len(measures) - 1 - i
        vals = sub["score"].to_numpy()
        if len(vals):
            kwargs = dict(
                positions=[y],
                widths=0.42,
                showfliers=False,
                medianprops=dict(color=t["muted"], linewidth=1.4),
                boxprops=dict(color=t["grid"], linewidth=1.0),
                whiskerprops=dict(color=t["grid"], linewidth=1.0),
                capprops=dict(color=t["grid"], linewidth=1.0),
            )
            try:  # `vert` deprecated in matplotlib 3.11
                ax.boxplot(vals, orientation="horizontal", **kwargs)
            except TypeError:
                ax.boxplot(vals, vert=False, **kwargs)
        jitter = rng.uniform(-0.16, 0.16, len(sub))
        keep = ~sub["is_outlier"].to_numpy()
        ax.scatter(
            vals[keep], y + jitter[keep], s=14, color=t["series"], alpha=0.55, linewidths=0, zorder=3
        )
        ax.scatter(
            vals[~keep],
            y + jitter[~keep],
            s=42,
            color=t["flag"],
            marker="D",
            linewidths=1.6,
            edgecolors=t["surface"],  # 2px surface ring, not a border
            zorder=4,
        )

    for sign in (-1, 1):
        ax.axvline(sign * threshold, color=t["flag"], linewidth=1.0, alpha=0.5, zorder=1)
    ax.text(
        threshold,
        len(measures) - 0.45,
        f"  flag at |score| ≥ {threshold:g}",
        color=t["flag"],
        fontsize=9,
        va="center",
    )

    ax.set_yticks(range(len(measures)))
    ax.set_yticklabels(measures[::-1], color=t["text"], fontsize=10)
    ax.set_ylim(-0.6, len(measures) - 0.2)
    ax.set_xlabel(_score_label(method), color=t["muted"], fontsize=10)
    _title(
        ax,
        "How far each observation sits from its own series",
        f"Scored within NAICS × Measure · {int(scored['is_outlier'].sum())} of {len(scored)} flagged",
        t,
    )
    fig.tight_layout()
    return fig


def _score_label(method: str) -> str:
    return {
        "mad": "Modified z-score of level (median-centered, MAD-scaled)",
        "iqr": "Distance from series median, in IQR units",
        "residual": "Modified z-score of residual from series trend",
        "yoy": "Modified z-score of year-over-year % change",
    }[method]


def _plot_series(scored: pd.DataFrame, t: Mapping[str, str], top_n: int, summary: pd.DataFrame) -> Figure | None:
    """Small multiples of the series holding the most extreme observations.

    Separate panels, each with its own y-axis — never two scales on one plot.
    """
    ranked = summary[summary["n_outliers"] > 0]
    if ranked.empty:
        return None
    ranked = ranked.head(top_n)

    n = len(ranked)
    ncols = min(3, n)
    nrows = int(np.ceil(n / ncols))
    fig, axes = _new_fig(t, nrows=nrows, ncols=ncols, figsize=(4.4 * ncols, 3.0 * nrows), squeeze=False)

    for ax_i, (ax, (_, row)) in enumerate(zip(axes.flat, ranked.iterrows())):
        sub = scored[(scored["NAICS"] == row["NAICS"]) & (scored["Measure"] == row["Measure"])].sort_values("Year")
        _style_axes(ax, t)
        ax.plot(sub["Year"], sub["Value"], color=t["series"], linewidth=2.0, zorder=2)
        ax.scatter(sub["Year"], sub["Value"], s=18, color=t["series"], linewidths=0, zorder=3)

        flagged = sub[sub["is_outlier"]]
        ax.scatter(
            flagged["Year"],
            flagged["Value"],
            s=95,
            facecolors="none",
            edgecolors=t["flag"],
            linewidths=2.0,
            zorder=4,
        )
        # Direct-label the single most extreme point only.
        if not flagged.empty:
            worst = flagged.loc[flagged["score"].abs().idxmax()]
            ax.annotate(
                f"{int(worst['Year'])} · {_fmt_value(worst['Value'])}",
                xy=(worst["Year"], worst["Value"]),
                xytext=(0, 14 if worst["score"] > 0 else -20),
                textcoords="offset points",
                ha="center",
                fontsize=9,
                color=t["flag"],
                zorder=5,
            )
        ax.set_title(
            f"NAICS {row['NAICS']} · {row['Measure']}",
            color=t["text"],
            fontsize=10.5,
            fontweight="600",
            loc="left",
            pad=8,
        )
        ax.margins(y=0.22)
        ax.xaxis.set_major_locator(plt.MaxNLocator(5, integer=True))
        ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: _fmt_value(v)))

    for ax in axes.flat[n:]:
        ax.set_visible(False)

    fig.suptitle(
        "Series with the most flagged observations",
        color=t["text"],
        fontsize=13,
        fontweight="600",
        x=0.01,
        ha="left",
        y=1.0,
    )
    fig.text(
        0.01,
        0.975,
        "Rings mark flagged years; each panel keeps its own scale",
        color=t["muted"],
        fontsize=10,
        ha="left",
        va="top",
    )
    fig.tight_layout(rect=(0, 0, 1, 0.945))
    return fig


def _plot_ranking(scored: pd.DataFrame, t: Mapping[str, str], top_n: int, method: str) -> Figure | None:
    """Lollipop of the most extreme flagged observations."""
    flagged = scored[scored["is_outlier"]].copy()
    if flagged.empty:
        return None
    flagged["abs_score"] = flagged["score"].abs()
    top = flagged.nlargest(top_n, "abs_score").iloc[::-1]

    fig, ax = _new_fig(t, figsize=(9.5, max(2.6, 0.42 * len(top) + 2.0)))
    _style_axes(ax, t, grid_axis="x")

    y = np.arange(len(top))
    ax.hlines(y, 0, top["score"], color=t["flag"], linewidth=2.0, alpha=0.65, zorder=2)
    ax.scatter(top["score"], y, s=58, color=t["flag"], edgecolors=t["surface"], linewidths=1.6, zorder=3)
    ax.axvline(0, color=t["grid"], linewidth=0.8, zorder=1)

    for yi, (_, row) in zip(y, top.iterrows()):
        offset = 8 if row["score"] > 0 else -8
        ax.annotate(
            _fmt_value(row["Value"]),
            xy=(row["score"], yi),
            xytext=(offset, 0),
            textcoords="offset points",
            va="center",
            ha="left" if row["score"] > 0 else "right",
            fontsize=9,
            color=t["muted"],
        )

    ax.set_yticks(y)
    ax.set_yticklabels(
        [f"{r['NAICS']} · {r['Measure']} · {int(r['Year'])}" for _, r in top.iterrows()],
        color=t["text"],
        fontsize=9.5,
    )
    ax.margins(x=0.14)
    ax.set_xlabel(_score_label(method), color=t["muted"], fontsize=10)
    _title(ax, f"Most extreme observations (top {len(top)})", "Value shown beside each point", t)
    fig.tight_layout()
    return fig


def _plot_heatmap(scored: pd.DataFrame, t: Mapping[str, str]) -> Figure | None:
    """Where the outliers cluster: count by Year x Measure, single-hue ramp."""
    flagged = scored[scored["is_outlier"]]
    if flagged.empty:
        return None
    years = sorted(scored["Year"].unique())
    measures = list(pd.unique(scored["Measure"]))
    grid = (
        flagged.pivot_table(index="Measure", columns="Year", values="Value", aggfunc="size")
        .reindex(index=measures, columns=years)
        .fillna(0)
    )

    if len(measures) == 1:
        counts = grid.iloc[0]
        fig, ax = _new_fig(t, figsize=(9.5, 3.4))
        _style_axes(ax, t)
        ax.bar(counts.index, counts.values, color=t["series"], width=0.72)
        ax.yaxis.set_major_locator(MaxNLocator(integer=True))  # counts are whole numbers
        ax.set_ylabel("Flagged observations", color=t["muted"], fontsize=10)
        _title(ax, "When the outliers happen", f"{measures[0]} · {len(flagged)} flagged", t)
        fig.tight_layout()
        return fig

    from matplotlib.colors import LinearSegmentedColormap

    cmap = LinearSegmentedColormap.from_list("seq_blue", t["ramp"]).copy()
    cmap.set_bad(t["grid"])  # zero-count cells must not read as "a few"
    fig, ax = _new_fig(t, figsize=(max(7.5, 0.34 * len(years) + 3.5), 0.52 * len(measures) + 2.6))
    ax.set_facecolor(t["surface"])
    for side in ax.spines:
        ax.spines[side].set_visible(False)
    ax.tick_params(colors=t["muted"], labelsize=9, length=0)

    top = max(1, int(grid.values.max()))
    masked = np.ma.masked_equal(grid.values, 0)
    mesh = ax.imshow(masked, cmap=cmap, aspect="auto", vmin=1, vmax=top)
    ax.set_xticks(range(len(years)))
    ax.set_xticklabels(years, rotation=90 if len(years) > 18 else 0)
    ax.set_yticks(range(len(measures)))
    ax.set_yticklabels(measures, color=t["text"], fontsize=10)
    # 2px surface gap between cells rather than a border around them.
    ax.set_xticks(np.arange(-0.5, len(years), 1), minor=True)
    ax.set_yticks(np.arange(-0.5, len(measures), 1), minor=True)
    ax.grid(which="minor", color=t["surface"], linewidth=2)
    ax.tick_params(which="minor", length=0)

    cbar = fig.colorbar(mesh, ax=ax, pad=0.02, fraction=0.035)
    cbar.set_label("Flagged observations", color=t["muted"], fontsize=9)
    cbar.ax.tick_params(colors=t["muted"], labelsize=8, length=0)
    cbar.ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    cbar.outline.set_visible(False)

    ax.set_title(
        "Where the outliers cluster", color=t["text"], fontsize=13, fontweight="600", loc="left", pad=18
    )
    ax.text(
        0, 1.02, "Count of flagged observations by year · unshaded cells are clean",
        transform=ax.transAxes, color=t["muted"], fontsize=10, va="bottom", ha="left",
    )
    fig.tight_layout()
    return fig


def plot_outliers(
    scored: pd.DataFrame,
    summary: pd.DataFrame,
    method: str = "mad",
    threshold: float = 3.5,
    theme: str = "light",
    top_n: int = 12,
    which: Iterable[str] = ("distribution", "series", "ranking", "heatmap"),
) -> dict[str, Figure]:
    """Build the figure set from an already-scored frame."""
    t = _THEMES[theme]
    which = set(which)
    figures: dict[str, Figure] = {}

    if "distribution" in which:
        figures["distribution"] = _plot_distribution(scored, t, threshold, method)
    if "series" in which:
        fig = _plot_series(scored, t, min(top_n, 9), summary)
        if fig is not None:
            figures["series"] = fig
    if "ranking" in which:
        fig = _plot_ranking(scored, t, top_n, method)
        if fig is not None:
            figures["ranking"] = fig
    if "heatmap" in which:
        fig = _plot_heatmap(scored, t)
        if fig is not None:
            figures["heatmap"] = fig
    return figures


# --- entry point -------------------------------------------------------------


def analyze_outliers(
    source: str | Path | pd.DataFrame,
    naics_col: str = "NAICS",
    measure_col: str = "Measure",
    value_col: str = "Value",
    year_col: str = "Year",
    method: str = "mad",
    threshold: float | None = None,
    min_obs: int = 5,
    measures: Sequence[str] | None = None,
    years: tuple[int, int] | None = None,
    plot: bool = True,
    theme: str = "light",
    top_n: int = 12,
    outdir: str | Path | None = None,
) -> OutlierResult:
    """Read a NAICS × Measure × Year panel, flag outliers, and draw the charts.

    Args:
        source: DataFrame, or path to .csv / .xlsx / .parquet.
        naics_col, measure_col, value_col, year_col: source column names.
        method: "mad" (default), "iqr", "residual", or "yoy". Use "residual"
            for trending series and "yoy" to find breaks rather than levels.
        threshold: cutoff on |score|; defaults to 3.5, or 1.5 for "iqr".
        min_obs: shortest series eligible to be flagged.
        measures: keep only these measures.
        years: inclusive (start, end) filter.
        plot: build figures.
        theme: "light" or "dark".
        top_n: how many series/observations the ranked charts show.
        outdir: if given, write figures and outliers.csv there.

    Returns:
        OutlierResult with .data, .outliers, .summary and .figures.
    """
    if theme not in _THEMES:
        raise ValueError(f"theme must be 'light' or 'dark', got {theme!r}")

    df = _prepare(_load(source), naics_col, measure_col, value_col, year_col, dropna=True)
    if measures is not None:
        df = df[df["Measure"].isin(measures)]
    if years is not None:
        df = df[(df["Year"] >= years[0]) & (df["Year"] <= years[1])]
    if df.empty:
        raise ValueError("No rows left after cleaning and filtering.")

    if threshold is None:
        threshold = 1.5 if method == "iqr" else 3.5

    scored = detect_outliers(df, method=method, threshold=threshold, min_obs=min_obs)
    summary = _summarize(scored)
    outliers = (
        scored[scored["is_outlier"]]
        .assign(abs_score=lambda d: d["score"].abs())
        .sort_values("abs_score", ascending=False)
        .drop(columns="abs_score")
        .reset_index(drop=True)
    )

    figures = (
        plot_outliers(scored, summary, method=method, threshold=threshold, theme=theme, top_n=top_n)
        if plot
        else {}
    )

    result = OutlierResult(
        data=scored, outliers=outliers, summary=summary, method=method, threshold=threshold, figures=figures
    )
    if outdir is not None:
        result.save(outdir)
    return result


# --- demo --------------------------------------------------------------------


def _demo_panel(seed: int = 11) -> pd.DataFrame:
    """Synthetic panel with known shocks, so the plots have something to find."""
    rng = np.random.default_rng(seed)
    industries = {
        "3361": "Motor vehicles",
        "5415": "Computer systems design",
        "2211": "Electric power",
        "7211": "Accommodation",
        "3254": "Pharmaceuticals",
        "4451": "Grocery stores",
    }
    specs = {
        "Employment (thousands)": (900.0, 0.008, 12.0),
        "Real value added ($M)": (48000.0, 0.026, 900.0),
        "Price index (2017=100)": (100.0, 0.019, 0.9),
    }
    rows = []
    for naics in industries:
        level_shift = rng.uniform(0.4, 2.1)
        for measure, (base, drift, noise) in specs.items():
            level = base * level_shift if "index" not in measure.lower() else base
            for i, year in enumerate(range(2002, 2025)):
                v = level * (1 + drift) ** i + rng.normal(0, noise)
                is_price = measure.startswith("Price")
                if year == 2009 and naics in ("3361", "4451") and not is_price:
                    v *= 0.72  # recession collapse
                if year == 2020 and naics in ("7211", "3361") and not is_price:
                    v *= 0.55  # pandemic collapse
                if year == 2022 and is_price:
                    v *= 1.14  # inflation break
                rows.append({"NAICS": naics, "Measure": measure, "Value": round(v, 2), "Year": year})
    return pd.DataFrame(rows)


if __name__ == "__main__":
    panel = _demo_panel()
    res = analyze_outliers(panel, method="residual", top_n=9, outdir="figures/outliers")
    print(res)
    print("\nTop flagged observations")
    print(
        res.outliers[["NAICS", "Measure", "Year", "Value", "score", "direction"]]
        .head(10)
        .to_string(index=False, float_format=lambda v: f"{v:,.2f}")
    )
    print("\nSeries summary (head)")
    print(res.summary.head(8).to_string(index=False, float_format=lambda v: f"{v:,.2f}"))
