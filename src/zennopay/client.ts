/**
 * Zennopay server-to-server client: HMAC request signing + payment-intent
 * creation.
 *
 * ── The canonical request (get this byte-exact or you get a 401) ──────────
 *
 *   METHOD \n path \n timestamp \n nonce \n sha256(body)-hex \n
 *
 *   1. METHOD uppercased (e.g. "POST").
 *   2. path WITHOUT the query string (e.g. "/v1/payment_intents").
 *   3. timestamp: ISO 8601 UTC, must be within ±5 minutes of Zennopay's clock.
 *   4. nonce: 64 hex chars (32 random bytes), single-use within 10 minutes.
 *   5. body hash: lowercase hex SHA-256 of the exact bytes you send;
 *      the EMPTY STRING (not the hash of "") when there is no body.
 *   6. Components joined with "\n" and a TRAILING newline after the hash.
 *
 * Signature = base64( HMAC-SHA256( secret, canonical ) ), sent alongside the
 * key id, timestamp, and nonce in the X-Zennopay-* headers.
 */
import crypto from 'node:crypto';

import type { Config } from '../config.js';

/** SHA-256 hex of the request body. Empty body → empty string (per spec). */
export function sha256HexOfBody(body: string): string {
  if (body === '') return '';
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Build the canonical request string (exported for tests + the doctor). */
export function buildCanonicalRequest(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHashHex: string;
}): string {
  return (
    [
      params.method.toUpperCase(),
      params.path,
      params.timestamp,
      params.nonce,
      params.bodyHashHex,
    ].join('\n') + '\n'
  );
}

/** base64( HMAC-SHA256( secret, canonical ) ) */
export function computeHmacSignature(secret: string, canonical: string): string {
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('base64');
}

/** 32 random bytes as 64 hex chars — the nonce format Zennopay expects. */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface SignedHeaders extends Record<string, string> {
  'Content-Type': string;
  'X-Zennopay-Key-Id': string;
  'X-Zennopay-Timestamp': string;
  'X-Zennopay-Nonce': string;
  'X-Zennopay-Signature': string;
}

/**
 * Produce the signed header set for one request. Timestamp + nonce are fresh
 * per call — never reuse a signature (the nonce is single-use server-side).
 */
export function signRequest(params: {
  method: string;
  path: string;
  body: string;
  keyId: string;
  secret: string;
  /** Test seams. */
  timestamp?: string;
  nonce?: string;
}): SignedHeaders {
  const timestamp = params.timestamp ?? new Date().toISOString();
  const nonce = params.nonce ?? generateNonce();
  const canonical = buildCanonicalRequest({
    method: params.method,
    path: params.path,
    timestamp,
    nonce,
    bodyHashHex: sha256HexOfBody(params.body),
  });
  return {
    'Content-Type': 'application/json',
    'X-Zennopay-Key-Id': params.keyId,
    'X-Zennopay-Timestamp': timestamp,
    'X-Zennopay-Nonce': nonce,
    'X-Zennopay-Signature': computeHmacSignature(params.secret, canonical),
  };
}

export interface CreateIntentInput {
  partnerUserId: string;
  amountUsdCents: number;
  corridor: string;
}

export interface CreateIntentResult {
  intentId: string;
  /** Raw response body — useful for logging/debugging. */
  raw: Record<string, unknown>;
}

export class ZennopayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * POST /v1/payment_intents — HMAC-signed, idempotent via Idempotency-Key.
 * Creating an intent reserves nothing and moves no money; funds only move
 * after the end user confirms in the PaymentSheet.
 */
export async function createPaymentIntent(
  cfg: Pick<Config, 'baseUrl' | 'hmacKeyId' | 'hmacSecret'>,
  input: CreateIntentInput,
  opts: { idempotencyKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<CreateIntentResult> {
  const path = '/v1/payment_intents';
  const body = JSON.stringify({
    partner_user_id: input.partnerUserId,
    amount_usd_cents: input.amountUsdCents,
    corridor: input.corridor,
  });
  const headers: Record<string, string> = {
    ...signRequest({
      method: 'POST',
      path,
      body,
      keyId: cfg.hmacKeyId,
      secret: cfg.hmacSecret,
    }),
    'Idempotency-Key': opts.idempotencyKey ?? crypto.randomUUID(),
  };
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 201) {
    throw new ZennopayApiError(
      `create payment intent failed (HTTP ${res.status})`,
      res.status,
      json,
    );
  }
  const intentId = json.intent_id;
  if (typeof intentId !== 'string' || intentId === '') {
    throw new ZennopayApiError('create returned 201 but no intent_id', res.status, json);
  }
  return { intentId, raw: json };
}
