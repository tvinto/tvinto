import axios, { AxiosError, AxiosInstance } from 'axios';
import { XtreamError } from '../../../shared/xtream/protocol';
import { XtreamResponse, XtreamTransport, noResponse, timedOut } from '../../../shared/xtream/transport';

/** What the provider is told we are, on every request. */
const USER_AGENT = 'IPTV-Xtream-Loader/1.0';

/** Long enough for a slow provider, short enough not to hold a request forever. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The server's way of reaching a provider.
 *
 * The only part of talking to Xtream that is specific to running on Node, and
 * therefore the only part a phone will replace. Everything it knows about
 * axios stops here: what it hands upward is a status and a body, or one of two
 * failures stated in terms the rest of the code already reads.
 */
export class AxiosTransport implements XtreamTransport {
  constructor(private readonly api: AxiosInstance = defaultInstance()) {}

  async get(
    url: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<XtreamResponse> {
    try {
      const response = await this.api.get(url, {
        params,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
        // Statuses are the caller's to interpret: a 403 means something
        // particular here, and axios throwing would flatten it into a generic
        // failure before anyone could look.
        validateStatus: () => true
      });

      return { status: response.status, data: response.data };
    } catch (error) {
      throw describeTransportFailure(error);
    }
  }
}

function defaultInstance(): AxiosInstance {
  return axios.create({
    timeout: DEFAULT_TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  });
}

/**
 * Says which kind of failure this was, without axios leaking upward.
 *
 * The distinction that matters: a timeout and a request that reached nothing
 * are both the provider failing to serve us, while anything else is a fault on
 * this side and should not be mistaken for an outage.
 */
function describeTransportFailure(error: unknown): Error {
  const axiosError = error as AxiosError;

  if (axiosError?.code === 'ECONNABORTED' || axiosError?.code === 'ETIMEDOUT') {
    return timedOut();
  }
  if (axiosError?.request) {
    return noResponse();
  }
  if (axiosError?.message) {
    return new XtreamError(`Request setup error: ${axiosError.message}`, 400);
  }

  return error instanceof Error ? error : new XtreamError('Request failed', 500);
}
