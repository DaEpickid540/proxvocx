import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env') {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${parsed}`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const credentialsPath = path.resolve(
  process.cwd(),
  process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json',
);

export const config = {
  credentialsPath,
  databaseURL: (process.env.FIREBASE_DATABASE_URL || '').trim(),
  userId: (process.env.PROXY_USER_ID || '').trim() || null,
  requestTimeoutMs: int('REQUEST_TIMEOUT_MS', 20_000, { min: 1000, max: 120_000 }),
  maxResponseBytes: int('MAX_RESPONSE_BYTES', 256 * 1024, { min: 1024, max: 8 * 1024 * 1024 }),
  maxRedirects: int('MAX_REDIRECTS', 5, { min: 0, max: 10 }),
  maxConcurrentRequests: int('MAX_CONCURRENT_REQUESTS', 4, { min: 1, max: 32 }),
  allowPrivateNetwork: bool('ALLOW_PRIVATE_NETWORK', false),
  requestMaxAgeMs: int('REQUEST_MAX_AGE_MS', 120_000, { min: 0 }),
  responseTtlMs: int('RESPONSE_TTL_MS', 300_000, { min: 0 }),
  userAgent: process.env.PROXY_USER_AGENT || 'proxvocx/1.0 (+firebase-rtdb-proxy)',
};

export function validateConfig() {
  const problems = [];
  if (!fs.existsSync(config.credentialsPath)) {
    problems.push(
      `service account key not found at ${config.credentialsPath} — download it from ` +
        'Firebase console > Project settings > Service accounts, or point ' +
        'GOOGLE_APPLICATION_CREDENTIALS at it',
    );
  }
  if (!config.databaseURL) {
    problems.push('FIREBASE_DATABASE_URL is not set (e.g. https://<project>-default-rtdb.firebaseio.com)');
  } else if (!/^https:\/\/[\w.-]+\/?$/.test(config.databaseURL)) {
    problems.push(`FIREBASE_DATABASE_URL does not look like a database URL: ${config.databaseURL}`);
  }
  if (problems.length) {
    const err = new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.code = 'ERR_CONFIG';
    throw err;
  }
  return config;
}
