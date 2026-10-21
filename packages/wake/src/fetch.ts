// Bounded outbound HTTP. A stalled OpenCode/board request must never hold the
// serialized wake queue forever; the timeout aborts the client request.

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Bound outbound HTTP waits so one stalled OpenCode/API request cannot hold the
 * serialized wake queue forever. The timeout aborts the client request; for
 * prompt_async, delivery can be ambiguous if the server accepted it just before
 * the response stalled, so callers must not assume timeout means not delivered.
 */
export const WATCH_REQUEST_TIMEOUT_MS = 30_000;

export function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = WATCH_REQUEST_TIMEOUT_MS,
  fetchImpl: FetchLike = (url, options) => fetch(url, options),
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  return fetchImpl(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  });
}
