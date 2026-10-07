// src/market-data/stream.js
//
// Market stream supervisor with an explicit resync protocol.
//
// Previous behaviour was permanently stuck after one dropped message: the only
// way out of GAP was the exact missing sequence number (a stale replay of it
// flipped state back to CONNECTED on out-of-order data), and `start()` never
// reset the sequence baseline, so a reconnect's new sequence base was rejected
// as a gap forever. Now:
//   * every subscription has a session epoch; events captured by an old
//     subscription are rejected as STALE_SESSION,
//   * a GAP is terminal for that subscription — late/out-of-order replays can
//     NOT silently heal it (they return RESYNC_REQUIRED),
//   * `resync()` (or `start()`) re-subscribes under a new epoch with a fresh
//     sequence baseline, and the optional `onGap` hook lets the host trigger it.
export class MarketStreamSupervisor {
  constructor({connect, now = () => Date.now(), maxAgeMs = 10000, maxRetries = 5, onGap = null} = {}) {
    if (typeof connect !== "function") throw new Error("stream connect required");
    this.connect = connect;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.maxRetries = maxRetries;
    this.onGap = onGap;
    this.state = "DISCONNECTED";
    this.lastEventAt = null;
    this.sequence = null;
    this.session = 0;
    this.retries = 0;
  }

  async start() {
    return this.resync();
  }

  // Re-subscribe under a new session epoch with a fresh sequence baseline.
  // Events still flowing from the previous subscription are rejected.
  async resync() {
    this.session += 1;
    const session = this.session;
    this.sequence = null;
    this.state = "CONNECTING";
    this.retries = 0;
    return this.connect({
      onEvent: (e) => this.accept(e, session),
      onClose: () => {
        if (session !== this.session) return;
        this.state = "DISCONNECTED";
      },
      onError: () => {
        if (session !== this.session) return;
        this.state = "DEGRADED";
      }
    }).then((x) => {
      if (session === this.session) {
        this.state = "CONNECTED";
        this.retries = 0;
      }
      return x;
    });
  }

  accept(event, session = this.session) {
    if (!event?.sequence && event?.sequence !== 0) throw new Error("market sequence required");
    if (session !== this.session) return {accepted: false, reason: "STALE_SESSION"};
    if (this.state === "GAP") return {accepted: false, reason: "RESYNC_REQUIRED"};
    if (this.sequence !== null && event.sequence !== this.sequence + 1) {
      this.state = "GAP";
      if (typeof this.onGap === "function") this.onGap({expected: this.sequence + 1, received: event.sequence});
      return {accepted: false, reason: "SEQUENCE_GAP"};
    }
    this.sequence = event.sequence;
    this.lastEventAt = this.now();
    this.state = "CONNECTED";
    return {accepted: true};
  }

  freshness() {
    return this.lastEventAt !== null && this.now() - this.lastEventAt <= this.maxAgeMs;
  }

  canTrade() {
    return this.state === "CONNECTED" && this.freshness();
  }

  backoffMs() {
    const n = Math.min(this.retries++, this.maxRetries);
    return Math.min(30000, 250 * 2 ** n);
  }
}
