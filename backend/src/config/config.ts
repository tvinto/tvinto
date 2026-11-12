import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { resolveTrustProxy } from './deployment';

dotenv.config();

/** The backend package directory, two levels up from src/config. */
const PACKAGE_ROOT = path.resolve(__dirname, '../..');

/** Where the cache lives when DATABASE_PATH is not set. */
const DEFAULT_DATABASE_FILE = 'xtream-cache.db';

/**
 * Resolves DATABASE_PATH to the file the cache actually opens.
 *
 * Relative paths are resolved against the backend package, not the working
 * directory, so the setting names the same file however the server is started.
 * The containing directory is created if it does not exist, since better-sqlite3
 * will not create one.
 */
const resolveDatabasePath = (): string => {
  const configured = process.env.DATABASE_PATH?.trim();
  const resolved = path.resolve(PACKAGE_ROOT, configured || DEFAULT_DATABASE_FILE);

  const dir = path.dirname(resolved);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.warn(`Failed to create database directory: ${dir}`, error);
  }

  return resolved;
};

export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database configuration
  database: {
    path: resolveDatabasePath(),
  },
  
  // CORS configuration
  // More than one origin, because more than one thing is the app now. The dev
  // server is on :4200; the packaged Android build serves its own pages from
  // http://localhost with no port, so it is a different origin entirely and
  // would otherwise be refused by a setting that names only the browser.
  cors: {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:4200,http://localhost')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  },
  
  /**
   * How many proxies stand in front of this process.
   *
   * Nothing local, one for a host that terminates TLS and forwards, two if
   * there is an nginx behind that. It decides which address a request is
   * counted against below, so leaving it unset behind a proxy makes the rate
   * limit a single shared allowance for every caller at once.
   */
  trustProxy: resolveTrustProxy(process.env.TRUST_PROXY),

  // Rate limiting
  // Guards against a runaway client, not against a busy one. Watching
  // something writes a resume point every ten seconds, so a quarter of an hour
  // of playback is ninety requests on its own; browsing, guide lookups and
  // favourites go on top. The old ceiling of 100 per window was below what one
  // person watching one thing needs, and playback stopped with 429s.
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000', 10), // per window per IP
  },
  
  // Xtream API configuration
  xtreamBaseUrl: process.env.XTREAM_BASE_URL || 'http://your-xtream-server.com/player_api.php',

  /*
   * `xtreamCredentials` used to be here: a provider username and password out
   * of the environment, which the backend could turn into a session without
   * anybody typing anything. The endpoint that did that went when accounts
   * arrived, and the field outlived it -- read by its own test and by nothing
   * else, while the password sat in a file in plaintext.
   *
   * Removed rather than left unused. A configuration field that still exists
   * is an invitation to wire it back up.
   */

  // Session configuration
  session: {
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    maxAge: parseInt(process.env.SESSION_MAX_AGE || '86400000', 10), // 24 hours
  },
  
  /**
   * How hard a sync leans on the provider.
   *
   * A sync asks for streams one category at a time, so the concurrency is the
   * number of simultaneous requests it makes. Twenty at once with a ten second
   * timeout made this provider time out on hundreds of categories, and each one
   * that timed out was left empty until someone noticed.
   */
  sync: {
    categoryConcurrency: parseInt(process.env.SYNC_CONCURRENCY || '5', 10),
    // Generous: a slow answer is still worth waiting for, and giving up early
    // is what leaves a category empty.
    requestTimeoutMs: parseInt(process.env.SYNC_REQUEST_TIMEOUT_MS || '45000', 10),
    // One extra go at a category that failed, before the run writes it off.
    retries: parseInt(process.env.SYNC_RETRIES || '1', 10),
    delayBetweenBatchesMs: parseInt(process.env.SYNC_BATCH_DELAY_MS || '250', 10),
  },

  /**
   * Background EPG top-up. Off unless credentials are stored, since the
   * scheduler has no other way to talk to the provider.
   *
   * Deliberately conservative: each pass is one request per channel, so the
   * batch size is the ceiling on how hard a single tick leans on the provider.
   */
  epgRefresh: {
    enabled: (process.env.EPG_AUTO_REFRESH || 'true').toLowerCase() !== 'false',
    batchSize: parseInt(process.env.EPG_REFRESH_BATCH || '40', 10),
    // Space out requests so a pass trickles rather than bursts.
    requestDelayMs: parseInt(process.env.EPG_REFRESH_DELAY_MS || '250', 10),
    // A channel is left alone while its guide still reaches this far ahead.
    freshForHours: parseInt(process.env.EPG_FRESH_HOURS || '6', 10),
    // How long before a channel is asked again. Most channels return nothing,
    // so without this the queue never gets past the first barren batch.
    retryAfterHours: parseInt(process.env.EPG_RETRY_HOURS || '12', 10),
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // SSL/TLS (for production)
  ssl: {
    enabled: process.env.HTTPS === 'true',
    certPath: process.env.SSL_CERT_PATH,
    keyPath: process.env.SSL_KEY_PATH,
    port: parseInt(process.env.HTTPS_PORT || '443', 10),
  },
} as const;

export type Config = typeof config;
