import { XtreamError } from './protocol';

/** What a transport gives back: the status line and the parsed body. */
export interface XtreamResponse {
  status: number;
  data: unknown;
}

/**
 * How a request actually gets made.
 *
 * The one thing that genuinely differs between the places this code runs. The
 * backend has axios and no restrictions; a phone has the platform's own HTTP,
 * with none of a browser's rules about origins or mixed content in the way; a
 * browser has neither and must go through the backend. Everything above this
 * interface is the same on all three.
 *
 * A transport reports its own failures as XtreamError with a status the rest
 * of the app already reads: 408 for a timeout, 502 for a request that got no
 * answer at all. Deciding what those mean is not its job -- only saying which
 * happened, in terms nothing above it has to know axios or fetch to interpret.
 */
export interface XtreamTransport {
  get(url: string, params: Record<string, unknown>, timeoutMs?: number): Promise<XtreamResponse>;
}

/** A timeout, in the terms the rest of the code reads. */
export function timedOut(message = 'Request to Xtream server timed out'): XtreamError {
  return new XtreamError(message, 408);
}

/** A request that reached nothing, as distinct from one that was refused. */
export function noResponse(message = 'No response received from Xtream server'): XtreamError {
  return new XtreamError(message, 502);
}
