/**
 * Intent → session bookkeeping.
 *
 * The refresh endpoint must re-mint a JWT for the SAME user and intent, so we
 * remember who each intent belongs to.
 *
 * PRODUCTION NOTE: this is an in-memory Map — it empties on every restart and
 * does not share across instances. Replace it with a table in your database
 * (intent_id PK, partner_user_id, amount_usd_cents, corridor, created_at).
 * You almost certainly want that row anyway, to reconcile webhooks against.
 */

export interface SessionRecord {
  intentId: string;
  partnerUserId: string;
  amountUsdCents: number;
  corridor: string;
  createdAt: string;
}

const sessions = new Map<string, SessionRecord>();

export function saveSession(record: SessionRecord): void {
  sessions.set(record.intentId, record);
}

export function findSession(intentId: string): SessionRecord | null {
  return sessions.get(intentId) ?? null;
}

/** Test seam. */
export function _resetSessions(): void {
  sessions.clear();
}
