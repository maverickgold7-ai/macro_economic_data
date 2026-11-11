/**
 * fetch() with a hard timeout so one slow/hung source cannot stall an ingest run.
 * Default 30s; override per call or via INGEST_FETCH_TIMEOUT_MS.
 * An existing init.signal is respected (whichever aborts first wins).
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.INGEST_FETCH_TIMEOUT_MS) || 30_000;

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit & { next?: unknown } = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (timeout.aborted) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      throw new Error(`Timed out after ${timeoutMs}ms: ${url.split("?")[0]}`);
    }
    throw err;
  }
}
