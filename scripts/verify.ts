/**
 * `npm run verify` — the setup doctor.
 *
 * Proves your configuration end-to-end against the Zennopay sandbox:
 *
 *   1. Environment: every var present, PEM parses, key is RSA.
 *   2. JWT self-check: mint → decode → claims sane → signature verifies.
 *   3. Reachability: can we see the Zennopay API at all?
 *   4. HMAC round-trip: create a REAL minimal payment intent ($1.00).
 *      Creating an intent moves no money — nothing happens until a user
 *      confirms in the PaymentSheet.
 *   5. Verdict.
 *
 * Every failure prints a specific hint. Safe to run as many times as you like.
 */
import crypto from 'node:crypto';

import { loadConfig, loadDotEnv, parseJwtPrivateKey, ConfigError, type Config } from '../src/config.js';
import { buildSandboxStubAttestations } from '../src/attestations.js';
import {
  createPaymentIntent,
  ZennopayApiError,
} from '../src/zennopay/client.js';
import {
  decodeJwtUnverified,
  mintSessionJwt,
  verifyJwtSignature,
  SESSION_JWT_AUDIENCE,
} from '../src/zennopay/session.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const ok = (msg: string): void => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const bad = (msg: string): void => console.log(`  ${RED}✗${RESET} ${msg}`);
const hint = (msg: string): void => console.log(`    ${YELLOW}hint:${RESET} ${msg}`);
const note = (msg: string): void => console.log(`    ${DIM}${msg}${RESET}`);
const step = (n: number, title: string): void =>
  console.log(`\n${BOLD}[${n}/4] ${title}${RESET}`);

function fail(stepName: string): never {
  console.log(
    `\n${RED}${BOLD}Not ready yet.${RESET} Failing step: ${RED}${stepName}${RESET}\n` +
      `Fix the hint above and re-run ${BOLD}npm run verify${RESET}.\n`,
  );
  process.exit(1);
}

// ─── Step 1: environment ─────────────────────────────────────────────────────
function checkEnv(): Config {
  step(1, 'Environment variables + signing key');
  const requiredVars = [
    'ZENNOPAY_HMAC_KEY_ID',
    'ZENNOPAY_HMAC_SECRET',
    'ZENNOPAY_JWT_PRIVATE_KEY_B64',
    'ZENNOPAY_JWT_KID',
    'ZENNOPAY_JWT_ISS',
  ];
  const missing = requiredVars.filter(
    (v) => process.env[v] === undefined || process.env[v] === '',
  );
  if (missing.length > 0) {
    bad(`missing env vars: ${missing.join(', ')}`);
    hint('copy .env.example to .env and fill in the values from your onboarding pack');
    fail('environment');
  }
  ok(`all required env vars present`);

  try {
    const key = parseJwtPrivateKey(process.env.ZENNOPAY_JWT_PRIVATE_KEY_B64 as string);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    ok(`JWT private key parses (RSA ${bits}-bit, PKCS#8)`);
    if (bits > 0 && bits < 2048) {
      bad(`RSA key is ${bits}-bit — Zennopay requires 2048-bit or larger`);
      hint('generate a new pair: openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048');
      fail('environment');
    }
  } catch (err) {
    bad((err as Error).message);
    fail('environment');
  }

  const cfg = loadConfig();
  ok(`Zennopay API base URL: ${cfg.baseUrl}`);
  if (cfg.webhookSecret === null) {
    note('ZENNOPAY_WEBHOOK_SECRET not set — webhooks disabled (fine for week 1)');
  }
  return cfg;
}

// ─── Step 2: local JWT self-check ────────────────────────────────────────────
function checkJwt(cfg: Config): void {
  step(2, 'Session JWT self-check (local mint + decode)');
  note('using sandbox stub attestations for this check — wire src/attestations.ts before go-live');
  const minted = mintSessionJwt(cfg, {
    intentId: 'pi_selfcheck_000',
    amountUsdCents: 100,
    corridor: cfg.defaultCorridor,
    partnerUserId: 'selfcheck_user',
    attestations: buildSandboxStubAttestations(),
  });
  const { header, payload } = decodeJwtUnverified(minted.jwt);

  const checks: Array<[string, boolean, string]> = [
    ['header alg = RS256', header.alg === 'RS256', `got ${String(header.alg)}`],
    [`header kid = ${cfg.jwtKid}`, header.kid === cfg.jwtKid, `got ${String(header.kid)}`],
    [`aud = ${SESSION_JWT_AUDIENCE}`, payload.aud === SESSION_JWT_AUDIENCE, `got ${String(payload.aud)}`],
    [`iss = ${cfg.jwtIss}`, payload.iss === cfg.jwtIss, `got ${String(payload.iss)}`],
    [
      'exp - iat = 300s',
      typeof payload.exp === 'number' &&
        typeof payload.iat === 'number' &&
        payload.exp - payload.iat === 300,
      `got ${String(payload.exp)} - ${String(payload.iat)}`,
    ],
    [
      'zennopay:* claims present',
      payload['zennopay:intent_id'] === 'pi_selfcheck_000' &&
        payload['zennopay:amount_usd_cents'] === 100 &&
        typeof payload['zennopay:corridor'] === 'string' &&
        typeof payload['zennopay:kyc_attestation'] === 'object' &&
        typeof payload['zennopay:sanctions_attestation'] === 'object',
      'one or more zennopay:* claims missing/wrong',
    ],
  ];
  for (const [label, pass, detail] of checks) {
    if (pass) {
      ok(label);
    } else {
      bad(`${label} — ${detail}`);
      fail('jwt self-check');
    }
  }

  const publicKey = crypto.createPublicKey(cfg.jwtPrivateKey);
  if (verifyJwtSignature(minted.jwt, publicKey)) {
    ok('signature verifies against the derived public key');
  } else {
    bad('signature does NOT verify against the key pair');
    hint('the private key may be corrupted — re-export it and re-encode with base64');
    fail('jwt self-check');
  }
}

// ─── Step 3: reachability ────────────────────────────────────────────────────
async function checkReachability(cfg: Config): Promise<void> {
  step(3, `Reachability of ${cfg.baseUrl}`);
  for (const path of ['/health', '/v1']) {
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        signal: AbortSignal.timeout(10_000),
      });
      ok(`GET ${path} answered HTTP ${res.status} — the API is reachable`);
      return;
    } catch (err) {
      note(`GET ${path}: ${(err as Error).message}`);
    }
  }
  bad('could not reach the Zennopay API at all');
  hint(
    'check ZENNOPAY_BASE_URL (typo? missing https://?), your network/proxy, ' +
      'and that your firewall allows outbound HTTPS',
  );
  fail('reachability');
}

// ─── Step 4: HMAC round-trip (real intent, no money moved) ───────────────────
async function checkHmacRoundTrip(cfg: Config): Promise<string> {
  step(4, 'HMAC round-trip: create a real $1.00 payment intent');
  note('creating an intent moves no money — funds only move after a user confirms');
  const partnerUserId = process.env.VERIFY_PARTNER_USER_ID ?? 'starter_verify_user';
  try {
    const created = await createPaymentIntent(cfg, {
      partnerUserId,
      amountUsdCents: 100,
      corridor: cfg.defaultCorridor,
    });
    ok(`intent created: ${BOLD}${created.intentId}${RESET}`);
    note(`partner_user_id=${partnerUserId} corridor=${cfg.defaultCorridor}`);
    return created.intentId;
  } catch (err) {
    if (err instanceof ZennopayApiError) {
      bad(`Zennopay answered HTTP ${err.status}`);
      const body = err.body as { error?: { code?: string; message?: string; debug?: unknown } };
      if (err.status === 401) {
        hint('401 = authentication. Walk the canonical-string checklist:');
        note('1. path has NO query string and NO host (just "/v1/payment_intents")');
        note('2. five components joined by \\n with a TRAILING newline after the body hash');
        note('3. body hash = lowercase hex sha256 of the EXACT bytes sent (empty body → empty string)');
        note('4. timestamp is ISO 8601 and within ±5 min — check your server clock (NTP)');
        note('5. nonce is 64 hex chars and fresh per request');
        note('6. signature is base64 (not hex) of HMAC-SHA256 over the canonical string');
        note('7. key id matches the secret (staging vs production packs differ!)');
      } else if (err.status === 404) {
        hint('404 — is ZENNOPAY_BASE_URL pointing at the API host (not a dashboard URL)?');
      } else if (err.status === 422 || err.status === 400) {
        hint('request rejected — check the corridor value and that amount_usd_cents is an integer');
      }
      if (body?.error?.debug !== undefined) {
        console.log(`    ${YELLOW}sandbox debug hints:${RESET}`);
        console.log(
          JSON.stringify(body.error.debug, null, 2)
            .split('\n')
            .map((l) => `      ${l}`)
            .join('\n'),
        );
      }
      note(`full response: ${JSON.stringify(err.body).slice(0, 600)}`);
    } else {
      bad(`request failed before reaching Zennopay: ${(err as Error).message}`);
      hint('network/TLS issue — is an egress proxy interfering?');
    }
    fail('hmac round-trip');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`${BOLD}zennopay-partner-starter — setup doctor${RESET}`);
  loadDotEnv();
  let cfg: Config;
  try {
    cfg = checkEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      bad(err.message);
      fail('environment');
    }
    throw err;
  }
  checkJwt(cfg);
  await checkReachability(cfg);
  const intentId = await checkHmacRoundTrip(cfg);

  console.log(
    `\n${GREEN}${BOLD}Ready for the SDK.${RESET} Your backend can sign requests, ` +
      `mint session JWTs, and create intents (${intentId}).\n` +
      `Next: run ${BOLD}npm run dev${RESET} and point the Zennopay PaymentSheet SDK at ` +
      `POST /checkout/session.\n`,
  );
}

main().catch((err) => {
  console.error(`\n${RED}doctor crashed unexpectedly:${RESET}`, err);
  process.exit(1);
});
