// Every setting comes from the environment. Nothing is hard-coded here.
//
// Load order (a variable that is already set always wins, because
// process.loadEnvFile never overrides existing variables):
//   1. the real environment (the check sets PORT and friends)
//   2. <repo root>/.env           local overrides, not committed
//   3. <repo root>/.env.example   the documented defaults, committed
for (const file of ['.env', '.env.example']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // file missing: the next source applies
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

const PIGEON_KEY_PREFIX = 'PIGEON_KEY_WS_';

/**
 * A workspace exists if and only if it has a Pigeon API key:
 * PIGEON_KEY_WS_ACME=pk_... -> workspace "ws_acme".
 */
export function parseWorkspaces(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PIGEON_KEY_PREFIX) || !value) continue;
    const suffix = name.slice(PIGEON_KEY_PREFIX.length).toLowerCase();
    if (suffix) keys[`ws_${suffix}`] = value;
  }
  return keys;
}

function requiredNumber(name: string): number {
  const value = Number(required(name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export const config = {
  port: Number(required('PORT')),
  webOrigin: required('WEB_ORIGIN'),
  graderToken: required('GRADER_TOKEN'),
  mongoUrl: required('MONGO_URL'),
  redisUrl: required('REDIS_URL'),
  elasticsearchUrl: required('ELASTICSEARCH_URL'),
  pigeon: {
    url: required('PIGEON_URL'),
    webhookSecret: required('PIGEON_WEBHOOK_SECRET'),
    /** workspace id -> Pigeon API key */
    apiKeys: parseWorkspaces(process.env),
    sendTimeoutMs: requiredNumber('PIGEON_SEND_TIMEOUT_MS'),
    rateBurst: requiredNumber('PIGEON_RATE_BURST'),
    ratePerSec: requiredNumber('PIGEON_RATE_PER_SEC'),
  },
  outbox: {
    leaseMs: requiredNumber('OUTBOX_LEASE_MS'),
    backoffBaseMs: requiredNumber('OUTBOX_BACKOFF_BASE_MS'),
    backoffMaxMs: requiredNumber('OUTBOX_BACKOFF_MAX_MS'),
    pollMs: requiredNumber('OUTBOX_POLL_MS'),
  },
  oidc: {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    redirectUri: required('OIDC_REDIRECT_URI'),
  },
  paybox: {
    url: required('PAYBOX_URL'),
    secretKey: required('PAYBOX_SECRET_KEY'),
    publishableKey: required('PAYBOX_PUBLISHABLE_KEY'),
    webhookSecret: required('PAYBOX_WEBHOOK_SECRET'),
  },
  realtime: {
    streamMaxLen: requiredNumber('EVENTS_STREAM_MAXLEN'),
    heartbeatMs: requiredNumber('WS_HEARTBEAT_MS'),
  },
  session: {
    ttlSeconds: requiredNumber('SESSION_TTL_SECONDS'),
    loginStateTtlSeconds: requiredNumber('LOGIN_STATE_TTL_SECONDS'),
    /** Secure cookies whenever the app is served over https. */
    secureCookies: required('WEB_ORIGIN').startsWith('https://'),
  },
};

export function workspaceExists(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && Object.hasOwn(config.pigeon.apiKeys, workspace);
}

export function workspaceIds(): string[] {
  return Object.keys(config.pigeon.apiKeys).sort();
}
