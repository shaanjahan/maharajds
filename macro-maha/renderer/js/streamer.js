// Macro Maha — realtime market data via Yahoo Finance's websocket streamer.
// Yahoo pushes base64-encoded protobuf "PricingData" messages. We decode the
// wire format directly (varint / zigzag / float32) — no protobuf dependency.
// Falls back to nothing here: app.js runs a REST polling loop as the safety
// net whenever the stream is not LIVE.
(function (root) {
  'use strict';

  const WS_URL = 'wss://streamer.finance.yahoo.com/?version=2';

  // Field numbers from the community-documented PricingData schema.
  const FIELDS = {
    1: ['id', 'str'],
    2: ['price', 'f32'],
    3: ['time', 'sint'],
    4: ['currency', 'str'],
    5: ['exchange', 'str'],
    6: ['quoteType', 'varint'],
    7: ['marketHours', 'varint'],
    8: ['changePercent', 'f32'],
    9: ['dayVolume', 'sint'],
    10: ['dayHigh', 'f32'],
    11: ['dayLow', 'f32'],
    12: ['change', 'f32'],
    13: ['shortName', 'str'],
    15: ['openPrice', 'f32'],
    16: ['previousClose', 'f32'],
    23: ['bid', 'f32'],
    24: ['bidSize', 'sint'],
    25: ['ask', 'f32'],
    26: ['askSize', 'sint'],
    27: ['priceHint', 'sint']
  };

  const MARKET_HOURS = ['PRE', 'REGULAR', 'POST', 'EXTENDED'];

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decodePricingData(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = {};
    let i = 0;

    function varint() {
      let x = 0n;
      let s = 0n;
      for (;;) {
        if (i >= bytes.length) throw new Error('truncated varint');
        const b = bytes[i++];
        x |= BigInt(b & 0x7f) << s;
        if (!(b & 0x80)) return x;
        s += 7n;
      }
    }

    while (i < bytes.length) {
      const tag = Number(varint());
      const field = tag >> 3;
      const wire = tag & 7;
      const spec = FIELDS[field];
      if (wire === 0) {
        const raw = varint();
        if (spec) {
          const val =
            spec[1] === 'sint' ? Number((raw >> 1n) ^ -(raw & 1n)) : Number(raw);
          out[spec[0]] = val;
        }
      } else if (wire === 1) {
        if (spec) out[spec[0]] = view.getFloat64(i, true);
        i += 8;
      } else if (wire === 5) {
        if (spec) out[spec[0]] = view.getFloat32(i, true);
        i += 4;
      } else if (wire === 2) {
        const len = Number(varint());
        if (spec && spec[1] === 'str') {
          out[spec[0]] = new TextDecoder().decode(bytes.subarray(i, i + len));
        }
        i += len;
      } else {
        break; // unknown wire type — bail rather than misparse
      }
    }
    if (out.marketHours != null) out.marketHoursLabel = MARKET_HOURS[out.marketHours] || String(out.marketHours);
    return out;
  }

  class Streamer {
    constructor({ onTick, onStatus }) {
      this.onTick = onTick || (() => {});
      this.onStatus = onStatus || (() => {});
      this.symbols = new Set();
      this.ws = null;
      this.backoff = 1000;
      this.closedByUser = false;
      this.lastTickAt = 0;
    }

    connect() {
      this.closedByUser = false;
      this._open();
    }

    _open() {
      try {
        this.ws = new WebSocket(WS_URL);
      } catch (e) {
        this._scheduleReconnect();
        return;
      }
      this.onStatus('connecting');

      this.ws.onopen = () => {
        this.backoff = 1000;
        this.onStatus('live');
        this._sendSubscriptions();
      };

      this.ws.onmessage = (ev) => {
        let b64 = ev.data;
        if (typeof b64 === 'string' && b64.startsWith('{')) {
          try {
            const obj = JSON.parse(b64);
            b64 = obj.message || obj.data || '';
          } catch (_e) {
            return;
          }
        }
        if (!b64) return;
        try {
          const tick = decodePricingData(b64ToBytes(b64));
          if (tick.id && tick.price != null) {
            this.lastTickAt = Date.now();
            this.onTick(tick);
          }
        } catch (_e) {
          /* ignore malformed frames */
        }
      };

      this.ws.onclose = () => {
        if (!this.closedByUser) this._scheduleReconnect();
      };
      this.ws.onerror = () => {
        try { this.ws.close(); } catch (_e) { /* noop */ }
      };
    }

    _scheduleReconnect() {
      this.onStatus('reconnecting');
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._open(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    }

    _sendSubscriptions() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.symbols.size) {
        this.ws.send(JSON.stringify({ subscribe: Array.from(this.symbols) }));
      }
    }

    subscribe(symbols) {
      const fresh = [];
      for (const s of symbols) {
        const up = s.toUpperCase();
        if (!this.symbols.has(up)) {
          this.symbols.add(up);
          fresh.push(up);
        }
      }
      if (fresh.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ subscribe: fresh }));
      }
    }

    unsubscribe(symbols) {
      const gone = [];
      for (const s of symbols) {
        const up = s.toUpperCase();
        if (this.symbols.delete(up)) gone.push(up);
      }
      if (gone.length && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ unsubscribe: gone }));
      }
    }

    isLive() {
      return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
    }

    close() {
      this.closedByUser = true;
      clearTimeout(this._timer);
      if (this.ws) {
        try { this.ws.close(); } catch (_e) { /* noop */ }
      }
    }
  }

  root.MahaStreamer = { Streamer, decodePricingData, b64ToBytes };
})(typeof self !== 'undefined' ? self : this);
