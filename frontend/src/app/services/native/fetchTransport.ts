import { XtreamError } from '@shared/xtream/protocol';
import { XtreamResponse, XtreamTransport, noResponse, timedOut } from '@shared/xtream/transport';

/**
 * How the desktop reaches the provider.
 *
 * Plain fetch, which in a browser could not do this at all -- the provider is
 * HTTP-only and cross-origin, and both rules are the browser's own. The Electron
 * window runs with web security off, so neither applies, and the ordinary
 * request the browser refuses to make is simply made.
 *
 * The counterpart of CapacitorTransport, which exists because Android has no
 * such escape: there the request has to be handed to the platform underneath.
 * Here the platform is already underneath.
 */
export class FetchTransport implements XtreamTransport {
  constructor(private readonly defaultTimeoutMs = 15_000) {}

  async get(
    url: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<XtreamResponse> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        query.set(key, String(value));
      }
    }

    // fetch has no timeout of its own, and a provider that accepts a connection
    // and then says nothing would otherwise hang the request for ever.
    const abort = new AbortController();
    const expiry = setTimeout(() => abort.abort(), timeoutMs ?? this.defaultTimeoutMs);

    try {
      const response = await fetch(`${url}?${query.toString()}`, {
        signal: abort.signal,
        headers: { Accept: 'application/json' }
      });

      // Read as text and parse here: these servers answer with a JSON body
      // under a content type of text/html often enough that trusting the header
      // means throwing away a perfectly good answer.
      const body = await response.text();
      const data = this.parse(body);

      // Enough to tell an empty answer from a refused one from a malformed one,
      // which from the outside all look like a category with nothing in it.
      console.info(
        `[provider] ${String(params['action'] ?? 'auth')}` +
          `${params['category_id'] ? ` cat=${String(params['category_id'])}` : ''}` +
          ` -> ${response.status}, ${body.length} bytes, ` +
          `${Array.isArray(data) ? `${data.length} items` : typeof data}`
      );

      return { status: response.status, data };
    } catch (error) {
      throw this.describe(error);
    } finally {
      clearTimeout(expiry);
    }
  }

  private parse(body: string): unknown {
    if (!body) {
      return null;
    }
    try {
      return JSON.parse(body);
    } catch {
      // Handed back as it came. The layer above decides what an unparseable
      // answer means, and for some calls a bare string is a valid one.
      return body;
    }
  }

  private describe(error: unknown): Error {
    if ((error as { name?: string })?.name === 'AbortError') {
      return timedOut();
    }

    // fetch reports every network-level failure as the same TypeError, so
    // there is nothing finer to distinguish here.
    if (error instanceof TypeError) {
      return noResponse();
    }

    return new XtreamError(String((error as { message?: string })?.message ?? error), 502);
  }
}
