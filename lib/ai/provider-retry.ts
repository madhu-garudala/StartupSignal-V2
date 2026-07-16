type ProviderError = Error & {
  status?: number;
  headers?: Record<string, string | null | undefined>;
};

type RetryOptions = {
  signal?: AbortSignal;
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function isTransientProviderError(error: unknown) {
  const status = (error as ProviderError | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function retryAfterMs(error: unknown) {
  const value = (error as ProviderError | null)?.headers?.["retry-after"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function abortableSleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withTransientProviderRetry<T>(
  operation: () => Promise<T>,
  {
    signal,
    retries = 2,
    baseDelayMs = 1_200,
    sleep = abortableSleep,
  }: RetryOptions = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isTransientProviderError(error) || signal?.aborted) throw error;
      const suggested = retryAfterMs(error);
      const jitter = Math.floor(Math.random() * 250);
      const backoff = baseDelayMs * (2 ** attempt) + jitter;
      await sleep(Math.min(4_000, suggested ?? backoff), signal);
    }
  }
}
