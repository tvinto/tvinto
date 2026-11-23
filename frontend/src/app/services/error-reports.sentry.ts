/**
 * The parts of Sentry the web app uses, by name, so the bundler leaves out
 * the rest (tracing, replay, feedback, breadcrumbs). Loaded as a chunk of its
 * own, and only once reports are on (ErrorReportsService).
 */
export {
  browserApiErrorsIntegration,
  captureException,
  dedupeIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration
} from '@sentry/angular';
