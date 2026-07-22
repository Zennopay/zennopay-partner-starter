/**
 * `npm run verify` — the setup doctor (Model B).
 *
 * Proves your configuration end-to-end against the Zennopay sandbox:
 *
 *   1. Environment: HMAC key id + secret present; base URL sane. (The JWT
 *      keypair is OPTIONAL under Model B — only used by receipts.)
 *   2. Reachability: can we see the Zennopay API at all?
 *   3. HMAC round-trip: create a REAL minimal payment intent ($1.00) and
 *      confirm Zennopay MINTS and returns a `session_token`. Creating an
 *      intent moves no money — nothing happens until a user confirms in the
 *      PaymentSheet. The token is decoded (iss/aud) for a quick sanity check.
 *
 * Every failure prints a specific hint. Safe to run as many times as you like.
 */
import {
  loadConfig,
  loadDotEnv,
  ConfigError,
  type Config,
} from '../src/config.js';
import { buildSandboxStubAttestations } from '../src/attestations.js';
import { createPaymentIntent, ZennopayApiError } from '../src/zennopay/client.js';
import { decodeJwtUnverified } from '../src/zennopay/jwt.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const SESSION_JWT_AUDIENCE = 'zennopay-checkout';

const ok = (msg: string): void => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const bad = (msg: string): void => console.log(`  ${RED}✗${RESET} ${msg}`);
const hint = (msg: string): void => console.log(`    ${YELLOW}hint:${RESET} ${msg}`);
const note = (msg: string): void => console.log(`    ${DIM}${msg}${RESET}`);
const step = (n: number, title: string): void =>
  console.log(`\n${BOLD}[${n}/3] ${title}${RESET}`);

function fail(stepName: string): never {
  console.log(
    `\n${RED}${BOLD}Not ready yet.${RESET} Failing step: ${RED}${stepName}${RESET}\n` +
      `Fix the hint above and re-run ${BOLD}npm run verify${RESET}.\n`,
  );
  process.exit(1);
}

// ─── Step 1: environment ─────────────────────────────────────────────────────
function checkEnv(): Config {
  step(1, 'Environment variables (HMAC)');
  const requiredVars = ['ZENNOPAY_HMAC_KEY_ID', 'ZENNOPAY_HMAC_SECRET'];
  const missing = requiredVars.filter(
    (v) => process.env[v] === undefined || process.env[v] === '',
  );
  if (missing.length > 0) {
    bad(`missing env vars: ${missing.join(', ')}`);
    hint('copy .env.example to .env and fill in the values from your onboarding pack');
    fail('environment');
  }
  ok('HMAC key id + secret present');

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      bad(err.message);
      fail('environment');
    }
    throw err;
  }
  ok(`Zennopay API base URL: ${cfg.baseUrl}`);
  if (cfg.jwtPrivateKey === null) {
    note('JWT keypair not set — fine for Model B (checkout uses HMAC only). ' +
      'Only the optional /receipt-token flow needs it.');
  } else {
    ok('optional JWT keypair configured (enables /receipt-token)');
  }
  if (cfg.webhookSecret === null) {
    note('ZENNOPAY_WEBHOOK_SECRET not set — webhooks disabled (fine for week 1)');
  }
  return cfg;
}

// ─── Step 2: reachability ────────────────────────────────────────────────────
async function checkReachability(cfg: Config): Promise<void> {
  step(2, `Reachability of ${cfg.baseUrl}`);
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

// ─── Step 3: HMAC round-trip → Zennopay-minted session token ─────────────────
async function checkHmacRoundTrip(cfg: Config): Promise<string> {
  step(3, 'HMAC round-trip: create a real $1.00 intent → Zennopay mints a session token');
  note('creating an intent moves no money — funds only move after a user confirms');
  note('using sandbox stub attestations for this check — wire src/attestations.ts before go-live');
  const partnerUserId = process.env.VERIFY_PARTNER_USER_ID ?? 'demo_user_1';
  try {
    const created = await createPaymentIntent(cfg, {
      partnerUserId,
      amountUsdCents: 100,
      corridor: cfg.defaultCorridor,
      attestations: buildSandboxStubAttestations(),
    });
    ok(`intent created: ${BOLD}${created.intentId}${RESET}`);
    note(`partner_user_id=${partnerUserId} corridor=${cfg.defaultCorridor}`);

    // Confirm the API MINTED a session token (Model B) and sanity-check it.
    if (created.sessionToken === '') {
      bad('response had no session_token — is this API on Model B?');
      fail('hmac round-trip');
    }
    ok('Zennopay returned a minted session_token');
    try {
      const { header, payload } = decodeJwtUnverified(created.sessionToken);
      const audOk = payload.aud === SESSION_JWT_AUDIENCE;
      const issOk = payload.iss === cfg.baseUrl;
      note(`token alg=${String(header.alg)} kid=${String(header.kid)}`);
      if (audOk) ok(`token aud = ${SESSION_JWT_AUDIENCE}`);
      else bad(`token aud = ${String(payload.aud)} (expected ${SESSION_JWT_AUDIENCE})`);
      if (issOk) ok(`token iss = ${cfg.baseUrl}`);
      else note(`token iss = ${String(payload.iss)} (base URL is ${cfg.baseUrl})`);
    } catch {
      note('session_token is opaque to this doctor (could not decode as a JWT) — that is OK');
    }
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
        hint('request rejected — check the corridor value, amount_usd_cents (integer), ' +
          'and that the attestations shape is accepted');
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
  console.log(`${BOLD}zennopay-partner-starter — setup doctor (Model B)${RESET}`);
  loadDotEnv();
  const cfg = checkEnv();
  await checkReachability(cfg);
  const intentId = await checkHmacRoundTrip(cfg);

  console.log(
    `\n${GREEN}${BOLD}Ready for the SDK.${RESET} Your backend can sign HMAC requests, ` +
      `create intents (${intentId}), and relay the Zennopay-minted session token.\n` +
      `Next: run ${BOLD}npm run dev${RESET} and point the Zennopay PaymentSheet SDK at ` +
      `POST /checkout/session.\n`,
  );
}

main().catch((err) => {
  console.error(`\n${RED}doctor crashed unexpectedly:${RESET}`, err);
  process.exit(1);
});
