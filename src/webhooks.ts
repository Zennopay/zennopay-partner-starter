/**
 * Inbound webhook verification.
 *
 * Zennopay signs outgoing webhooks with the SAME canonical-request scheme
 * used for partner API calls (METHOD, path, timestamp, nonce, body hash —
 * newline-joined with a trailing newline), using Zennopay's outbound signing
 * key. You receive the verification secret + key id in your onboarding pack
 * (ZENNOPAY_WEBHOOK_SECRET).
 *
 * One difference from outbound API signing: for webhooks the signed path is
 * `pathname + search` of YOUR endpoint URL as registered in the dashboard
 * (query string INCLUDED, if you registered one).
 *
 * Verification checklist implemented here:
 *   1. All X-Zennopay-* headers present.
 *   2. Timestamp within ±5 minutes (stale signatures rejected).
 *   3. Signature matches — constant-time compare.
 *   4. Nonce not seen before (in-memory 10-minute dedup; use Redis or your
 *      DB in production so replay protection survives restarts and scales
 *      across instances).
 */
import crypto from 'node:crypto';

import { buildCanonicalRequest, computeHmacSignature, sha256HexOfBody } from './zennopay/client.js';

export const WEBHOOK_MAX_CLOCK_SKEW_SEC = 300;
const NONCE_TTL_MS = 10 * 60 * 1000;

/** In-memory nonce dedup. PRODUCTION: back this with Redis / your DB. */
const seenNonces = new Map<string, number>();

function nonceSeen(nonce: string, nowMs: number): boolean {
  // Opportunistic sweep of expired entries.
  for (const [n, at] of seenNonces) {
    if (nowMs - at > NONCE_TTL_MS) seenNonces.delete(n);
  }
  if (seenNonces.has(nonce)) return true;
  seenNonces.set(nonce, nowMs);
  return false;
}

/** Test seam. */
export function _resetNonceCache(): void {
  seenNonces.clear();
}

export interface WebhookVerifyInput {
  /** pathname + search of the request URL (e.g. "/zennopay/webhook"). */
  path: string;
  /** Raw request body EXACTLY as received — do not re-serialize JSON. */
  rawBody: string;
  headers: {
    keyId: string | undefined;
    timestamp: string | undefined;
    nonce: string | undefined;
    signature: string | undefined;
  };
  secret: string;
  now?: () => Date;
}

export type WebhookVerifyResult =
  | { ok: true }
  | {
      ok: false;
      /** Machine-readable reason — log it, but return a generic 401 to the caller. */
      reason:
        | 'missing_headers'
        | 'invalid_timestamp'
        | 'timestamp_out_of_range'
        | 'bad_signature'
        | 'nonce_replayed';
    };

export function verifyWebhookSignature(input: WebhookVerifyInput): WebhookVerifyResult {
  const { keyId, timestamp, nonce, signature } = input.headers;
  if (keyId === undefined || timestamp === undefined || nonce === undefined || signature === undefined) {
    return { ok: false, reason: 'missing_headers' };
  }

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return { ok: false, reason: 'invalid_timestamp' };
  const nowMs = (input.now?.() ?? new Date()).getTime();
  if (Math.abs(nowMs - ts) > WEBHOOK_MAX_CLOCK_SKEW_SEC * 1000) {
    return { ok: false, reason: 'timestamp_out_of_range' };
  }

  const canonical = buildCanonicalRequest({
    method: 'POST',
    path: input.path,
    timestamp,
    nonce,
    bodyHashHex: sha256HexOfBody(input.rawBody),
  });
  const expected = computeHmacSignature(input.secret, canonical);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Signature verified BEFORE consuming the nonce slot, so unauthenticated
  // traffic cannot poison the dedup cache.
  if (nonceSeen(nonce, nowMs)) return { ok: false, reason: 'nonce_replayed' };
  return { ok: true };
}

/** The envelope every Zennopay webhook body carries. */
export interface WebhookEnvelope {
  webhook_event_id: string;
  webhook_event_type: string;
  api_version: string;
  created_at: string;
  data: Record<string, unknown>;
}

export function parseEnvelope(rawBody: string): WebhookEnvelope | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (
      typeof parsed.webhook_event_id !== 'string' ||
      typeof parsed.webhook_event_type !== 'string' ||
      typeof parsed.data !== 'object' ||
      parsed.data === null
    ) {
      return null;
    }
    return parsed as unknown as WebhookEnvelope;
  } catch {
    return null;
  }
}
