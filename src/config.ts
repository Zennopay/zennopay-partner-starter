/**
 * Configuration — everything comes from environment variables.
 *
 * A tiny `.env` loader is included so `npm run dev` / `npm run verify` work
 * out of the box without extra dependencies. In production, inject env vars
 * through your platform's secret manager (Cloud Run, Render, Fly, etc.) —
 * never bake secrets into images or commit them to git.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  /** Zennopay API base URL (sandbox or production) — from your onboarding pack. */
  baseUrl: string;
  /** HMAC key id issued by Zennopay (identifies your partner key). */
  hmacKeyId: string;
  /** HMAC shared secret paired with the key id. Server-side only. */
  hmacSecret: string;
  /** Your RS256 signing key for checkout-session JWTs (private half). */
  jwtPrivateKey: crypto.KeyObject;
  /** Key id ("kid") registered with Zennopay for the JWT public key. */
  jwtKid: string;
  /** Issuer URL registered with Zennopay (must match exactly). */
  jwtIss: string;
  /** Port for the HTTP server. */
  port: number;
  /**
   * Secret used to verify inbound Zennopay webhooks (X-Zennopay-Signature).
   * Optional at boot: the webhook route answers 501 until it is configured.
   */
  webhookSecret: string | null;
  /** Default corridor when the client does not send one (e.g. "vn_vietqr"). */
  defaultCorridor: string;
}

/**
 * Minimal .env parser (KEY=VALUE lines, `#` comments, optional quotes).
 * Existing process.env values always win, so platform-injected secrets are
 * never overridden by a stray local file.
 */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
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

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v.trim() === '') {
    throw new ConfigError(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in ` +
        `(values come from your Zennopay onboarding pack).`,
    );
  }
  return v.trim();
}

/**
 * Decode + validate the JWT private key: base64(PKCS#8 PEM) → KeyObject.
 * Fails fast with a specific message — a malformed key would otherwise only
 * surface as a cryptic signing error at request time.
 */
export function parseJwtPrivateKey(b64: string): crypto.KeyObject {
  let pem: string;
  try {
    pem = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw new ConfigError('ZENNOPAY_JWT_PRIVATE_KEY_B64 is not valid base64.');
  }
  if (!pem.includes('-----BEGIN')) {
    throw new ConfigError(
      'ZENNOPAY_JWT_PRIVATE_KEY_B64 decoded to something that is not a PEM. ' +
        'Expected: base64 of a PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----"). ' +
        'Generate the value with: base64 -i your_private_pkcs8.pem | tr -d "\\n"',
    );
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    throw new ConfigError(
      `ZENNOPAY_JWT_PRIVATE_KEY_B64 decoded to a PEM that Node cannot parse: ` +
        `${(err as Error).message}. It must be PKCS#8 ("BEGIN PRIVATE KEY", not ` +
        `"BEGIN RSA PRIVATE KEY"). Convert with: ` +
        `openssl pkcs8 -topk8 -nocrypt -in rsa_key.pem -out pkcs8.pem`,
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new ConfigError(
      `JWT private key is "${key.asymmetricKeyType}", but Zennopay session JWTs ` +
        `are RS256 — the key must be RSA (2048-bit or larger).`,
    );
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env.ZENNOPAY_BASE_URL ?? 'https://api.sandbox.zennopay.com')
    .trim()
    .replace(/\/+$/, '');
  const webhookSecret = env.ZENNOPAY_WEBHOOK_SECRET?.trim();
  return {
    baseUrl,
    hmacKeyId: required(env, 'ZENNOPAY_HMAC_KEY_ID'),
    hmacSecret: required(env, 'ZENNOPAY_HMAC_SECRET'),
    jwtPrivateKey: parseJwtPrivateKey(required(env, 'ZENNOPAY_JWT_PRIVATE_KEY_B64')),
    jwtKid: required(env, 'ZENNOPAY_JWT_KID'),
    jwtIss: required(env, 'ZENNOPAY_JWT_ISS'),
    port: Number.parseInt(env.PORT ?? '8787', 10),
    webhookSecret: webhookSecret !== undefined && webhookSecret !== '' ? webhookSecret : null,
    defaultCorridor: env.ZENNOPAY_DEFAULT_CORRIDOR?.trim() || 'vn_vietqr',
  };
}
