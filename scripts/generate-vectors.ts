/**
 * Regenerates test/vectors/canonical.json from the current implementation.
 *
 * Run after any INTENTIONAL change to the canonical scheme (which should be
 * never — the scheme is a wire contract with Zennopay):
 *
 *   npx tsx scripts/generate-vectors.ts
 *
 * The secret below is a FAKE test fixture, documented in test/canonical.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCanonicalRequest,
  computeHmacSignature,
  sha256HexOfBody,
} from '../src/zennopay/client.js';

const FAKE_SECRET = 'test_secret_do_not_use_0123456789abcdef';

const cases = [
  {
    name: 'create payment intent (typical POST)',
    method: 'POST',
    path: '/v1/payment_intents',
    timestamp: '2026-01-15T10:30:00.000Z',
    nonce: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    body: '{"partner_user_id":"user_123","amount_usd_cents":100,"corridor":"vn_vietqr"}',
  },
  {
    name: 'empty body (GET-style) hashes to the empty string',
    method: 'GET',
    path: '/v1/payment_intents/pi_abc123',
    timestamp: '2026-01-15T10:31:00.000Z',
    nonce: '00000000000000000000000000000000ffffffffffffffffffffffffffffffff',
    body: '',
  },
  {
    name: 'lowercase method is uppercased before signing',
    method: 'post',
    path: '/v1/payment_intents',
    timestamp: '2026-01-15T10:32:00.000Z',
    nonce: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    body: '{"partner_user_id":"user_456","amount_usd_cents":2500,"corridor":"th_promptpay"}',
  },
  {
    name: 'unicode body bytes are hashed as UTF-8',
    method: 'POST',
    path: '/v1/payment_intents',
    timestamp: '2026-01-15T10:33:00.000Z',
    nonce: '1111111111111111111111111111111122222222222222222222222222222222',
    body: '{"partner_user_id":"ngưới_dùng","amount_usd_cents":999,"corridor":"vn_vietqr"}',
  },
  {
    name: 'webhook-style path includes the query string',
    method: 'POST',
    path: '/zennopay/webhook?env=sandbox',
    timestamp: '2026-01-15T10:34:00.000Z',
    nonce: '3333333333333333333333333333333344444444444444444444444444444444',
    body: '{"webhook_event_id":"018f0000-0000-7000-8000-000000000000","webhook_event_type":"payment_intent.captured","api_version":"2026-05","created_at":"2026-01-15T10:34:00.000Z","data":{}}',
  },
];

const vectors = cases.map((c) => {
  const bodyHashHex = sha256HexOfBody(c.body);
  const canonical = buildCanonicalRequest({
    method: c.method,
    path: c.path,
    timestamp: c.timestamp,
    nonce: c.nonce,
    bodyHashHex,
  });
  return {
    ...c,
    expected: {
      bodyHashHex,
      canonical,
      signature: computeHmacSignature(FAKE_SECRET, canonical),
    },
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'test', 'vectors', 'canonical.json');
fs.writeFileSync(out, JSON.stringify(vectors, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${out}`);
