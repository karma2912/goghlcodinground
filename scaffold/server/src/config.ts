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
  },
  oidc: {
    issuer: required('OIDC_ISSUER'),
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: required('OIDC_CLIENT_SECRET'),
    redirectUri: required('OIDC_REDIRECT_URI'),
  },
};

export function workspaceExists(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && Object.hasOwn(config.pigeon.apiKeys, workspace);
}

export function workspaceIds(): string[] {
  return Object.keys(config.pigeon.apiKeys).sort();
}
