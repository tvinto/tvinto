import path from 'path';
import express, { Application } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/config';
import { deploymentNotes } from './config/deployment';
import { credentialKeySource } from './utils/credentialCipher';
import routes from './routes';
import { globalErrorHandler, describeError } from './utils/errorHandler';
import './utils/database'; // Initialize database
import { xtreamService } from './services/xtream.service';
import { accountsService } from './services/accounts.service';

class App {
  public app: Application;

  constructor() {
    this.app = express();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private initializeMiddlewares(): void {
    // Whose address a request is counted as coming from. Behind a proxy the
    // socket belongs to the proxy, so without this the rate limiter below
    // counts every caller as one -- and with it set too permissively it counts
    // whatever the caller claims. See TRUST_PROXY in .env.example.
    this.app.set('trust proxy', config.trustProxy);

    // Security headers. The default Cross-Origin-Resource-Policy of
    // same-origin stops the browser loading media from this port into a page
    // served from another, which blocks playback; CORS below still controls
    // who may call the API.
    this.app.use(
      helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
      })
    );

    // CORS configuration
    this.app.use(
      cors({
        origin: config.cors.origin,
        methods: ['GET', 'POST', 'DELETE'],
        credentials: config.cors.credentials,
      })
    );

    // Rate limiting
    const limiter = rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
    });
    this.app.use(limiter);

    // Request logging. Log the path only: query strings have historically
    // carried credentials, and an access log is exactly the wrong place for
    // them to end up.
    if (process.env.NODE_ENV !== 'test') {
      morgan.token('pathonly', (req: express.Request) => req.path);
      this.app.use(morgan(':method :pathonly :status :response-time ms'));
    }

    // Body parsing
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Response compression
    this.app.use(compression());

    this.startEpgMaintenance();
  }

  /**
   * Keeps the guide populated in the background.
   *
   * Pruning ran here already, but refreshing could not: the scheduler has no
   * request to take credentials from. Stored credentials give it a provider to
   * ask, so each pass now tops up a bounded batch of channels, favourites
   * first, and the guide fills over successive passes instead of only holding
   * whatever a user happened to open.
   */
  private startEpgMaintenance(): void {
    const SCHEDULE_MINUTES = 30;
    let running = false;

    const runScheduler = async () => {
      // A slow pass must not overlap the next tick and double the load.
      if (running) {
        return;
      }
      running = true;

      try {
        for (const username of xtreamService.getDistinctUsernames()) {
          try {
            await xtreamService.pruneOldEPG(username, 72);
          } catch (error) {
            console.warn(`EPG prune failed for ${username}:`, describeError(error));
          }
        }

        const { enabled, batchSize, requestDelayMs, freshForHours, retryAfterHours } =
          config.epgRefresh;
        if (!enabled) {
          return;
        }

        // Driven by the subscriptions people have actually stored, rather than
        // by one set of credentials in .env. That file is no longer where an
        // account's provider details live, and reading it here would mean the
        // top-up quietly stopped the moment those lines were blanked.
        const subscriptions = accountsService.listActiveCredentials();

        for (const subscription of subscriptions) {
          const result = await xtreamService.refreshEPGBatch(
            subscription.username,
            subscription.password,
            subscription.serverUrl,
            {
              batchSize,
              requestDelayMs,
              freshForHours,
              retryAfterHours,
              userId: subscription.userId
            }
          );

          if (result.attempted > 0) {
            const after = xtreamService.getEPGCoverage(subscription.username);
            console.info(
              `EPG top-up: ${result.attempted} asked, ${result.withData} had data, ` +
                `${result.empty} empty, ${result.failed} failed; ` +
                `coverage ${after.covered}/${after.eligible} channels`
            );
          }
        }
      } catch (error) {
        console.warn('Scheduler run failed:', describeError(error));
      } finally {
        running = false;
      }
    };

    const timer = setInterval(runScheduler, SCHEDULE_MINUTES * 60 * 1000);
    timer.unref?.();
    setTimeout(runScheduler, 10 * 1000).unref?.();
  }

  private initializeRoutes(): void {
    // API routes
    this.app.use('/', routes);
  }

  private initializeErrorHandling(): void {
    // Global error handler
    this.app.use(globalErrorHandler);
  }

  public getServer(): Application {
    return this.app;
  }

  public listen(): void {
    const port = config.port;
    this.app.listen(port, () => {
      console.info(`Server is running on port ${port}`);
      this.reportDeployment();
    });
  }

  /**
   * Says what this instance is, once, on the way up.
   *
   * Worth the noise because each of these settings fails as something else:
   * an unset credential key looks like having no subscription, a missing proxy
   * hop looks like being rate limited for no reason, and open registration
   * looks like nothing at all until someone else has an account. Printed where
   * the cause is still next to the effect.
   */
  private reportDeployment(): void {
    const key = credentialKeySource();

    const notes = deploymentNotes({
      production: config.nodeEnv === 'production',
      registration: (process.env.ACCOUNT_REGISTRATION || 'open').trim().toLowerCase(),
      credentialKeySupplied: key.supplied,
      credentialKeyFile: key.file,
      databasePath: config.database.path,
      databasePathPinned: path.isAbsolute(process.env.DATABASE_PATH?.trim() || ''),
      corsOrigins: config.cors.origin,
      trustProxy: config.trustProxy
    });

    for (const note of notes) {
      if (note.level === 'warn') {
        console.warn(`! ${note.message}`);
      } else {
        console.info(`  ${note.message}`);
      }
    }
  }
}

// Create and start the server
const app = new App();
app.listen();

export default app;
