/**
 * Session JWT shape + signature tests. Uses a throwaway RSA key pair
 * generated at test time — no fixtures, no real keys.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildSandboxStubAttestations } from '../src/attestations.js';
import {
  decodeJwtUnverified,
  mintSessionJwt,
  verifyJwtSignature,
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_TTL_SEC,
} from '../src/zennopay/session.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const cfg = {
  jwtPrivateKey: privateKey,
  jwtKid: 'test-kid-1',
  jwtIss: 'https://partner.example/issuer',
};

function mint(overrides: Partial<Parameters<typeof mintSessionJwt>[1]> = {}) {
  return mintSessionJwt(cfg, {
    intentId: 'pi_test_001',
    amountUsdCents: 1234,
    corridor: 'vn_vietqr',
    partnerUserId: 'opaque_user_42',
    attestations: buildSandboxStubAttestations(new Date('2026-01-15T10:00:00Z')),
    nowSec: 1_750_000_000,
    ...overrides,
  });
}

describe('mintSessionJwt', () => {
  it('produces a three-part compact JWT', () => {
    expect(mint().jwt.split('.')).toHaveLength(3);
  });

  it('header carries RS256 + the configured kid', () => {
    const { header } = decodeJwtUnverified(mint().jwt);
    expect(header).toMatchObject({ alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' });
  });

  it('payload carries the full claim contract', () => {
    const { payload } = decodeJwtUnverified(mint().jwt);
    expect(payload.iss).toBe(cfg.jwtIss);
    expect(payload.aud).toBe(SESSION_JWT_AUDIENCE);
    expect(payload.sub).toBe('opaque_user_42');
    expect(typeof payload.jti).toBe('string');
    expect(payload.iat).toBe(1_750_000_000);
    expect(payload.exp).toBe(1_750_000_000 + SESSION_JWT_TTL_SEC);
    expect(payload['zennopay:intent_id']).toBe('pi_test_001');
    expect(payload['zennopay:amount_usd_cents']).toBe(1234);
    expect(payload['zennopay:corridor']).toBe('vn_vietqr');
    expect(payload['zennopay:kyc_attestation']).toMatchObject({
      verified: true,
      id_type: 'passport',
      id_country: 'IN',
    });
    expect(payload['zennopay:sanctions_attestation']).toMatchObject({ clean: true });
  });

  it('expiresAt matches exp and defaults to a 300s TTL', () => {
    const minted = mint();
    const { payload } = decodeJwtUnverified(minted.jwt);
    expect(minted.expiresAt).toBe(payload.exp);
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
  });

  it('jti is unique per mint', () => {
    const a = decodeJwtUnverified(mint().jwt).payload.jti;
    const b = decodeJwtUnverified(mint().jwt).payload.jti;
    expect(a).not.toBe(b);
  });

  it('signature verifies with the public key and fails when tampered', () => {
    const { jwt } = mint();
    expect(verifyJwtSignature(jwt, publicKey)).toBe(true);

    // Flip the amount in the payload → signature must fail.
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    payload['zennopay:amount_usd_cents'] = 999_999;
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(verifyJwtSignature(forged, publicKey)).toBe(false);
  });

  it('signature fails against a different key pair', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(verifyJwtSignature(mint().jwt, other.publicKey)).toBe(false);
  });
});
