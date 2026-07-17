/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  TODO (REQUIRED BEFORE GO-LIVE): wire these to your real wallet/ledger. │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The webhook handler calls this seam when Zennopay tells you a payment
 * reached a terminal state. This is where YOUR money movement happens:
 * debiting the user's stored-value wallet on capture, releasing holds on
 * failure, crediting back on refund/reversal.
 *
 * Implementation requirements for a real ledger:
 *   - Idempotency: Zennopay retries webhooks; you WILL see the same
 *     webhook_event_id more than once. Key your ledger writes on it.
 *   - Atomicity: post the ledger entry and mark the event processed in one
 *     DB transaction.
 *   - Never trust amounts from your own client apps — use the amounts in the
 *     (signature-verified) webhook payload.
 *
 * The stubs below only log. They deliberately do NOT throw, so webhook
 * delivery succeeds while you build — but nothing moves in your ledger until
 * you replace them.
 */

export interface IntentSnapshot {
  id: string;
  partner_user_id: string;
  amount_usd_cents: number;
  corridor: string;
  status: string;
  [k: string]: unknown;
}

function todo(action: string, intent: IntentSnapshot): void {
  console.warn(
    `[wallet] TODO not implemented: ${action} for user=${intent.partner_user_id} ` +
      `intent=${intent.id} amount_usd_cents=${intent.amount_usd_cents}. ` +
      'Wire src/wallet.ts to your real wallet/ledger before go-live.',
  );
}

/** Payment captured — debit the user's wallet for amount_usd_cents. */
export async function onPaymentCaptured(intent: IntentSnapshot): Promise<void> {
  todo('debit wallet (payment_intent.captured)', intent);
}

/** Payment failed — release any hold you placed at session creation. */
export async function onPaymentFailed(intent: IntentSnapshot, reason: string): Promise<void> {
  todo(`release hold (payment_intent.failed: ${reason})`, intent);
}

/** Refund issued — credit the user's wallet. */
export async function onPaymentRefunded(
  intent: IntentSnapshot,
  refund: { refund_id: string; amount_usd_cents: number },
): Promise<void> {
  todo(`credit wallet (payment_intent.refunded ${refund.refund_id})`, intent);
}

/** Capture reversed after the fact — credit the wallet and flag for review. */
export async function onCaptureReversed(
  intent: IntentSnapshot,
  reversal: { reversal_id: string; amount_usd_cents: number },
): Promise<void> {
  todo(`credit wallet (payment_intent.capture_reversed ${reversal.reversal_id})`, intent);
}
