/**
 * JWT decode/verify utilities (no minting).
 *
 * Zennopay now MINTS the checkout-session token (Model B) — the partner no
 * longer self-signs it. These helpers exist for two remaining needs:
 *   - decoding the Zennopay-minted `session_token` for logging / the doctor;
 *   - the optional, keypair-based receipt-token flow (see src/zennopay/receipt.ts).
 *
 * `decodeJwtUnverified` never checks a signature — it is for inspection only.
 */
import crypto from 'node:crypto';

/** Decode a compact JWT WITHOUT verifying its signature. Inspection only. */
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

/** Verify an RS256 JWT's signature against a public key. */
export function verifyJwtSignature(jwt: string, publicKey: crypto.KeyObject): boolean {
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  const signingInput = `${parts[0]}.${parts[1]}`;
  return crypto
    .createVerify('RSA-SHA256')
    .update(signingInput)
    .verify(publicKey, Buffer.from(parts[2] as string, 'base64url'));
}
