/**
 * Model B client tests — the Zennopay API now MINTS the checkout-session
 * token. createPaymentIntent must send the attestations and parse the
 * `session_token` + `session_expires_at` the API returns; remintSession must
 * hit POST /v1/payment_intents/:id/session (a refresh — NO Idempotency-Key).
 *
 * fetch is stubbed per-call via the `fetchImpl` seam so no network is touched.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildSandboxStubAttestations } from '../src/attestations.js';
import {
  createPaymentIntent,
  remintSession,
  ZennopayApiError,
} from '../src/zennopay/client.js';

const cfg = {
  baseUrl: 'https://api.sandbox.zennopay.in',
  hmacKeyId: 'pk_test_key',
  hmacSecret: 'test_secret_do_not_use_0123456789abcdef',
};

const attestations = buildSandboxStubAttestations(new Date('2026-01-15T10:00:00Z'));

/** Build a fake fetch that records the single request and returns `response`. */
function stubFetch(response: { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('createPaymentIntent (Model B)', () => {
  const okBody = {
    intent_id: 'pi_abc',
    status: 'created',
    amount_usd_cents: 100,
    corridor: 'vn_vietqr',
    session_token: 'eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJ6ZW5ub3BheS1jaGVja291dCJ9.sig',
    session_expires_at: 1_784_690_447,
  };

  it('sends the attestations + partner_user_id in the request body', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 201, body: okBody });
    await createPaymentIntent(
      cfg,
      { partnerUserId: 'demo_user_1', amountUsdCents: 100, corridor: 'vn_vietqr', attestations },
      { fetchImpl },
    );
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toMatchObject({
      partner_user_id: 'demo_user_1',
      amount_usd_cents: 100,
      corridor: 'vn_vietqr',
      kyc_attestation: attestations.kyc,
      sanctions_attestation: attestations.sanctions,
    });
  });

  it('POSTs to /v1/payment_intents with an Idempotency-Key + signed headers', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 201, body: okBody });
    await createPaymentIntent(
      cfg,
      { partnerUserId: 'demo_user_1', amountUsdCents: 100, corridor: 'vn_vietqr', attestations },
      { fetchImpl, idempotencyKey: 'idem-123' },
    );
    expect(calls[0]!.url).toBe('https://api.sandbox.zennopay.in/v1/payment_intents');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('idem-123');
    expect(headers['X-Zennopay-Key-Id']).toBe('pk_test_key');
    expect(headers['X-Zennopay-Signature']).toMatch(/.+/);
  });

  it('parses the Zennopay-minted session_token + session_expires_at', async () => {
    const { fetchImpl } = stubFetch({ status: 201, body: okBody });
    const res = await createPaymentIntent(
      cfg,
      { partnerUserId: 'demo_user_1', amountUsdCents: 100, corridor: 'vn_vietqr', attestations },
      { fetchImpl },
    );
    expect(res.intentId).toBe('pi_abc');
    expect(res.sessionToken).toBe(okBody.session_token);
    expect(res.sessionExpiresAt).toBe(1_784_690_447);
  });

  it('throws ZennopayApiError on a non-201 response', async () => {
    const { fetchImpl } = stubFetch({ status: 422, body: { error: 'bad' } });
    await expect(
      createPaymentIntent(
        cfg,
        { partnerUserId: 'u', amountUsdCents: 100, corridor: 'vn_vietqr', attestations },
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(ZennopayApiError);
  });

  it('throws if the API returns 201 but no session_token', async () => {
    const { fetchImpl } = stubFetch({ status: 201, body: { intent_id: 'pi_abc' } });
    await expect(
      createPaymentIntent(
        cfg,
        { partnerUserId: 'u', amountUsdCents: 100, corridor: 'vn_vietqr', attestations },
        { fetchImpl },
      ),
    ).rejects.toThrow(/session_token/);
  });
});

describe('remintSession (Model B refresh)', () => {
  const okBody = { session_token: 'eyJ.remint.sig', session_expires_at: 1_784_690_999 };

  it('POSTs to /v1/payment_intents/:id/session with NO Idempotency-Key', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: okBody });
    await remintSession(cfg, 'pi_abc', { partnerUserId: 'demo_user_1', attestations }, { fetchImpl });
    expect(calls[0]!.url).toBe('https://api.sandbox.zennopay.in/v1/payment_intents/pi_abc/session');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
    expect(headers['X-Zennopay-Signature']).toMatch(/.+/);
  });

  it('sends partner_user_id + attestations (no amount/corridor — the intent exists)', async () => {
    const { fetchImpl, calls } = stubFetch({ status: 200, body: okBody });
    await remintSession(cfg, 'pi_abc', { partnerUserId: 'demo_user_1', attestations }, { fetchImpl });
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent).toEqual({
      partner_user_id: 'demo_user_1',
      kyc_attestation: attestations.kyc,
      sanctions_attestation: attestations.sanctions,
    });
  });

  it('parses the re-minted session_token', async () => {
    const { fetchImpl } = stubFetch({ status: 200, body: okBody });
    const res = await remintSession(
      cfg,
      'pi_abc',
      { partnerUserId: 'demo_user_1', attestations },
      { fetchImpl },
    );
    expect(res.sessionToken).toBe('eyJ.remint.sig');
    expect(res.sessionExpiresAt).toBe(1_784_690_999);
  });

  it('throws ZennopayApiError on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch({ status: 404, body: { error: 'unknown_intent' } });
    await expect(
      remintSession(cfg, 'pi_missing', { partnerUserId: 'u', attestations }, { fetchImpl }),
    ).rejects.toBeInstanceOf(ZennopayApiError);
  });
});
