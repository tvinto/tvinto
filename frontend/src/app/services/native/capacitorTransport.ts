import { CapacitorHttp } from '@capacitor/core';
import { XtreamError } from '@shared/xtream/protocol';
import { XtreamResponse, XtreamTransport, noResponse, timedOut } from '@shared/xtream/transport';

/**
 * How a packaged app reaches the provider.
 *
 * CapacitorHttp rather than fetch, and that is the entire reason the native
 * build exists. A request made from the WebView is a browser request: subject
 * to the same-origin policy, and to the rule that an https page may not load
 * http content. This one is made by the platform underneath, where neither
 * applies -- which is what lets a phone talk to an HTTP-only provider with no
 * server of ours in between.
 *
 * The counterpart to AxiosTransport. Everything above this is the same code.
 */
export class CapacitorTransport implements XtreamTransport {
  constructor(private readonly defaultTimeoutMs = 15_000) {}

  async get(
    url: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<XtreamResponse> {
    try {
      const response = await CapacitorHttp.get({
        url,
        params: this.asStrings(params),
        connectTimeout: timeoutMs ?? this.defaultTimeoutMs,
        readTimeout: timeoutMs ?? this.defaultTimeoutMs,
        headers: { Accept: 'application/json' }
      });

      return { status: response.status, data: response.data };
    } catch (error) {
      throw describeFailure(error);
    }
  }

  /**
   * Query parameters, as strings.
   *
   * The plugin takes a string map and hands anything else across the bridge
   * unpredictably -- a number arriving as "[object Object]" would be a request
   * that silently asks the wrong question.
   */
  private asStrings(params: Record<string, unknown>): Record<string, string> {
    const strings: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        strings[key] = String(value);
      }
    }
    return strings;
  }
}

/**
 * Says which kind of failure this was, in the terms the shared code reads.
 *
 * The plugin reports failures as plain messages rather than as codes, so this
 * has to read them. Better than treating every failure as unreachable: a
 * timeout and a refusal mean different things to the sync, and one of them
 * must not be retried.
 */
function describeFailure(error: unknown): Error {
  const message = String((error as { message?: string })?.message ?? error ?? '');

  if (/timeout|timed out/i.test(message)) {
    return timedOut();
  }
  if (/unable to resolve host|failed to connect|network|unreachable/i.test(message)) {
    return noResponse();
  }

  return new XtreamError(message || 'Request failed', 502);
}
