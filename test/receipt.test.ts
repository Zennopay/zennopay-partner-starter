import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { mintReceiptToken, RECEIPT_JWT_AUDIENCE } from '../src/zennopay/receipt.js';
import { decodeJwtUnverified, verifyJwtSignature } from '../src/zennopay/jwt.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg = {
  jwtPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  jwtKid: 'test-kid',
  jwtIss: 'https://demo.partner.test/issuer',
};

describe('mintReceiptToken', () => {
  it('mints a read-only, user-scoped, non-intent-bound token', () => {
    const { receiptToken, expiresAt } = mintReceiptToken(cfg, { partnerUserId: 'u_123', nowSec: 1000, ttlSec: 300 });
    const { header, payload } = decodeJwtUnverified(receiptToken);
    expect(header).toMatchObject({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
    expect(payload.aud).toBe(RECEIPT_JWT_AUDIENCE);
    expect(payload.aud).toBe('zennopay-receipt');
    expect(payload.sub).toBe('u_123');
    expect(payload.iss).toBe(cfg.jwtIss);
    expect(payload.exp).toBe(1300);
    expect(payload.jti).toBeTypeOf('string');
    // NOT intent-bound and carries NO attestations (read-only)
    expect(payload['zennopay:intent_id']).toBeUndefined();
    expect(payload['zennopay:kyc_attestation']).toBeUndefined();
    expect(verifyJwtSignature(receiptToken, publicKey)).toBe(true);
  });

  it('is not the checkout audience (cannot be used as a session token)', () => {
    const { receiptToken } = mintReceiptToken(cfg, { partnerUserId: 'u_1' });
    expect(decodeJwtUnverified(receiptToken).payload.aud).not.toBe('zennopay-checkout');
  });

  it('defaults to a short (<= 15 min) TTL', () => {
    const { receiptToken } = mintReceiptToken(cfg, { partnerUserId: 'u_1', nowSec: 0 });
    expect(decodeJwtUnverified(receiptToken).payload.exp as number).toBeLessThanOrEqual(900);
  });
});
