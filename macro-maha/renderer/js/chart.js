// Macro Maha — chart layer on top of TradingView lightweight-charts (v4).
// One main pane (candles + volume + named overlays + forecast fans) and an
// optional sub pane (RSI / MACD / pair z-score) kept in time-sync.
(function (root) {
  'use strict';

  const C = {
    bg: '#05080f',
    grid: '#101a2c',
    text: '#7f93b8',
    border: '#1a2942',
    accent: '#3b9eff',
    up: '#1fd08a',
    down: '#ff5d6c',
    volume: '#16304f',
    fan: '#3b9eff',
    fanBand: '#8ab8ff',
    trend: '#ffd166'
  };

  const BASE_OPTS = {
    layout: {
      background: { type: 'solid', color: C.bg },
      textColor: C.text,
      fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
      fontSize: 11
    },
    grid: {
      vertLines: { color: C.grid },
      horzLines: { color: C.grid }
    },
    crosshair: {
      mode: 0,
      vertLine: { color: C.accent, width: 1, style: 3, labelBackgroundColor: C.accent },
      horzLine: { color: C.accent, width: 1, style: 3, labelBackgroundColor: C.accent }
    },
    rightPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false }
  };

  function nextBusinessDay(unixSec) {
    const d = new Date(unixSec * 1000);
    do {
      d.setUTCDate(d.getUTCDate() + 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return Math.floor(d.getTime() / 1000);
  }

  class TerminalChart {
    constructor(mainEl, subEl) {
      this.mainEl = mainEl;
      this.subEl = subEl;
      this.chart = LightweightCharts.createChart(mainEl, BASE_OPTS);
      this.candles = this.chart.addCandlestickSeries({
        upColor: C.up,
        downColor: C.down,
        borderUpColor: C.up,
        borderDownColor: C.down,
        wickUpColor: C.up,
        wickDownColor: C.down
      });
      this.volume = this.chart.addHistogramSeries({
        priceScaleId: 'vol',
        priceFormat: { type: 'volume' },
        color: C.volume
      });
      this.chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 }
      });

      this.overlays = new Map(); // name -> series
      this.perfSeries = new Map(); // symbol -> line series (relative mode)
      this.mode = 'price';
      this.bars = [];
      this.lastBar = null;
      this.intervalSec = 86400;

      this.subChart = null;
      this.subSeries = [];
      this._syncing = false;

      new ResizeObserver(() => this._resize()).observe(mainEl);
      this._resize();
    }

    _resize() {
      this.chart.applyOptions({
        width: this.mainEl.clientWidth,
        height: this.mainEl.clientHeight
      });
      if (this.subChart) {
        this.subChart.applyOptions({
          width: this.subEl.clientWidth,
          height: this.subEl.clientHeight
        });
      }
    }

    setData(bars, intervalSec) {
      this.mode = 'price';
      this.bars = bars;
      this.intervalSec = intervalSec || 86400;
      this._clearPerf();
      this.clearOverlays();
      this.candles.applyOptions({ visible: true });
      this.volume.applyOptions({ visible: true });
      this.candles.setData(
        bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }))
      );
      this.volume.setData(
        bars.map((b) => ({
          time: b.t,
          value: b.v,
          color: b.c >= b.o ? 'rgba(31,208,138,0.35)' : 'rgba(255,93,108,0.35)'
        }))
      );
      this.lastBar = bars.length ? Object.assign({}, bars[bars.length - 1]) : null;
      this.chart.timeScale().fitContent();
    }

    // Merge a realtime tick into the current bar (or open a new bucket).
    applyTick(price, timeSec, dayVolume) {
      if (this.mode !== 'price' || !this.lastBar) return;
      const bucket =
        this.intervalSec >= 86400
          ? this.lastBar.t // daily: keep updating today's bar
          : Math.floor(timeSec / this.intervalSec) * this.intervalSec;
      if (bucket > this.lastBar.t) {
        this.lastBar = { t: bucket, o: price, h: price, l: price, c: price, v: 0 };
      } else {
        this.lastBar.c = price;
        if (price > this.lastBar.h) this.lastBar.h = price;
        if (price < this.lastBar.l) this.lastBar.l = price;
      }
      this.candles.update({
        time: this.lastBar.t,
        open: this.lastBar.o,
        high: this.lastBar.h,
        low: this.lastBar.l,
        close: this.lastBar.c
      });
      if (dayVolume != null && this.intervalSec >= 86400) {
        this.volume.update({
          time: this.lastBar.t,
          value: dayVolume,
          color:
            this.lastBar.c >= this.lastBar.o
              ? 'rgba(31,208,138,0.35)'
              : 'rgba(255,93,108,0.35)'
        });
      }
    }

    // ---- overlays ----
    setOverlay(name, points, opts) {
      this.removeOverlay(name);
      const series = this.chart.addLineSeries(
        Object.assign(
          {
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          },
          opts || {}
        )
      );
      series.setData(points);
      this.overlays.set(name, series);
    }

    removeOverlay(name) {
      const s = this.overlays.get(name);
      if (s) {
        this.chart.removeSeries(s);
        this.overlays.delete(name);
      }
    }

    hasOverlay(name) {
      return this.overlays.has(name);
    }

    clearOverlays() {
      for (const s of this.overlays.values()) this.chart.removeSeries(s);
      this.overlays.clear();
    }

    // Overlay an indicator aligned to current bars: values[] same length as bars.
    setIndicatorOverlay(name, values, color, width) {
      const pts = [];
      for (let i = 0; i < this.bars.length; i++) {
        if (values[i] != null) pts.push({ time: this.bars[i].t, value: values[i] });
      }
      this.setOverlay(name, pts, { color, lineWidth: width || 1 });
    }

    // Forecast fan: median + credible band, projected onto future business days.
    // fan = [{mean, lo, hi}, ...], anchored at the last bar.
    setForecastFan(name, fan, color) {
      color = color || C.fan;
      if (!this.bars.length) return;
      let t = this.bars[this.bars.length - 1].t;
      const anchor = { time: t, value: this.bars[this.bars.length - 1].c };
      const mid = [anchor];
      const lo = [anchor];
      const hi = [anchor];
      for (const step of fan) {
        t = nextBusinessDay(t);
        mid.push({ time: t, value: step.mean });
        lo.push({ time: t, value: step.lo });
        hi.push({ time: t, value: step.hi });
      }
      this.setOverlay(name + ':mid', mid, { color, lineWidth: 2 });
      this.setOverlay(name + ':lo', lo, { color: C.fanBand, lineWidth: 1, lineStyle: 2 });
      this.setOverlay(name + ':hi', hi, { color: C.fanBand, lineWidth: 1, lineStyle: 2 });
      this.chart.timeScale().fitContent();
    }

    clearForecasts() {
      for (const name of Array.from(this.overlays.keys())) {
        if (name.includes(':mid') || name.includes(':lo') || name.includes(':hi')) {
          this.removeOverlay(name);
        }
      }
    }

    // ---- relative performance mode (REL command) ----
    setPerformanceMode(seriesMap, colors) {
      this.mode = 'perf';
      this.clearOverlays();
      this.candles.applyOptions({ visible: false });
      this.volume.applyOptions({ visible: false });
      this._clearPerf();
      let ci = 0;
      for (const [sym, ser] of Object.entries(seriesMap)) {
        const base = ser.c[0];
        const line = this.chart.addLineSeries({
          color: colors[ci % colors.length],
          lineWidth: 2,
          priceFormat: { type: 'custom', formatter: (v) => v.toFixed(1) + '%' },
          title: sym
        });
        line.setData(
          ser.t.map((tt, i) => ({ time: tt, value: (ser.c[i] / base - 1) * 100 }))
        );
        this.perfSeries.set(sym, line);
        ci++;
      }
      this.chart.timeScale().fitContent();
    }

    _clearPerf() {
      for (const s of this.perfSeries.values()) this.chart.removeSeries(s);
      this.perfSeries.clear();
    }

    // ---- sub pane ----
    _ensureSub() {
      if (this.subChart) return;
      this.subEl.style.display = 'block';
      this.subChart = LightweightCharts.createChart(this.subEl, BASE_OPTS);
      this._resize();
      // Two-way time sync with loop guard.
      const link = (a, b) => {
        a.timeScale().subscribeVisibleLogicalRangeChange((r) => {
          if (this._syncing || !r) return;
          this._syncing = true;
          b.timeScale().setVisibleLogicalRange(r);
          this._syncing = false;
        });
      };
      link(this.chart, this.subChart);
      link(this.subChart, this.chart);
    }

    _clearSub() {
      if (!this.subChart) return;
      for (const s of this.subSeries) this.subChart.removeSeries(s);
      this.subSeries = [];
    }

    hideSub() {
      this._clearSub();
      if (this.subChart) {
        this.subChart.remove();
        this.subChart = null;
      }
      this.subEl.style.display = 'none';
    }

    showRSI(values) {
      this._ensureSub();
      this._clearSub();
      const line = this.subChart.addLineSeries({ color: C.accent, lineWidth: 1 });
      const pts = [];
      for (let i = 0; i < this.bars.length; i++) {
        if (values[i] != null) pts.push({ time: this.bars[i].t, value: values[i] });
      }
      line.setData(pts);
      for (const lvl of [30, 70]) {
        line.createPriceLine({
          price: lvl,
          color: lvl === 70 ? C.down : C.up,
          lineWidth: 1,
          lineStyle: 3,
          title: String(lvl)
        });
      }
      this.subSeries.push(line);
      this.subChart.timeScale().fitContent();
    }

    showMACD(m) {
      this._ensureSub();
      this._clearSub();
      const hist = this.subChart.addHistogramSeries({ priceFormat: { type: 'price', precision: 3, minMove: 0.001 } });
      const histPts = [];
      for (let i = 0; i < this.bars.length; i++) {
        if (m.hist[i] != null) {
          histPts.push({
            time: this.bars[i].t,
            value: m.hist[i],
            color: m.hist[i] >= 0 ? 'rgba(31,208,138,0.6)' : 'rgba(255,93,108,0.6)'
          });
        }
      }
      hist.setData(histPts);
      const mk = (vals, color) => {
        const s = this.subChart.addLineSeries({ color, lineWidth: 1 });
        const pts = [];
        for (let i = 0; i < this.bars.length; i++) {
          if (vals[i] != null) pts.push({ time: this.bars[i].t, value: vals[i] });
        }
        s.setData(pts);
        return s;
      };
      this.subSeries.push(hist, mk(m.line, C.accent), mk(m.signal, C.trend));
      this.subChart.timeScale().fitContent();
    }

    // Pair z-score with ±2σ bands. times[] aligned with z[].
    showZScore(times, z) {
      this._ensureSub();
      this._clearSub();
      const line = this.subChart.addLineSeries({ color: C.accent, lineWidth: 1 });
      line.setData(times.map((t, i) => ({ time: t, value: z[i] })));
      for (const lvl of [-2, 0, 2]) {
        line.createPriceLine({
          price: lvl,
          color: lvl === 0 ? C.text : C.trend,
          lineWidth: 1,
          lineStyle: 3,
          title: lvl > 0 ? '+2σ' : lvl < 0 ? '-2σ' : 'μ'
        });
      }
      this.subSeries.push(line);
      this.subChart.timeScale().fitContent();
    }
  }

  root.MahaChart = { TerminalChart, COLORS: C };
})(typeof self !== 'undefined' ? self : this);
