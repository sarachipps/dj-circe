// retryable(fn, opts): bounded retry with per-attempt backoff.
//   attempts   — total attempts including the first (must be >= 1)
//   backoffMs  — array of delays in ms; backoffMs[i] applies between attempt
//                i+1 and i+2 (0-indexed). Length must be >= attempts - 1.
//   isRetryable(err) — decides whether to retry after a rejection
//   onAttempt(n, err) — called with n = attempt number ABOUT TO RUN (2, 3, …)
//                       and the error that triggered the retry
//   disabled   — if true, run fn once and bypass retry logic entirely
async function retryable(fn, opts) {
  const { attempts, backoffMs, isRetryable, onAttempt, disabled } = opts;
  if (disabled) return fn();
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !isRetryable(err)) throw err;
      const delay = backoffMs[i] || 0;
      if (typeof onAttempt === 'function') {
        try { onAttempt(i + 2, err); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

module.exports = { retryable };
