/**
 * Errno and undici codes of a connection that failed or was cut before the
 * response was complete. Only these, and undici's own two transport-failure
 * shapes, are worth one more attempt.
 */
const TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"
]);

/**
 * Whether one upstream call failed in transport — before a complete HTTP
 * response existed — rather than by answering, being aborted, or being refused.
 *
 * Pilot run57 lost a turn to exactly this: the provider closed the socket
 * mid-response (`TypeError: terminated <- SocketError: other side closed`), the
 * proxy answered 503, and the worker runs with `max_retries = 0`, so one dropped
 * connection ended the turn. Such a fault says nothing about the request, so the
 * proxy retries it once (`grokBrokerProxy.ts`). Everything else is never retried
 * here: an HTTP status is upstream's answer and reaches the worker as one, an
 * abort is the turn's own limit or end, and a refusal, run-budget limit or
 * credential fault is not made better by repeating it.
 *
 * Undici reports a connect failure as `TypeError: fetch failed` and a body cut
 * mid-stream as `TypeError: terminated`, each with the socket error as `cause`.
 */
export function isGrokUpstreamTransportFault(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true || !(error instanceof Error) || error.name === "AbortError") return false;
  if (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) return true;
  for (const value of [error, error.cause]) {
    const code = (value as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && TRANSPORT_CODES.has(code)) return true;
  }
  return false;
}
