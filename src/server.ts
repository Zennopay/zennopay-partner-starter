/**
 * HTTP routes — the partner side of the Zennopay PaymentSheet integration.
 *
 *   POST /checkout/session          create intent + mint session JWT
 *   POST /checkout/session/refresh  re-mint a JWT for an existing intent
 *   POST /receipt-token             mint a receipt token (reopen a receipt)
 *   POST /zennopay/webhook          signature-verified event intake
 *   GET  /health                    liveness probe
 *
 * AUTH NOTE: /checkout/session endpoints must only be callable by YOUR
 * authenticated apps. Put them behind your existing app/session auth (API
 * gateway, session cookie, mobile token — whatever you already use). The
 * starter leaves that seam open because every partner's auth is different.
 */
import { Hono } from 'hono';

import { getAttestations } from './attestations.js';
import type { Config } from './config.js';
import { findSession, saveSession } from './store.js';
import * as wallet from './wallet.js';
import type { IntentSnapshot } from './wallet.js';
import { parseEnvelope, verifyWebhookSignature } from './webhooks.js';
import { createPaymentIntent, ZennopayApiError } from './zennopay/client.js';
import { mintSessionJwt } from './zennopay/session.js';
import { mintReceiptToken } from './zennopay/receipt.js';

export const STARTER_VERSION = '0.1.1';

interface SessionResponse {
  intent_id: string;
  session_jwt: string;
  /** ISO 8601 expiry of the JWT (5 minutes; call refresh to extend). */
  expires_at: string;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function createApp(cfg: Config): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'zennopay-partner-starter', version: STARTER_VERSION }),
  );

  // ── Create a checkout session ────────────────────────────────────────────
  app.post('/checkout/session', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userId = body.user_id;
    const amountUsdCents = body.amount_usd_cents;
    const corridor = typeof body.corridor === 'string' ? body.corridor : cfg.defaultCorridor;
    if (typeof userId !== 'string' || userId === '') {
      return c.json({ error: 'invalid_request', detail: 'user_id (string) is required' }, 400);
    }
    if (!isPositiveInt(amountUsdCents)) {
      return c.json(
        { error: 'invalid_request', detail: 'amount_usd_cents (positive integer) is required' },
        400,
      );
    }

    // 1. Attestations FIRST — if the user isn't KYC-verified or screened,
    //    no intent should ever be created.
    const attestations = await getAttestations(userId);

    // 2. Create the payment intent (HMAC-signed server-to-server call).
    let intentId: string;
    try {
      const created = await createPaymentIntent(cfg, {
        partnerUserId: userId,
        amountUsdCents,
        corridor,
      });
      intentId = created.intentId;
    } catch (err) {
      if (err instanceof ZennopayApiError) {
        console.error('[session] create intent failed', err.status, JSON.stringify(err.body));
        return c.json({ error: 'zennopay_error', status: err.status, detail: err.body }, 502);
      }
      throw err;
    }

    // 3. Mint the short-lived session JWT the PaymentSheet SDK will use.
    const minted = mintSessionJwt(cfg, {
      intentId,
      amountUsdCents,
      corridor,
      partnerUserId: userId,
      attestations,
    });

    saveSession({
      intentId,
      partnerUserId: userId,
      amountUsdCents,
      corridor,
      createdAt: new Date().toISOString(),
    });

    const res: SessionResponse = {
      intent_id: intentId,
      session_jwt: minted.jwt,
      expires_at: new Date(minted.expiresAt * 1000).toISOString(),
    };
    return c.json(res, 201);
  });

  // ── Refresh: re-mint a JWT for the SAME user + intent ────────────────────
  app.post('/checkout/session/refresh', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const intentId = body.intent_id;
    if (typeof intentId !== 'string' || intentId === '') {
      return c.json({ error: 'invalid_request', detail: 'intent_id (string) is required' }, 400);
    }
    const session = findSession(intentId);
    if (session === null) {
      return c.json({ error: 'unknown_intent', detail: 'no session recorded for this intent' }, 404);
    }
    // Re-attest at refresh time — cheap insurance that a user who was
    // deactivated mid-checkout doesn't get a fresh token.
    const attestations = await getAttestations(session.partnerUserId);
    const minted = mintSessionJwt(cfg, {
      intentId: session.intentId,
      amountUsdCents: session.amountUsdCents,
      corridor: session.corridor,
      partnerUserId: session.partnerUserId,
      attestations,
    });
    const res: SessionResponse = {
      intent_id: session.intentId,
      session_jwt: minted.jwt,
      expires_at: new Date(minted.expiresAt * 1000).toISOString(),
    };
    return c.json(res, 200);
  });

  // ── Webhook intake ───────────────────────────────────────────────────────
  // ── Mint a receipt token ─────────────────────────────────────────────────
  // Call this when the user taps a row in YOUR transaction-history UI. Returns
  // a short-lived, user-scoped, read-only token the SDK uses with
  // Zennopay.presentReceipt(intentId, receiptToken) to reopen the authoritative
  // receipt (live pending/refund status). Put this behind YOUR app auth — the
  // user_id MUST be the authenticated user, never trusted from the client.
  app.post('/receipt-token', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userId = body.user_id;
    if (typeof userId !== 'string' || userId === '') {
      return c.json({ error: 'invalid_request', detail: 'user_id (string) is required' }, 400);
    }
    const { receiptToken, expiresAt } = mintReceiptToken(cfg, { partnerUserId: userId });
    return c.json({
      receipt_token: receiptToken,
      expires_at: new Date(expiresAt * 1000).toISOString(),
    });
  });

  app.post('/zennopay/webhook', async (c) => {
    if (cfg.webhookSecret === null) {
      return c.json(
        {
          error: 'not_configured',
          detail: 'Set ZENNOPAY_WEBHOOK_SECRET (from your onboarding pack) to enable webhooks.',
        },
        501,
      );
    }
    const rawBody = await c.req.text();
    const url = new URL(c.req.url);
    const result = verifyWebhookSignature({
      path: url.pathname + url.search,
      rawBody,
      headers: {
        keyId: c.req.header('X-Zennopay-Key-Id'),
        timestamp: c.req.header('X-Zennopay-Timestamp'),
        nonce: c.req.header('X-Zennopay-Nonce'),
        signature: c.req.header('X-Zennopay-Signature'),
      },
      secret: cfg.webhookSecret,
    });
    if (!result.ok) {
      // Log the specific reason; answer generically.
      console.warn(`[webhook] rejected: ${result.reason}`);
      return c.json({ error: 'invalid_signature' }, 401);
    }

    const envelope = parseEnvelope(rawBody);
    if (envelope === null) return c.json({ error: 'invalid_envelope' }, 400);

    const intent = (envelope.data.intent ?? null) as IntentSnapshot | null;
    switch (envelope.webhook_event_type) {
      case 'payment_intent.captured':
        if (intent !== null) await wallet.onPaymentCaptured(intent);
        break;
      case 'payment_intent.failed':
        if (intent !== null) {
          await wallet.onPaymentFailed(intent, String(envelope.data.reason ?? 'unknown'));
        }
        break;
      case 'payment_intent.refunded':
        if (intent !== null) {
          await wallet.onPaymentRefunded(
            intent,
            envelope.data.refund as { refund_id: string; amount_usd_cents: number },
          );
        }
        break;
      case 'payment_intent.capture_reversed':
        if (intent !== null) {
          await wallet.onCaptureReversed(
            intent,
            envelope.data.reversal as { reversal_id: string; amount_usd_cents: number },
          );
        }
        break;
      default:
        // Unknown event types are acknowledged (forward-compatible): Zennopay
        // may add types; a 4xx would mark the delivery permanently failed.
        console.info(`[webhook] ignoring unhandled event type ${envelope.webhook_event_type}`);
    }
    return c.json({ received: true, webhook_event_id: envelope.webhook_event_id }, 200);
  });

  return app;
}
