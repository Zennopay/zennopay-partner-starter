/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  TODO (REQUIRED BEFORE GO-LIVE): wire this to your REAL KYC and         │
 * │  sanctions-screening systems.                                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Every create-intent request carries two attestations that Zennopay TRUSTS
 * as your regulated statement of fact about the end user (Model B: Zennopay
 * verifies them and binds them into the session token it mints):
 *
 *   kyc_attestation        — "we verified this user's identity"
 *   sanctions_attestation  — "we screened this user and they are clean"
 *
 * These are compliance representations, not decoration. Returning
 * hardcoded `verified: true` / `clean: true` values for real users is a
 * violation of your partner agreement and of AML law in most jurisdictions.
 * Replace `getAttestations` with a lookup against your actual KYC vendor
 * record and your actual sanctions-screening result for that user.
 *
 * Field notes:
 *   - `id_type` / `id_country` declare which government ID the opaque user id
 *     was bound to at KYC. The raw ID number NEVER crosses to Zennopay — only
 *     your opaque user id (the JWT `sub`) does.
 *   - `id_type` must be one of: passport | national_id | pan | driving_license.
 *   - `id_country` is an ISO 3166-1 alpha-2 code (e.g. "IN", "TH", "VN").
 *   - Timestamps are ISO 8601. `verified_at` / `screened_at` should be the
 *     real times from your systems, not "now".
 */

export interface KycAttestation {
  verified: boolean;
  /** Your KYC program/vendor identifier, e.g. "acme_kyc_v3". */
  method: string;
  verified_at: string;
  id_type: 'passport' | 'national_id' | 'pan' | 'driving_license';
  /** ISO 3166-1 alpha-2. */
  id_country: string;
}

export interface SanctionsAttestation {
  clean: boolean;
  screened_at: string;
}

export interface Attestations {
  kyc: KycAttestation;
  sanctions: SanctionsAttestation;
}

/**
 * SANDBOX ONLY. Clearly-fake attestations for exercising the sandbox before
 * your compliance integration exists. Refuses to run against production.
 */
export function buildSandboxStubAttestations(now: Date = new Date()): Attestations {
  return {
    kyc: {
      verified: true,
      method: 'sandbox_stub_kyc', // fake — replace with your real KYC system's output
      verified_at: new Date(now.getTime() - 60_000).toISOString(),
      id_type: 'passport',
      id_country: 'IN',
    },
    sanctions: {
      clean: true, // fake — replace with your real sanctions screening result
      screened_at: new Date(now.getTime() - 30_000).toISOString(),
    },
  };
}

/**
 * The pluggable seam the session routes call.
 *
 * Default behavior:
 *   - `ATTESTATIONS_MODE=sandbox-stub` → returns fabricated sandbox values
 *     (and refuses if ZENNOPAY_BASE_URL points at production).
 *   - otherwise → THROWS, on purpose, so an unwired integration cannot
 *     silently attest compliance facts it never checked.
 *
 * Replace the body of this function with calls into your KYC vendor and
 * sanctions-screening systems. It is async so you can hit a DB or API.
 */
export async function getAttestations(partnerUserId: string): Promise<Attestations> {
  if (process.env.ATTESTATIONS_MODE === 'sandbox-stub') {
    const base = process.env.ZENNOPAY_BASE_URL ?? '';
    // Production host is api.zennopay.in; the sandbox (api.sandbox.zennopay.in)
    // has the extra `sandbox.` label, so this prefix check excludes it.
    if (base.startsWith('https://api.zennopay.in')) {
      throw new Error(
        'ATTESTATIONS_MODE=sandbox-stub is not allowed against the production API. ' +
          'Wire src/attestations.ts to your real KYC/sanctions systems first.',
      );
    }
    console.warn(
      `[attestations] SANDBOX STUB attestations issued for user ${partnerUserId} — ` +
        'not valid for production. Replace src/attestations.ts before go-live.',
    );
    return buildSandboxStubAttestations();
  }

  // ── TODO: replace everything below with your real implementation ─────────
  // Example shape:
  //   const kycRecord = await kycVendor.getVerification(partnerUserId);
  //   const screening = await sanctionsScreener.latestResult(partnerUserId);
  //   if (!kycRecord.verified) throw new UserNotVerifiedError(partnerUserId);
  //   return { kyc: {...}, sanctions: {...} };
  throw new Error(
    'getAttestations() is not implemented. Zennopay create-intent requests carry ' +
      'KYC and sanctions attestations that MUST come from your real compliance ' +
      'systems — edit src/attestations.ts. For sandbox experiments only, set ' +
      'ATTESTATIONS_MODE=sandbox-stub in your environment.',
  );
}
