# zennopay-partner-starter

The official starter for **Zennopay partner backends**. It implements the
partner side of the PaymentSheet integration — the part every partner has to
build before the SDK can do anything.

**Model B (session tokens minted by Zennopay).** Your backend authenticates to
Zennopay with **HMAC only**. When you create a payment intent, Zennopay mints
the short-lived checkout-session token and returns it in the same response —
you relay that `session_token` to the PaymentSheet SDK. **No RS256 keypair and
no self-signed session JWT are required for checkout.**

- **`POST /checkout/session`** — creates a Zennopay payment intent
  (HMAC-signed server-to-server call, with your KYC + sanctions attestations)
  and returns the Zennopay-minted `session_token` the PaymentSheet SDK consumes.
- **`POST /checkout/session/refresh`** — re-mints the session token for an
  existing intent (same user) when the short-lived token expires mid-checkout.
- **`POST /receipt-token`** — mints a short-lived, user-scoped, read-only
  receipt token. Call it when a user taps a row in **your** transaction-history
  UI; the SDK uses it with `Zennopay.presentReceipt(intentId, receiptToken)` to
  reopen the authoritative Zennopay receipt (live pending/refund status). This
  is the one flow that still uses the **optional** partner JWT keypair; it
  answers 501 until you configure it (Zennopay-minted receipts are coming —
  PAY-39). You keep the history list; Zennopay owns the receipt.
- **`POST /zennopay/webhook`** — signature-verified intake for
  `payment_intent.*` events, routed to a pluggable wallet/ledger seam.
- **`GET /health`** — liveness probe.
- **`npm run verify`** — a setup **doctor** that proves your HMAC signing
  against the sandbox and confirms Zennopay mints a session token, step by
  step, with a specific hint for every possible failure.

Stack: Node 20+, TypeScript, [Hono](https://hono.dev). Two runtime
dependencies. MIT licensed — fork it, gut it, make it yours.

## 10-minute quickstart

```bash
# 1. Clone and install (≈1 min)
git clone https://github.com/Zennopay/zennopay-partner-starter.git
cd zennopay-partner-starter
npm install

# 2. Configure (≈2 min)
cp .env.example .env
# Fill in .env with the values from your Zennopay onboarding pack:
#   - ZENNOPAY_HMAC_KEY_ID + ZENNOPAY_HMAC_SECRET
#   - ZENNOPAY_BASE_URL (defaults to the .in sandbox)
# That's it for checkout — no keypair to generate or register. (The JWT
# keypair is optional and only used by /receipt-token; see .env.example.)

# 3. Prove it (≈1 min)
npm run verify
# ✓ environment → ✓ reachability → ✓ real sandbox intent + minted session_token
# Ends with "Ready for the SDK." and a real intent id.

# 4. Run it
npm run dev
curl -s localhost:8787/checkout/session \
  -H 'content-type: application/json' \
  -d '{"user_id":"demo_user_1","amount_usd_cents":500}'
# → {"intent_id":"pi_…","session_token":"eyJ…","expires_at":"…"}
```

Hand `session_token` (the token Zennopay minted) to the Zennopay PaymentSheet
SDK and you have your first sandbox checkout.

> **Sandbox note:** until you wire `src/attestations.ts` to your real KYC and
> sanctions systems, set `ATTESTATIONS_MODE=sandbox-stub` in `.env` to issue
> clearly-fake attestations. This is refused against production.

## What you must replace before go-live

The starter is deliberately honest about its seams. Each is one file:

| Seam | File | Why |
| --- | --- | --- |
| KYC + sanctions attestations | `src/attestations.ts` | The create-intent request carries your **regulated attestation** that the user is verified and screened; Zennopay verifies it and binds it into the minted session token. The stub throws until you implement it. |
| Wallet / ledger | `src/wallet.ts` | Webhook events (captured / failed / refunded / reversed) must post to your real ledger, idempotently, keyed on `webhook_event_id`. |
| Session storage | `src/store.ts` | The intent→user map is in-memory. Use a table in your DB. |
| Endpoint auth | `src/server.ts` | `/checkout/session` must sit behind **your** app auth. |

## The 3-week integration plan

Zennopay integrations are scheduled at three weeks. This starter is week 1.

**Week 1 — keys, starter, first captured sandbox payment**
- Receive the onboarding pack (sandbox HMAC keys, dashboard access).
- Deploy this starter with your HMAC key id + secret, `npm run verify` green
  (no keypair to generate — Zennopay mints the session token).
- Point the PaymentSheet SDK (iOS/Android) at `/checkout/session`; capture a
  first sandbox payment end-to-end.

**Week 2 — app SDK, theming, wallet seam**
- Theme the PaymentSheet to your brand.
- Implement `src/attestations.ts` against your real KYC/sanctions systems.
- Implement `src/wallet.ts` (hold on session create, debit on capture) and
  move `src/store.ts` into your DB.

**Week 3 — edge cases, limits, webhooks, go-live review**
- Register your webhook endpoint, set `ZENNOPAY_WEBHOOK_SECRET`, handle all
  four `payment_intent.*` events idempotently.
- Exercise failure paths: expired session token → refresh, per-user corridor
  limits, declined payouts, webhook retries.
- Go-live review with Zennopay; swap to production keys and URLs.

## The doctor

`npm run verify` runs three checks and stops at the first failure with a
targeted hint:

1. **Environment** — HMAC key id + secret present, base URL sane. (The JWT
   keypair is optional under Model B; the doctor just notes whether it's set.)
2. **Reachability** — can your machine see the Zennopay API at all?
3. **HMAC round-trip** — creates a **real** minimal intent
   (`amount_usd_cents: 100`) in the sandbox, confirms Zennopay **minted** a
   `session_token`, and decodes it (`aud=zennopay-checkout`, `iss`) as a
   sanity check. Creating an intent moves no money. A 401 prints the full
   canonical-string checklist plus any verbose auth hints the sandbox returns.

## Deploying

Any Node 20+ host works. A multi-stage `Dockerfile` (node:20-slim) is included.

- **Cloud Run**: `gcloud run deploy --source .` — put secrets in Secret
  Manager and mount them as env vars.
- **Render / Fly / Railway**: point at the repo, set env vars in the
  dashboard, done.
- **Bare Node**: `npm run build && node dist/index.js`.

Inject secrets via your platform's secret manager. Never bake them into
images and never commit `.env` (it is gitignored).

## Security notes

- **The HMAC secret lives on your server only** (and the optional receipt
  keypair, if used). It must never reach a browser, mobile app, or client-side
  bundle. The whole point of the session-token design is that clients only ever
  hold a short-lived, single-intent token that **Zennopay** minted.
- **Session tokens are short-lived by design.** When one expires mid-checkout,
  call `/checkout/session/refresh` to have Zennopay re-mint it — never ask for a
  longer-lived token.
- **Attestations must be real.** `verified: true` / `clean: true` are
  regulated statements about your user. The sandbox stub exists so you can
  integrate in parallel — it refuses to run against production, and so should
  your review process.
- **Webhook verification is not optional.** The handler rejects bad
  signatures, stale timestamps (±5 min), and replayed nonces. In production,
  back the nonce cache with Redis/your DB.
- Rotate keys through the dashboard; sandbox and production credentials are
  separate on purpose.

## Tests

```bash
npm test            # unit tests: canonical vectors, client (intent + session token),
                    #             checkout routes, receipts, webhook verification
npx tsc --noEmit    # strict TypeScript, clean
```

The canonical-request test vectors are committed
(`test/vectors/canonical.json`) and generated from this implementation with a
documented fake secret — useful as a byte-exact reference if you port the
signing code to another language.

## Docs

Full API reference, SDK guides, and corridor details:
[Zennopay/zennopay-docs](https://github.com/Zennopay/zennopay-docs).

## License

MIT
