/**
 * Route tests for the Model B checkout flow. The API is stubbed via a
 * global-fetch override (the routes call the client with real `fetch`), so
 * these exercise: attestations → create intent → return the Zennopay-minted
 * `session_token`, plus refresh and the receipt-token guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createApp } from '../src/server.js';
import { _resetSessions } from '../src/store.js';

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: 'https://api.sandbox.zennopay.in',
    hmacKeyId: 'pk_test_key',
    hmacSecret: 'test_secret_do_not_use_0123456789abcdef',
    jwtPrivateKey: null,
    jwtKid: null,
    jwtIss: null,
    port: 8787,
    webhookSecret: null,
    defaultCorridor: 'vn_vietqr',
    ...overrides,
  };
}

/** Route a JSON POST through the Hono app. */
function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetSessions();
  process.env.ATTESTATIONS_MODE = 'sandbox-stub';
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ATTESTATIONS_MODE;
});

describe('POST /checkout/session (Model B)', () => {
  it('returns { intent_id, session_token } from the Zennopay API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            intent_id: 'pi_live_1',
            status: 'created',
            session_token: 'eyJ.session.token',
            session_expires_at: 1_784_690_447,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const app = createApp(baseConfig());
    const res = await post(app, '/checkout/session', {
      user_id: 'demo_user_1',
      amount_usd_cents: 100,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.intent_id).toBe('pi_live_1');
    expect(json.session_token).toBe('eyJ.session.token');
    // No self-minted JWT field leaks through.
    expect(json.session_jwt).toBeUndefined();
  });

  it('rejects a missing user_id with 400', async () => {
    const app = createApp(baseConfig());
    const res = await post(app, '/checkout/session', { amount_usd_cents: 100 });
    expect(res.status).toBe(400);
  });

  it('surfaces a Zennopay API error as 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'nope' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const app = createApp(baseConfig());
    const res = await post(app, '/checkout/session', {
      user_id: 'demo_user_1',
      amount_usd_cents: 100,
    });
    expect(res.status).toBe(502);
  });
});

describe('POST /checkout/session/refresh (Model B)', () => {
  it('re-mints via /:id/session and returns a fresh session_token', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/session')) {
        return new Response(
          JSON.stringify({ session_token: 'eyJ.refreshed.token', session_expires_at: 1_784_699_999 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          intent_id: 'pi_live_1',
          session_token: 'eyJ.session.token',
          session_expires_at: 1_784_690_447,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp(baseConfig());

    await post(app, '/checkout/session', { user_id: 'demo_user_1', amount_usd_cents: 100 });
    const res = await post(app, '/checkout/session/refresh', { intent_id: 'pi_live_1' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.session_token).toBe('eyJ.refreshed.token');

    // The refresh call hit the /:id/session endpoint.
    const remintCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/pi_live_1/session'));
    expect(remintCall).toBeDefined();
  });

  it('404s for an unknown intent', async () => {
    const app = createApp(baseConfig());
    const res = await post(app, '/checkout/session/refresh', { intent_id: 'pi_unknown' });
    expect(res.status).toBe(404);
  });
});

describe('POST /receipt-token (keypair optional)', () => {
  it('answers 501 when the optional JWT keypair is not configured', async () => {
    const app = createApp(baseConfig());
    const res = await post(app, '/receipt-token', { user_id: 'demo_user_1' });
    expect(res.status).toBe(501);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.detail)).toMatch(/PAY-39/);
  });

  it('mints a receipt token when the keypair IS configured', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const app = createApp(
      baseConfig({ jwtPrivateKey: privateKey, jwtKid: 'kid-1', jwtIss: 'https://p.example/iss' }),
    );
    const res = await post(app, '/receipt-token', { user_id: 'demo_user_1' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.receipt_token).split('.')).toHaveLength(3);
  });
});
