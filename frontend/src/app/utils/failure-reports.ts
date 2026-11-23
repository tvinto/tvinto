import { Failure, FailureContext, FailureKind } from '@shared/failureReports';

/**
 * Where the places that fail quietly say so (shared/failureReports.ts). A
 * plain module, like held-titles: the guide, the sync, the players and the
 * TMDB and OpenSubtitles clients report without depending on the service
 * that sends, which takes them up once it starts (ErrorReportsService).
 */
let sink: ((failure: Failure) => void) | null = null;

export function setFailureSink(take: ((failure: Failure) => void) | null): void {
  sink = take;
}

export function reportFailure(kind: FailureKind, code: string | number, context: FailureContext = {}): void {
  try {
    sink?.({ kind, code: String(code), context });
  } catch {
    // A report that cannot be made is not the caller's problem.
  }
}

/**
 * A fetch that reports a failing answer by its status only -- 0 when there
 * was no answer at all. Not 404: a film TMDB has no page for, or a
 * subtitle that is gone, is an answer.
 */
export function reportingFetch<I, R extends { status: number }>(
  kind: 'tmdb' | 'opensubtitles',
  fetchImpl: (url: string, init: I) => Promise<R>
): (url: string, init: I) => Promise<R> {
  return async (url, init) => {
    let response: R;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        reportFailure(kind, 0);
      }
      throw error;
    }
    if (response.status >= 400 && response.status !== 404) {
      reportFailure(kind, response.status);
    }
    return response;
  };
}
