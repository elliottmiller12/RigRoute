// Tiny in-memory token-bucket rate limiter and LRU cache. No deps.

export class RateLimiter {
  constructor({ perMinute, burst = perMinute }) {
    this.rate = perMinute / 60000;
    this.burst = burst;
    this.buckets = new Map();
  }
  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, t: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + (now - b.t) * this.rate);
    b.t = now;
    if (this.buckets.size > 10000) this.sweep(now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  sweep(now) {
    for (const [k, b] of this.buckets) if (now - b.t > 600000) this.buckets.delete(k);
  }
}

export class LRU {
  constructor(max = 500, ttlMs = 3600000) { this.max = max; this.ttl = ttlMs; this.map = new Map(); }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() - e.t > this.ttl) { this.map.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, { v, t: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
