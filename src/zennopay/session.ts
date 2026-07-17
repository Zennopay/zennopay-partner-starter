/**
 * Checkout-session JWT minting (RS256).
 *
 * The JWT is what the Zennopay PaymentSheet SDK presents to Zennopay's API on
 * behalf of one user for ONE payment intent. It is short-lived (5 minutes),
 * single-intent, and signed with YOUR private key — Zennopay verifies it with
 * the public key you registered (looked up via the header `kid`).
 *
 * Claim contract:
 *   iss  — your registered issuer URL (must match exactly)
 *   aud  — always "zennopay-checkout"
 *   sub  — YOUR opaque user id (never PII, never a government ID number)
 *   jti  — unique per token (UUID)
 *   iat / exp — issued-at / expiry (default TTL 300s; keep it short)
 *   zennopay:intent_id / :amount_usd_cents / :corridor — binds the token to
 *     one intent so it cannot be replayed for a different payment
 *   zennopay:kyc_attestation / :sanctions_attestation — see src/attestations.ts
 */
import crypto from 'node:crypto';

import type { Attestations } from '../attestations.js';
import type { Config } from '../config.js';

export const SESSION_JWT_AUDIENCE = 'zennopay-checkout';
export const SESSION_JWT_TTL_SEC = 300;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface MintSessionInput {
  intentId: string;
  amountUsdCents: number;
  corridor: string;
  /** Your opaque user id — becomes the JWT `sub`. */
  partnerUserId: string;
  attestations: Attestations;
  /** Test seams. */
  nowSec?: number;
  ttlSec?: number;
  jti?: string;
}

export interface MintedSession {
  jwt: string;
  /** Unix seconds. */
  expiresAt: number;
}

export function mintSessionJwt(
  cfg: Pick<Config, 'jwtPrivateKey' | 'jwtKid' | 'jwtIss'>,
  input: MintSessionInput,
): MintedSession {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = now + (input.ttlSec ?? SESSION_JWT_TTL_SEC);
  const header = { alg: 'RS256', kid: cfg.jwtKid, typ: 'JWT' };
  const payload = {
    iss: cfg.jwtIss,
    aud: SESSION_JWT_AUDIENCE,
    sub: input.partnerUserId,
    jti: input.jti ?? crypto.randomUUID(),
    iat: now,
    exp,
    'zennopay:intent_id': input.intentId,
    'zennopay:amount_usd_cents': input.amountUsdCents,
    'zennopay:corridor': input.corridor,
    'zennopay:kyc_attestation': input.attestations.kyc,
    'zennopay:sanctions_attestation': input.attestations.sanctions,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(cfg.jwtPrivateKey);
  return { jwt: `${signingInput}.${signature.toString('base64url')}`, expiresAt: exp };
}

/** Decode without verifying — for tests and the doctor's self-check only. */
export function decodeJwtUnverified(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('not a JWT (expected 3 dot-separated parts)');
  const [h, p] = parts;
  return {
    header: JSON.parse(Buffer.from(h as string, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p as string, 'base64url').toString('utf8')),
  };
}

/** Verify a minted JWT's signature against the public half of a key pair. */
export function verifyJwtSignature(jwt: string, publicKey: crypto.KeyObject): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const signingInput = `${parts[0]}.${parts[1]}`;
  return crypto
    .createVerify('RSA-SHA256')
    .update(signingInput)
    .verify(publicKey, Buffer.from(parts[2] as string, 'base64url'));
}
