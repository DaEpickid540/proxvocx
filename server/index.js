import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { config, validateConfig } from './config.js';
import { fetchThroughProxy } from './fetcher.js';
import { logger } from './logger.js';
import { UrlRejectedError } from './safe-url.js';

const require = createRequire(import.meta.url);

const REQUESTS_ROOT = 'requests';
const RESPONSES_ROOT = 'responses';
const SWEEP_INTERVAL_MS = 60_000;

/** Bounded worker pool: never run more than `limit` fetches at once. */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  get queued() {
    return this.waiting.length;
  }
}

export class ProxyServer {
  constructor(admin, app) {
    this.admin = admin;
    this.app = app;
    this.db = admin.database(app);
    this.semaphore = new Semaphore(config.maxConcurrentRequests);
    this.inFlight = new Set();
    this.userListeners = new Map();
    this.rootListener = null;
    this.rootRemovedListener = null;
    this.sweepTimer = null;
    this.stopping = false;
    this.stats = { received: 0, succeeded: 0, failed: 0, rejected: 0 };
  }

  start() {
    this.db.ref('.info/connected').on('value', (snap) => {
      if (snap.val()) logger.info('connected to realtime database');
      else logger.warn('disconnected from realtime database, retrying');
    });

    if (config.userId) {
      this.watchUser(config.userId);
      logger.info('watching a single user', { userId: config.userId });
    } else {
      const root = this.db.ref(REQUESTS_ROOT);
      this.rootListener = root.on(
        'child_added',
        (snap) => this.watchUser(snap.key),
        (err) => logger.error('requests listener failed', { err }),
      );
      this.rootRemovedListener = root.on('child_removed', (snap) => this.unwatchUser(snap.key));
      logger.info('watching every user under /requests');
    }

    if (config.responseTtlMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepStaleResponses().catch((err) => logger.error('response sweep failed', { err }));
      }, SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  watchUser(userId) {
    if (!userId || this.userListeners.has(userId) || this.stopping) return;
    const ref = this.db.ref(`${REQUESTS_ROOT}/${userId}`);
    const handler = ref.on(
      'child_added',
      (snap) => {
        this.enqueue(userId, snap.key, snap.val());
      },
      (err) => {
        logger.error('user listener failed', { userId, err });
        this.unwatchUser(userId);
      },
    );
    this.userListeners.set(userId, { ref, handler });
    logger.info('watching user queue', { userId });
  }

  unwatchUser(userId) {
    const entry = this.userListeners.get(userId);
    if (!entry) return;
    entry.ref.off('child_added', entry.handler);
    this.userListeners.delete(userId);
    logger.info('stopped watching user queue', { userId });
  }

  enqueue(userId, requestId, payload) {
    const key = `${userId}/${requestId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.stats.received += 1;
    const log = logger.child({ userId, requestId });
    log.info('request received', {
      url: typeof payload?.url === 'string' ? payload.url.slice(0, 512) : null,
      queued: this.semaphore.queued,
    });

    this.process(userId, requestId, payload, log)
      .catch((err) => log.error('unhandled processing error', { err }))
      .finally(() => this.inFlight.delete(key));
  }

  async process(userId, requestId, payload, log) {
    await this.semaphore.acquire();
    const startedAt = Date.now();
    let record;
    try {
      if (!payload || typeof payload !== 'object') {
        throw new UrlRejectedError('request node is not an object');
      }
      const age = payload.createdAt ? Date.now() - Number(payload.createdAt) : 0;
      if (config.requestMaxAgeMs > 0 && age > config.requestMaxAgeMs) {
        throw new UrlRejectedError(
          `request is ${Math.round(age / 1000)}s old, older than the ${
            Math.round(config.requestMaxAgeMs / 1000)
          }s limit`,
        );
      }
      record = await fetchThroughProxy(payload, config, log);
      this.stats.succeeded += 1;
      log.info('request completed', {
        status: record.status,
        bytes: record.bytes,
        truncated: record.truncated,
        redirects: record.redirects,
        durationMs: record.durationMs,
      });
    } catch (err) {
      const rejected = err instanceof UrlRejectedError;
      if (rejected) this.stats.rejected += 1;
      else this.stats.failed += 1;
      record = {
        ok: false,
        status: 0,
        statusText: '',
        error: err.message,
        errorCode: err.code || 'ERR_UNKNOWN',
        url: typeof payload?.url === 'string' ? payload.url.slice(0, 2048) : null,
        durationMs: Date.now() - startedAt,
      };
      log[rejected ? 'warn' : 'error']('request failed', {
        errorCode: record.errorCode,
        error: err.message,
      });
    } finally {
      this.semaphore.release();
    }

    record.requestId = requestId;
    record.completedAt = this.admin.database.ServerValue.TIMESTAMP;

    // Write the response first, then drop the request, so the client never
    // sees a request vanish without an answer landing.
    try {
      await this.db.ref(`${RESPONSES_ROOT}/${userId}/${requestId}`).set(record);
    } catch (err) {
      log.error('could not write response', { err });
    }
    try {
      await this.db.ref(`${REQUESTS_ROOT}/${userId}/${requestId}`).remove();
      log.debug('request deleted');
    } catch (err) {
      log.error('could not delete request', { err });
    }
  }

  /** Remove responses the client never picked up, so the database stays small. */
  async sweepStaleResponses() {
    const cutoff = Date.now() - config.responseTtlMs;
    const scope = config.userId
      ? [config.userId]
      : Object.keys((await this.db.ref(RESPONSES_ROOT).get()).val() || {});
    let removed = 0;
    for (const userId of scope) {
      const snap = await this.db.ref(`${RESPONSES_ROOT}/${userId}`).get();
      const value = snap.val();
      if (!value) continue;
      const updates = {};
      for (const [requestId, entry] of Object.entries(value)) {
        const completedAt = Number(entry?.completedAt);
        if (Number.isFinite(completedAt) && completedAt < cutoff) {
          updates[requestId] = null;
          removed += 1;
        }
      }
      if (Object.keys(updates).length) {
        await this.db.ref(`${RESPONSES_ROOT}/${userId}`).update(updates);
      }
    }
    if (removed) logger.info('swept stale responses', { removed });
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    logger.info('shutting down', this.stats);

    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.db.ref('.info/connected').off();
    if (this.rootListener) this.db.ref(REQUESTS_ROOT).off('child_added', this.rootListener);
    if (this.rootRemovedListener) {
      this.db.ref(REQUESTS_ROOT).off('child_removed', this.rootRemovedListener);
    }
    for (const userId of [...this.userListeners.keys()]) this.unwatchUser(userId);

    const deadline = Date.now() + 15_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      logger.info('waiting for in-flight requests', { inFlight: this.inFlight.size });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.app.delete().catch((err) => logger.error('error closing firebase app', { err }));
    logger.info('stopped', this.stats);
  }
}

export async function main() {
  validateConfig();

  const admin = require('firebase-admin');
  const serviceAccount = JSON.parse(fs.readFileSync(config.credentialsPath, 'utf8'));
  if (!serviceAccount.project_id || !serviceAccount.private_key) {
    throw new Error(
      `${config.credentialsPath} is not a Firebase service account key ` +
        '(expected project_id and private_key fields)',
    );
  }

  const app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.databaseURL,
  });

  logger.info('proxy server starting', {
    projectId: serviceAccount.project_id,
    databaseURL: config.databaseURL,
    maxConcurrentRequests: config.maxConcurrentRequests,
    requestTimeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    allowPrivateNetwork: config.allowPrivateNetwork,
  });

  const server = new ProxyServer(admin, app);
  server.start();

  const shutdown = (signal) => {
    logger.info('received signal', { signal });
    server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception, exiting', { err });
    server.stop().finally(() => process.exit(1));
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    if (err.code === 'ERR_CONFIG') logger.error(err.message);
    else logger.error('failed to start', { err });
    process.exit(1);
  });
}
