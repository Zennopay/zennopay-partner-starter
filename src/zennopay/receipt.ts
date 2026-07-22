/**
 * Receipt-token minting (RS256).
 *
 * A receipt token lets the Zennopay SDK reopen the AUTHORITATIVE receipt for a
 * past payment — `Zennopay.presentReceipt(intentId, receiptToken)` on the
 * client. Unlike the checkout-session token it is:
 *   - user-scoped, NOT intent-bound (one token can open any of that user's
 *     receipts and poll a pending one)
 *   - reusable within its short TTL (no single-use jti burn)
 *   - read-only — it grants no ability to move money or confirm a payment
 *
 * Mint one on demand when the user taps a row in YOUR transaction-history UI.
 * Signed with YOUR private key; Zennopay verifies it with the public key you
 * registered (looked up via the header `kid`).
 *
 * Claim contract:
 *   iss  — your registered issuer URL (must match exactly)
 *   aud  — always "zennopay-receipt"
 *   sub  — YOUR opaque user id (never PII; must match the intent's user)
 *   jti  — unique per token (UUID)
 *   iat / exp — issued-at / expiry (default TTL 300s; Zennopay enforces ≤ 15m)
 */
import crypto from 'node:crypto';

export const RECEIPT_JWT_AUDIENCE = 'zennopay-receipt';
export const RECEIPT_JWT_TTL_SEC = 300;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface MintReceiptInput {
  /** Your opaque user id — becomes the JWT `sub`. Must be the same id the
   *  intent being reopened was created under. */
  partnerUserId: string;
  /** Test seams. */
  nowSec?: number;
  ttlSec?: number;
  jti?: string;
}

export interface MintedReceiptToken {
  receiptToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * The keypair the receipt flow signs with. Non-null by construction — callers
 * must confirm the optional JWT keypair is configured before minting (the
 * route answers 501 otherwise). Accepts a KeyObject or a raw PKCS#8 PEM.
 */
export interface ReceiptSigningKey {
  jwtPrivateKey: crypto.KeyObject | string;
  jwtKid: string;
  jwtIss: string;
}

export function mintReceiptToken(
  cfg: ReceiptSigningKey,
  input: MintReceiptInput,
): MintedReceiptToken {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  // Keep well under Zennopay's 15-minute ceiling; mint fresh per open.
  const exp = now + (input.ttlSec ?? RECEIPT_JWT_TTL_SEC);
  const header = { alg: 'RS256', kid: cfg.jwtKid, typ: 'JWT' };
  const payload = {
    iss: cfg.jwtIss,
    aud: RECEIPT_JWT_AUDIENCE,
    sub: input.partnerUserId,
    jti: input.jti ?? crypto.randomUUID(),
    iat: now,
    exp,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(cfg.jwtPrivateKey);
  return { receiptToken: `${signingInput}.${signature.toString('base64url')}`, expiresAt: exp };
}
