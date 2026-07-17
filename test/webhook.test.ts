/**
 * Webhook signature verification tests — we sign fake webhooks exactly the
 * way Zennopay does (same canonical scheme) and check the verifier.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildCanonicalRequest,
  computeHmacSignature,
  sha256HexOfBody,
} from '../src/zennopay/client.js';
import {
  parseEnvelope,
  verifyWebhookSignature,
  _resetNonceCache,
} from '../src/webhooks.js';

const SECRET = 'test_webhook_secret_do_not_use';
const NOW = new Date('2026-01-15T10:00:00.000Z');

function signedInput(overrides: {
  body?: string;
  path?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
} = {}) {
  const body =
    overrides.body ??
    JSON.stringify({
      webhook_event_id: 'evt_1',
      webhook_event_type: 'payment_intent.captured',
      api_version: '2026-05',
      created_at: NOW.toISOString(),
      data: { intent: { id: 'pi_1' } },
    });
  const path = overrides.path ?? '/zennopay/webhook';
  const timestamp = overrides.timestamp ?? NOW.toISOString();
  const nonce = overrides.nonce ?? 'ab'.repeat(32);
  const canonical = buildCanonicalRequest({
    method: 'POST',
    path,
    timestamp,
    nonce,
    bodyHashHex: sha256HexOfBody(body),
  });
  return {
    path,
    rawBody: body,
    headers: {
      keyId: 'zennopay_out_1',
      timestamp,
      nonce,
      signature: overrides.signature ?? computeHmacSignature(SECRET, canonical),
    },
    secret: SECRET,
    now: () => NOW,
  };
}

beforeEach(() => _resetNonceCache());

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed webhook', () => {
    expect(verifyWebhookSignature(signedInput())).toEqual({ ok: true });
  });

  it('rejects when headers are missing', () => {
    const input = signedInput();
    input.headers.signature = undefined as unknown as string;
    expect(verifyWebhookSignature(input)).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a tampered body', () => {
    const input = signedInput();
    input.rawBody = input.rawBody.replace('pi_1', 'pi_2');
    expect(verifyWebhookSignature(input)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a wrong secret', () => {
    const input = { ...signedInput(), secret: 'some_other_secret' };
    expect(verifyWebhookSignature(input)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp (>5 min old)', () => {
    const stale = new Date(NOW.getTime() - 6 * 60 * 1000).toISOString();
    const input = signedInput({ timestamp: stale });
    expect(verifyWebhookSignature(input)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
  });

  it('rejects an unparseable timestamp', () => {
    const input = signedInput({ timestamp: 'not-a-date' });
    expect(verifyWebhookSignature(input)).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });

  it('rejects a replayed nonce (second delivery with same nonce)', () => {
    const input = signedInput();
    expect(verifyWebhookSignature(input)).toEqual({ ok: true });
    expect(verifyWebhookSignature(signedInput())).toEqual({
      ok: false,
      reason: 'nonce_replayed',
    });
  });

  it('signs over the query string when present', () => {
    const input = signedInput({ path: '/zennopay/webhook?env=sandbox' });
    expect(verifyWebhookSignature(input)).toEqual({ ok: true });
    // Same signature presented for a different path must fail.
    const moved = { ...input, path: '/zennopay/webhook' };
    _resetNonceCache();
    expect(verifyWebhookSignature(moved)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('parseEnvelope', () => {
  it('parses a valid envelope', () => {
    const env = parseEnvelope(signedInput().rawBody);
    expect(env?.webhook_event_type).toBe('payment_intent.captured');
  });

  it('returns null for junk', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('{"nope":true}')).toBeNull();
  });
});
