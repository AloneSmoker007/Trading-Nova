/**
 * scripts/lib/deadline.js
 *
 * Overall-run deadline guard for ops scripts that talk to the database (H-sec-1).
 * A wedged connection must fail the run with an actionable error instead of
 * hanging CI forever. Used by `scripts/migrate.js`; fetch-based scripts use
 * `scripts/lib/http.js` per-request timeouts plus the same deadlineAt contract.
 */

export class DeadlineExceededError extends Error {
  constructor(message, {label, timeoutMs} = {}) {
    super(message);
    this.name = "DeadlineExceededError";
    this.code = "ETIMEDOUT";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `work` against a deadline. Resolves with the work result, or rejects with
 * `DeadlineExceededError` when `timeoutMs` elapses first.
 *
 * @template T
 * @param {Promise<T>|(()=>Promise<T>)} work
 * @param {{timeoutMs:number, label?:string}} opts
 * @returns {Promise<T>}
 */
export async function withDeadline(work, {timeoutMs, label = "operation"} = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error("withDeadline: timeoutMs must be a positive number");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new DeadlineExceededError(`${label} exceeded its ${timeoutMs}ms deadline`, {label, timeoutMs})),
      timeoutMs
    );
  });
  try {
    return await Promise.race([Promise.resolve(typeof work === "function" ? work() : work), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
