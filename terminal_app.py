"""
Statistical Analysis Terminal — desktop dashboard for annual time series.

A dark, terminal-style dashboard around the time_series_analysis engine:
load a CSV or Excel file (or use the built-in demo series), pick the year
and value columns, and run the full workup — trend tests, growth rates,
Bayesian regression, outlier and change-point detection — with the chart
and full report side by side, plus one-click PNG and text-report export.

Run directly:
    python terminal_app.py

Package as a Windows executable:
    build_windows.bat   (uses PyInstaller; see that file)

Dependencies: PySide6, numpy, pandas, scipy, matplotlib, openpyxl.
"""

import sys
import traceback
from datetime import datetime

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("QtAgg")
import matplotlib.pyplot as plt

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QFrame, QHBoxLayout, QLabel,
    QMainWindow, QMessageBox, QPlainTextEdit, QPushButton, QSizePolicy,
    QSplitter, QVBoxLayout, QWidget,
)

from time_series_analysis import TimeSeriesAnalyzer

C = {
    "page": "#0b0e13",
    "panel": "#101418",
    "panel_alt": "#0e1216",
    "border": "#232a31",
    "ink": "#f2f5f7",
    "ink_2": "#c3c2b7",
    "muted": "#898781",
    "teal": "#2dd4bf",
    "teal_dim": "#17766b",
    "amber": "#eda100",
    "magenta": "#d55181",
    "violet": "#9085e9",
}

MONO = 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace'

STYLE = f"""
QMainWindow, QWidget {{
    background: {C['page']};
    color: {C['ink']};
    font-family: {MONO};
    font-size: 12px;
}}
QFrame#header {{
    background: {C['panel']};
    border-bottom: 1px solid {C['border']};
}}
QLabel#appTitle {{
    color: {C['teal']};
    font-size: 15px;
    font-weight: bold;
    letter-spacing: 2px;
}}
QLabel#clock {{
    color: {C['muted']};
    font-size: 12px;
    letter-spacing: 1px;
}}
QLabel#fileTag {{
    color: {C['ink_2']};
    font-size: 12px;
}}
QFrame#toolbar {{
    background: {C['panel_alt']};
    border-bottom: 1px solid {C['border']};
}}
QPushButton {{
    background: {C['panel']};
    color: {C['ink_2']};
    border: 1px solid {C['border']};
    padding: 5px 14px;
    font-weight: bold;
    letter-spacing: 1px;
}}
QPushButton:hover {{
    color: {C['teal']};
    border: 1px solid {C['teal_dim']};
}}
QPushButton:pressed {{
    background: {C['panel_alt']};
}}
QPushButton#run {{
    color: {C['page']};
    background: {C['teal']};
    border: 1px solid {C['teal']};
}}
QPushButton#run:hover {{
    background: #45e0cd;
}}
QComboBox {{
    background: {C['panel']};
    color: {C['ink']};
    border: 1px solid {C['border']};
    padding: 4px 8px;
    min-width: 110px;
}}
QComboBox QAbstractItemView {{
    background: {C['panel']};
    color: {C['ink']};
    selection-background-color: {C['teal_dim']};
    border: 1px solid {C['border']};
}}
QLabel.fieldLabel {{
    color: {C['muted']};
    letter-spacing: 1px;
}}
QFrame.tile {{
    background: {C['panel']};
    border: 1px solid {C['border']};
    border-top: 2px solid {C['teal_dim']};
}}
QLabel.tileLabel {{
    color: {C['muted']};
    font-size: 10px;
    letter-spacing: 2px;
}}
QLabel.tileValue {{
    color: {C['ink']};
    font-size: 19px;
    font-weight: bold;
}}
QLabel.tileSub {{
    color: {C['ink_2']};
    font-size: 10px;
}}
QPlainTextEdit#report {{
    background: {C['panel']};
    color: {C['ink_2']};
    border: 1px solid {C['border']};
    font-family: {MONO};
    font-size: 12px;
    padding: 8px;
}}
QFrame#chartFrame {{
    background: {C['page']};
    border: 1px solid {C['border']};
}}
QStatusBar {{
    background: {C['panel']};
    color: {C['muted']};
    border-top: 1px solid {C['border']};
}}
QSplitter::handle {{
    background: {C['border']};
    width: 2px;
}}
QScrollBar:vertical {{
    background: {C['panel']};
    width: 10px;
}}
QScrollBar::handle:vertical {{
    background: {C['border']};
    min-height: 24px;
}}
QScrollBar:horizontal {{
    background: {C['panel']};
    height: 10px;
}}
QScrollBar::handle:horizontal {{
    background: {C['border']};
    min-width: 24px;
}}
QScrollBar::add-line, QScrollBar::sub-line {{
    height: 0;
}}
"""


def demo_dataframe(seed=7):
    """Synthetic annual series with a trend, two regime shifts, and two
    one-off shocks — useful for a first look at the dashboard."""
    rng = np.random.default_rng(seed)
    years = np.arange(1990, 2026)
    values = 100 + 2.4 * (years - years[0]) + rng.normal(0, 4, years.size)
    values[years >= 2008] -= 18
    values[years >= 2015] += 30
    values[years == 2001] += 32
    values[years == 2020] -= 26
    return pd.DataFrame({"Year": years, "Value": values})


class Tile(QFrame):
    """A single headline-metric tile."""

    def __init__(self, label):
        super().__init__()
        self.setProperty("class", "tile")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(12, 8, 12, 8)
        lay.setSpacing(2)
        self.lab = QLabel(label)
        self.lab.setProperty("class", "tileLabel")
        self.val = QLabel("--")
        self.val.setProperty("class", "tileValue")
        self.sub = QLabel(" ")
        self.sub.setProperty("class", "tileSub")
        for w in (self.lab, self.val, self.sub):
            lay.addWidget(w)

    def set(self, value, sub=" ", color=None):
        self.val.setText(value)
        self.sub.setText(sub or " ")
        self.val.setStyleSheet(f"color: {color};" if color else "")


class TerminalWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Statistical Analysis Terminal")
        self.resize(1500, 880)
        self.df = None
        self.analyzer = None
        self.results = None
        self.fig = None
        self.source_name = "NO DATA"
        self._build_ui()
        self.setStyleSheet(STYLE)
        self._tick()
        timer = QTimer(self)
        timer.timeout.connect(self._tick)
        timer.start(1000)
        self.status.showMessage(
            "READY - LOAD DATA (CSV/XLSX) OR PRESS DEMO, THEN RUN ANALYSIS"
        )

    # ------------------------------------------------------------------
    def _build_ui(self):
        root = QWidget()
        root_lay = QVBoxLayout(root)
        root_lay.setContentsMargins(0, 0, 0, 0)
        root_lay.setSpacing(0)

        header = QFrame(objectName="header")
        h = QHBoxLayout(header)
        h.setContentsMargins(14, 8, 14, 8)
        title = QLabel("STATISTICAL ANALYSIS TERMINAL", objectName="appTitle")
        self.file_tag = QLabel("NO DATA", objectName="fileTag")
        self.clock = QLabel("", objectName="clock")
        h.addWidget(title)
        h.addSpacing(24)
        h.addWidget(self.file_tag)
        h.addStretch(1)
        h.addWidget(self.clock)
        root_lay.addWidget(header)

        bar = QFrame(objectName="toolbar")
        b = QHBoxLayout(bar)
        b.setContentsMargins(14, 8, 14, 8)
        b.setSpacing(10)
        self.btn_load = QPushButton("LOAD DATA")
        self.btn_demo = QPushButton("DEMO")
        lab_year = QLabel("YEAR COL")
        lab_year.setProperty("class", "fieldLabel")
        self.combo_year = QComboBox()
        lab_val = QLabel("VALUE COL")
        lab_val.setProperty("class", "fieldLabel")
        self.combo_value = QComboBox()
        self.btn_run = QPushButton("RUN ANALYSIS", objectName="run")
        self.btn_png = QPushButton("EXPORT CHART")
        self.btn_txt = QPushButton("EXPORT REPORT")
        for w in (self.btn_load, self.btn_demo):
            b.addWidget(w)
        b.addSpacing(10)
        for w in (lab_year, self.combo_year, lab_val, self.combo_value):
            b.addWidget(w)
        b.addSpacing(10)
        b.addWidget(self.btn_run)
        b.addStretch(1)
        for w in (self.btn_png, self.btn_txt):
            b.addWidget(w)
        root_lay.addWidget(bar)

        tiles = QWidget()
        t = QHBoxLayout(tiles)
        t.setContentsMargins(14, 10, 14, 4)
        t.setSpacing(10)
        self.tile_last = Tile("LATEST VALUE")
        self.tile_cagr = Tile("CAGR")
        self.tile_slope = Tile("SEN'S SLOPE")
        self.tile_prob = Tile("P(TREND > 0)")
        self.tile_breaks = Tile("CHANGE POINTS")
        self.tile_outl = Tile("OUTLIERS")
        for w in (self.tile_last, self.tile_cagr, self.tile_slope,
                  self.tile_prob, self.tile_breaks, self.tile_outl):
            t.addWidget(w)
        root_lay.addWidget(tiles)

        split = QSplitter(Qt.Horizontal)
        split.setContentsMargins(14, 6, 14, 10)

        self.chart_frame = QFrame(objectName="chartFrame")
        self.chart_lay = QVBoxLayout(self.chart_frame)
        self.chart_lay.setContentsMargins(2, 2, 2, 2)
        placeholder = QLabel("CHART - RUN ANALYSIS TO RENDER")
        placeholder.setAlignment(Qt.AlignCenter)
        placeholder.setStyleSheet(f"color: {C['muted']}; letter-spacing: 2px;")
        self.chart_lay.addWidget(placeholder)

        self.report = QPlainTextEdit(objectName="report")
        self.report.setReadOnly(True)
        self.report.setLineWrapMode(QPlainTextEdit.NoWrap)
        self.report.setPlainText(
            "REPORT\n\nLoad a CSV or Excel file with a year column and a\n"
            "value column (or press DEMO), choose the columns, then\n"
            "press RUN ANALYSIS.\n\nThe full report renders here:\n"
            "  - descriptive statistics\n  - trend analysis "
            "(OLS, Mann-Kendall, Sen's slope)\n  - growth rates and momentum\n"
            "  - Bayesian trend and forecast\n  - outlier analysis\n"
            "  - change-point detection"
        )

        wrap = QWidget()
        wrap_lay = QHBoxLayout(wrap)
        wrap_lay.setContentsMargins(14, 6, 14, 10)
        split.addWidget(self.chart_frame)
        split.addWidget(self.report)
        split.setStretchFactor(0, 13)
        split.setStretchFactor(1, 7)
        split.setSizes([960, 500])
        wrap_lay.addWidget(split)
        root_lay.addWidget(wrap, 1)

        self.setCentralWidget(root)
        self.status = self.statusBar()

        self.btn_load.clicked.connect(self.load_file)
        self.btn_demo.clicked.connect(self.load_demo)
        self.btn_run.clicked.connect(self.run_analysis)
        self.btn_png.clicked.connect(self.export_chart)
        self.btn_txt.clicked.connect(self.export_report)

    # ------------------------------------------------------------------
    def _tick(self):
        self.clock.setText(datetime.now().strftime("%a %d %b %Y  %H:%M:%S"))

    def _set_columns(self, df):
        self.df = df
        cols = [str(c) for c in df.columns]
        for combo in (self.combo_year, self.combo_value):
            combo.blockSignals(True)
            combo.clear()
            combo.addItems(cols)
            combo.blockSignals(False)

        def pick(combo, preferred, fallback_idx):
            for i, c in enumerate(cols):
                if c.strip().lower() == preferred:
                    combo.setCurrentIndex(i)
                    return
            combo.setCurrentIndex(min(fallback_idx, len(cols) - 1))

        pick(self.combo_year, "year", 0)
        pick(self.combo_value, "value", 1)

    def load_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Load data", "",
            "Data files (*.csv *.xlsx *.xls);;CSV (*.csv);;Excel (*.xlsx *.xls)",
        )
        if not path:
            return
        try:
            if path.lower().endswith((".xlsx", ".xls")):
                df = pd.read_excel(path)
            else:
                df = pd.read_csv(path)
        except Exception as exc:
            QMessageBox.critical(self, "Load failed", str(exc))
            return
        self._set_columns(df)
        self.source_name = path.split("/")[-1].split("\\")[-1].upper()
        self.file_tag.setText(
            f"{self.source_name}  |  {len(df)} ROWS x {len(df.columns)} COLS"
        )
        self.status.showMessage(
            f"LOADED {self.source_name} - CHECK COLUMNS, THEN RUN ANALYSIS"
        )

    def load_demo(self):
        df = demo_dataframe()
        self._set_columns(df)
        self.source_name = "DEMO SERIES"
        self.file_tag.setText(f"DEMO SERIES  |  {len(df)} ROWS")
        self.status.showMessage("DEMO SERIES LOADED - PRESS RUN ANALYSIS")

    # ------------------------------------------------------------------
    def run_analysis(self):
        if self.df is None:
            self.status.showMessage("NO DATA - LOAD A FILE OR PRESS DEMO FIRST")
            return
        year_col = self.combo_year.currentText()
        value_col = self.combo_value.currentText()
        try:
            self.analyzer = TimeSeriesAnalyzer(
                self.df, value_col=value_col, year_col=year_col
            )
            self.results = self.analyzer.run_full_analysis(
                show=False, print_report=False
            )
        except Exception as exc:
            traceback.print_exc()
            QMessageBox.critical(self, "Analysis failed", str(exc))
            self.status.showMessage(f"ANALYSIS FAILED - {exc}")
            return

        self._render_chart()
        self._update_tiles()
        self.report.setPlainText(self.analyzer.summary())
        n = self.analyzer.n
        y0, y1 = self.analyzer.years[0], self.analyzer.years[-1]
        self.status.showMessage(
            f"ANALYSIS COMPLETE - {value_col} BY {year_col}, "
            f"{y0:.0f}-{y1:.0f} ({n} OBS)"
        )

    def _render_chart(self):
        while self.chart_lay.count():
            item = self.chart_lay.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if self.fig is not None:
            plt.close(self.fig)
        self.fig = self.analyzer.plot(
            figsize=(9.6, 5.6), dpi=100,
            title=f"{self.combo_value.currentText()} — {self.source_name.title()}",
        )
        canvas = self.fig.canvas
        canvas.setParent(self.chart_frame)
        self.chart_lay.addWidget(canvas)
        canvas.draw_idle()

    def _update_tiles(self):
        r = self.results
        a = self.analyzer
        growth, trend = r["growth"], r["trend"]
        bayes, cps, outl = r["bayesian"], r["changepoints"], r["outliers"]

        last_val = a.values[-1]
        prev = a.values[-2] if a.n > 1 else last_val
        delta = last_val - prev
        self.tile_last.set(
            f"{last_val:,.2f}",
            f"{a.years[-1]:.0f}  ({delta:+,.2f} vs prior)",
            C["teal"],
        )
        cagr = growth["cagr"]
        self.tile_cagr.set(
            "n/a" if cagr is None else f"{cagr * 100:+.2f}%",
            f"mean yoy {growth['mean_growth'] * 100:+.2f}%"
            if growth["mean_growth"] is not None else " ",
        )
        self.tile_slope.set(
            f"{trend['sen_slope']:+,.3f}/yr",
            f"mann-kendall p {trend['mann_kendall_p']:.3g}",
        )
        prob = bayes["prob_positive_trend"] * 100
        ci = bayes["slope_ci"]
        self.tile_prob.set(
            f"{prob:.1f}%",
            f"95% ci [{ci[0]:+,.2f}, {ci[1]:+,.2f}]",
            C["violet"],
        )
        n_cp = len(cps["change_points"])
        cp_years = ", ".join(f"{c['year']:.0f}" for c in cps["change_points"])
        self.tile_breaks.set(
            str(n_cp), cp_years or "none detected",
            C["magenta"] if n_cp else None,
        )
        mask = outl["consensus_mask"] | outl["hampel_mask"]
        n_out = int(mask.sum())
        out_years = ", ".join(f"{y:.0f}" for y in a.years[mask])
        self.tile_outl.set(
            str(n_out), out_years or "none detected",
            C["amber"] if n_out else None,
        )

    # ------------------------------------------------------------------
    def export_chart(self):
        if self.analyzer is None:
            self.status.showMessage("NOTHING TO EXPORT - RUN ANALYSIS FIRST")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "Export chart", "chart.png", "PNG image (*.png)"
        )
        if not path:
            return
        fig = self.analyzer.plot(
            save_path=path, dpi=200,
            title=f"{self.combo_value.currentText()} — {self.source_name.title()}",
        )
        plt.close(fig)
        self.status.showMessage(f"CHART SAVED - {path}")

    def export_report(self):
        if self.analyzer is None:
            self.status.showMessage("NOTHING TO EXPORT - RUN ANALYSIS FIRST")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "Export report", "report.txt", "Text file (*.txt)"
        )
        if not path:
            return
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.analyzer.summary() + "\n")
        self.status.showMessage(f"REPORT SAVED - {path}")


def main():
    app = QApplication(sys.argv)
    QFontDatabase.systemFont(QFontDatabase.FixedFont)
    win = TerminalWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
