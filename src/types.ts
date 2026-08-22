// GENERATED from src/x402/types.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * x402 protocol wire types — EMITS v1, PARSES v1 and v2.
 *
 * Shapes follow the x402 spec (Coinbase/x402 Foundation): a resource
 * server answers 402 with `PaymentRequiredResponse`; the client retries
 * with an `X-PAYMENT` header carrying base64(JSON(PaymentPayload)); the
 * facilitator verifies and settles; the server attaches
 * `X-PAYMENT-RESPONSE` = base64(JSON(SettleResponse)).
 *
 * FlareClaw is the first x402 facilitator on Flare (Coston2 first —
 * network id "coston2", eip155:114).
 */

/**
 * The version we EMIT in our own 402 challenges.
 *
 * We accept v2 payloads too (see `normalizeRequirements` /
 * `decodePaymentHeader`) — being a co-author of x402 extensions while
 * silently refusing the ecosystem's current wire format would be an
 * embarrassing kind of wrong. Emission stays on v1 until every one of
 * our own clients is v2-ready; acceptance is widened first, because
 * accepting more than you emit is the only safe direction to move a
 * protocol version.
 */
export const X402_VERSION = 1;

/** Versions this implementation can PARSE. */
export const SUPPORTED_X402_VERSIONS = [1, 2] as const;
export type X402Version = (typeof SUPPORTED_X402_VERSIONS)[number];

/**
 * How the payer authorizes the transfer (x402 v2 `extra.assetTransferMethod`).
 *
 * `eip3009` is the default and the only one we can SETTLE today — it is
 * the reason a third-party ERC-20 cannot currently pay us, since the
 * token itself must implement `transferWithAuthorization`. `permit2`
 * is x402's universal fallback for arbitrary ERC-20s; we parse it so a
 * v2 client's intent is never silently misread as EIP-3009, and refuse
 * it explicitly rather than mis-settling.
 */
export type AssetTransferMethod = 'eip3009' | 'permit2' | 'erc7710';

export const PAYMENT_HEADER = 'X-PAYMENT';
/**
 * v2 servers may deliver the challenge in a RESPONSE HEADER with a null body
 * instead of in the body. Measured on a live commercial deployment
 * (x402.glassnode.com, 2026-08-06): `payment-required:` base64, body `null`.
 * A client that only reads the body sees nothing and cannot pay them.
 */
export const PAYMENT_REQUIRED_HEADER = 'payment-required';
export const PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

/** One acceptable way to pay for a resource. */
export interface PaymentRequirements {
    scheme: 'exact';
    /** Network id, e.g. "coston2" (chainId 114). */
    network: string;
    /**
     * Price in the asset's atomic units, decimal string.
     *
     * v1 spells this `maxAmountRequired`; **v2 renamed it `amount`**.
     * Both are optional at the type level so either wire shape parses;
     * `requirementAmount()` is the single reader that resolves them, so
     * no call site has to know which version it is holding.
     */
    maxAmountRequired?: string;
    /** x402 v2 name for `maxAmountRequired`. */
    amount?: string;
    /** URL/path of the paid resource. */
    resource: string;
    description: string;
    mimeType: string;
    /** Receiving address (the platform treasury). */
    payTo: string;
    /** Seconds the client has to produce a settleable payment. */
    maxTimeoutSeconds: number;
    /** ERC-20 (EIP-3009) token contract address. */
    asset: string;
    /** EIP-712 domain of the asset — payers need name+version to sign.
     *  v2 additionally carries `assetTransferMethod` here. */
    extra: { name: string; version: string; assetTransferMethod?: AssetTransferMethod };
}

/** Body of every 402 response. */
export interface PaymentRequiredResponse {
    x402Version: X402Version;
    error: string;
    /** The offered options. v1 AND v2 both spell this `accepts` (array). */
    accepts?: PaymentRequirements[];
    /**
     * NOT a v2 rename of `accepts` — we had that wrong. In v2, `accepted` is a
     * DIFFERENT field carrying the SINGLE requirement a payer chose, and it
     * lives in the payment payload and settlement response, not in the 402.
     * (v2 spec §5.1.2: `PaymentRequired.accepts` is a required array; §5.2
     * `accepted` is "PaymentRequirements object indicating the payment method
     * chosen".) Kept here only so a server that misuses it in a 402 still
     * parses — being liberal in what we accept, not endorsing the shape.
     */
    accepted?: PaymentRequirements[] | PaymentRequirements;
}

/**
 * The amount a requirement asks for, whichever version wrote it.
 * Throws rather than defaulting: a missing price must never quietly
 * become zero on a payment path.
 */
export function requirementAmount(r: PaymentRequirements): string {
    const v = r.maxAmountRequired ?? r.amount;
    if (v === undefined) throw new Error('x402: requirement has neither maxAmountRequired (v1) nor amount (v2)');
    return v;
}

/**
 * The offered requirements of a 402 body.
 *
 * `accepts` is the spec field in BOTH versions. The `accepted` fallback exists
 * only to tolerate servers that put the chosen-requirement field in a 402 by
 * mistake; it is normalised to an array so no caller has to care.
 */
export function offeredRequirements(body: PaymentRequiredResponse): PaymentRequirements[] {
    if (body.accepts) return body.accepts;
    if (!body.accepted) return [];
    return Array.isArray(body.accepted) ? body.accepted : [body.accepted];
}

/** Declared transfer method, defaulting per spec to `eip3009`. */
export function transferMethod(r: PaymentRequirements): AssetTransferMethod {
    return r.extra?.assetTransferMethod ?? 'eip3009';
}

/** EIP-3009 TransferWithAuthorization message (all uints as decimal strings). */
export interface Eip3009Authorization {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    /** 32-byte hex nonce, unique per (from, nonce) — on-chain replay guard. */
    nonce: string;
}

/** Scheme-specific payload for "exact" on EVM. */
export interface ExactEvmPayload {
    /** 65-byte EIP-712 signature over the authorization, hex. */
    signature: string;
    authorization: Eip3009Authorization;
}

/** Decoded content of the X-PAYMENT header. */
export interface PaymentPayload {
    x402Version: typeof X402_VERSION;
    scheme: 'exact';
    network: string;
    payload: ExactEvmPayload;
}

/**
 * Machine-readable failure classes for `verify`.
 *
 * ── WHY A CODE AND NOT JUST PROSE ──
 * `invalidReason` is a human string, so a payer can only pattern-match
 * it — and every implementer words it differently. The distinction that
 * actually matters to a client is REMEDY: is this rejection permanent
 * (do not retry — you would be signing a second payment for a claim
 * that will never succeed), or is it a repairable local condition?
 *
 * Clock skew is the case that forced this. A payer whose clock is fast
 * builds `validAfter` in the future, or one whose clock is slow builds
 * `validBefore` too close to now; the facilitator rejects, and the
 * payer reads a generic failure as "this venue refuses me" when the
 * correct action is *resync your clock and re-sign*. That is a
 * repairable condition being reported as a rejection — the payer gives
 * up on a service that would have served them.
 */
export type InvalidCode =
    /** Payer's clock disagrees with the facilitator's. RESYNC AND RETRY. */
    | 'clock-skew'
    /** Payment terms don't match the requirements (payTo, asset, amount, scheme). */
    | 'terms-mismatch'
    /** Signature invalid or recovers to the wrong address. */
    | 'signature'
    /** Nonce already used or canceled — this authorization is spent. */
    | 'nonce-used'
    /**
     * A settlement for THIS (payer, nonce) is already broadcasting.
     * Distinct from `nonce-used`: that one is spent, this one is
     * in-flight and its outcome is not yet knowable. Retry after the
     * first attempt resolves — do NOT sign a fresh nonce (the original
     * may well succeed). Costs the payer nothing and the facilitator
     * no gas.
     */
    | 'nonce-in-flight'
    /** Payer lacks the funds. */
    | 'insufficient-funds'
    /** Authorization expired; a fresh one is required. */
    | 'expired'
    /** Malformed request the facilitator could not interpret. */
    | 'malformed';

export interface VerifyResponse {
    isValid: boolean;
    invalidReason?: string;
    /**
     * Machine-readable class of `invalidReason`. Optional for backward
     * compatibility — a client that ignores it behaves exactly as
     * before; one that reads it can tell "fix your clock" from "this
     * will never work".
     */
    invalidCode?: InvalidCode;
    /**
     * Present when the failure is clock-related: the facilitator's own
     * unix seconds at verification, so the payer can measure its skew
     * directly instead of guessing. This is the same courtesy HTTP
     * `Date` provides — the server already knows the answer, and
     * withholding it makes the payer's problem unsolvable.
     */
    serverTime?: number;
    /** Recovered payer address (when the signature is valid). */
    payer?: string;
}

export interface SettleResponse {
    success: boolean;
    errorReason?: string;
    /** Same classification as VerifyResponse — settle verifies first. */
    invalidCode?: InvalidCode;
    /** Facilitator's unix seconds, present on clock-related failures. */
    serverTime?: number;
    /** Settlement transaction hash. */
    transaction: string;
    network: string;
    payer: string;
}
