/** Global flood limiter. Deliberately not keyed by IP: the server never looks at addresses. */
export class TokenBucket {
  constructor(capacity, perSecond, now = () => Date.now()) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }

  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
