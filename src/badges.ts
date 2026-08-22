// GENERATED from src/x402/badges.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * badges — reading the x402 `attestations` extension registry (#3000)
 * with ZERO dependencies.
 *
 * ── WHY ZERO DEPENDENCIES ──
 * This ships as the reference client for a trust extension. A package
 * whose job is "decide whether to trust a stranger before paying them"
 * cannot credibly arrive with a dependency tree the reader will never
 * audit. Everything here is one `eth_call` over `fetch` and some hex
 * slicing, so the whole trust path is readable in one sitting.
 *
 * The cost of that choice is that we cannot compute keccak256 at
 * runtime, so the function selector and the well-known `kind` hashes
 * are compile-time constants below. `tests/x402/badges.test.ts` derives
 * all of them with ethers and asserts equality, so a typo cannot
 * survive — the constants are verified, not trusted.
 */

/** keccak256("hasActiveBadge(address,bytes32)")[0..4] */
const HAS_ACTIVE_BADGE_SELECTOR = '0x322ad60a';

/**
 * keccak256(utf8(kind)) for the kinds this ecosystem has defined so far.
 * Callers may also pass a pre-hashed 0x-prefixed bytes32 for any other
 * kind, or supply their own keccak via `hashKind`.
 */
export const KNOWN_BADGE_KINDS: Readonly<Record<string, string>> = Object.freeze({
    'x402-facilitator-attested': '0xdd51a17aff71777ed7ca01b179f89a5754182ef754023c65de446ce7abeb611e',
    'bingo-verifiable-venue': '0xf886e00578ed56c02ff72c2950ac3141e4d7221e874b739ab807b8c8f7e9370b',
    'agent-audits-before-paying': '0x7b93d3c0d725755d8d14df7aaef4fd20ed4d5b1c0c92c5a41a177787e5b72a42',
});

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Resolve a kind name (or pass through a pre-hashed bytes32). */
export function resolveKind(kind: string, hashKind?: (s: string) => string): string {
    if (BYTES32.test(kind)) return kind.toLowerCase();
    const known = KNOWN_BADGE_KINDS[kind];
    if (known) return known;
    if (hashKind) {
        const h = hashKind(kind);
        if (!BYTES32.test(h)) throw new Error(`hashKind returned a non-bytes32 value for "${kind}"`);
        return h.toLowerCase();
    }
    throw new Error(
        `unknown badge kind "${kind}" — pass a 0x-prefixed bytes32, or supply hashKind (e.g. ethers.id)`,
    );
}

export interface BadgeQuery {
    /** JSON-RPC endpoint for the chain the registry lives on. */
    rpcUrl: string;
    /** Registry contract address. PIN THIS — see the note in hasActiveBadge. */
    registry: string;
    /** Address the record is about (facilitator settlement address, etc.). */
    subject: string;
    /** Kind name from KNOWN_BADGE_KINDS, or a pre-hashed bytes32. */
    kind: string;
    hashKind?: (s: string) => string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}

/**
 * `hasActiveBadge(subject, kind)` on a conforming registry.
 *
 * ⚠️ Spec rule (Security considerations, "Registry substitution"): a
 * malicious manifest can point at a lookalike registry, so a caller MUST
 * pin or allowlist the registries it accepts. This function deliberately
 * takes the registry as an explicit argument rather than reading it from
 * a manifest — so that pinning is a decision you make, not one you
 * forget to make.
 *
 * Throws on RPC failure rather than returning false: "I could not check"
 * and "I checked and it is not active" are different answers, and
 * collapsing them is how a chain outage turns into a silent trust
 * upgrade. Callers decide their own failure policy.
 */
export async function hasActiveBadge(q: BadgeQuery): Promise<boolean> {
    if (!ADDRESS.test(q.registry)) throw new Error(`registry is not an address: ${q.registry}`);
    if (!ADDRESS.test(q.subject)) throw new Error(`subject is not an address: ${q.subject}`);
    const kindHash = resolveKind(q.kind, q.hashKind);

    const data = HAS_ACTIVE_BADGE_SELECTOR
        + q.subject.toLowerCase().replace(/^0x/, '').padStart(64, '0')
        + kindHash.replace(/^0x/, '');

    const doFetch = q.fetchImpl ?? fetch;
    const res = await doFetch(q.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'eth_call',
            params: [{ to: q.registry, data }, 'latest'],
        }),
        signal: AbortSignal.timeout(q.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`badge RPC failed: HTTP ${res.status}`);
    const body = await res.json() as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(`badge RPC error: ${body.error.message ?? 'unknown'}`);
    if (typeof body.result !== 'string') throw new Error('badge RPC returned no result');
    // A bool is abi-encoded as a 32-byte word; anything nonzero is true.
    // An empty result means there is no contract at that address — which
    // is a misconfiguration, not a negative answer.
    const word = body.result.replace(/^0x/, '');
    if (word.length === 0) throw new Error(`no contract at registry ${q.registry}`);
    return /[1-9a-f]/i.test(word);
}

// ──────────────── Quorum reads for trust decisions ────────────────

export interface BadgeQuorumQuery extends Omit<BadgeQuery, 'rpcUrl'> {
    /** Independent RPC endpoints. Two must AGREE for an answer. */
    rpcUrls: string[];
    /** How many agreeing answers are required. Default 2 (or all, if fewer). */
    quorum?: number;
}

export type BadgeQuorumResult =
    | { status: 'agreed'; active: boolean; agreed: number; queried: number }
    /** Endpoints returned CONFLICTING answers — someone is lying or broken. */
    | { status: 'disputed'; answers: boolean[]; errors: string[] }
    /** Too few endpoints answered to reach quorum. Not a negative answer. */
    | { status: 'unavailable'; agreed: number; quorum: number; errors: string[] };

/**
 * `hasActiveBadge` across N independent endpoints, requiring agreement.
 *
 * ── WHY THIS EXISTS ──
 * Badge status GATES PAYMENTS, and a single `eth_call` is one endpoint's
 * word. Failover fixes liveness, not honesty: with one source, a hostile
 * or buggy RPC can report `active` for a revoked venue (or `inactive` to
 * censor a competitor) and the caller cannot tell. Any read whose answer
 * we act on without a second source needs a second source.
 *
 * Three outcomes, deliberately distinct — collapsing them is how a trust
 * check quietly stops being one:
 *   agreed      — quorum endpoints returned the same answer. Act on it.
 *   disputed    — endpoints DISAGREED. This is not "unknown", it is
 *                 evidence that one of them is wrong about a
 *                 payment-gating fact. Callers should refuse, not retry.
 *   unavailable — too few answered. "I could not check" ≠ "not active".
 */
export async function hasActiveBadgeQuorum(q: BadgeQuorumQuery): Promise<BadgeQuorumResult> {
    const urls = [...new Set(q.rpcUrls)];
    if (urls.length === 0) throw new Error('hasActiveBadgeQuorum: rpcUrls is empty');
    // Deliberately NOT clamped to urls.length. Clamping would silently
    // turn a requested 2-of-N into 1-of-1 whenever a caller passed too
    // few (or duplicate) endpoints — the guarantee evaporating exactly
    // where nobody looks. Too few sources yields `unavailable`, which is
    // the truthful answer: this could not be checked to the requested
    // standard.
    const required = Math.max(1, q.quorum ?? 2);

    const settled = await Promise.allSettled(
        urls.map(rpcUrl => hasActiveBadge({ ...q, rpcUrl })),
    );
    const answers: boolean[] = [];
    const errors: string[] = [];
    for (const r of settled) {
        if (r.status === 'fulfilled') answers.push(r.value);
        else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }

    const yes = answers.filter(Boolean).length;
    const no = answers.length - yes;
    // Disagreement is checked BEFORE quorum: 2 yes + 1 no is not a
    // 2-of-3 pass, it is a contradiction about a fact that has exactly
    // one true value on one chain.
    if (yes > 0 && no > 0) return { status: 'disputed', answers, errors };
    if (answers.length >= required) {
        return { status: 'agreed', active: yes > 0, agreed: answers.length, queried: urls.length };
    }
    return { status: 'unavailable', agreed: answers.length, quorum: required, errors };
}

// ──────────────── Durable record vs live state ────────────────

export interface OperatorTrust {
    /** The durable claim: a verification happened and has not been revoked. */
    readonly verified: boolean;
    /** The live claim, read from the operator's own manifest right now. */
    readonly liveAttestation: 'tee' | 'none' | 'absent';
    /**
     * True only when the durable record AND the live state agree. This is
     * the value to gate a state-dependent decision on.
     */
    readonly attestedNow: boolean;
    readonly notes: readonly string[];
}

/**
 * Evaluate an operator the way the spec requires for any decision that
 * depends on RUNTIME state (e.g. "is settlement attested right now?").
 *
 * ── THE MISTAKE THIS FUNCTION EXISTS TO PREVENT ──
 * A registry record is soulbound, therefore durable. TEE attestation is
 * transient. Pointing the first at the second produces a claim that is
 * true when written and silently false later, with nothing in the record
 * to reveal the drift. We shipped exactly that: our own
 * `x402-facilitator-attested` record read `active` on-chain while our own
 * manifest honestly reported `attestation: none` because the enclave was
 * down. The record was not lying about what it attested — a verification
 * really did happen — it was being READ as a liveness signal it cannot
 * carry.
 *
 * So the two answers are kept separate and only combined explicitly:
 *   verified        — "was this operator verified?"      (registry)
 *   liveAttestation — "is it in that mode right now?"    (manifest)
 *   attestedNow     — both, which is what you actually gate on.
 *
 * Fails CLOSED: any inability to establish the live state yields
 * attestedNow === false.
 */
export async function checkOperatorTrust(opts: {
    manifest: { attestation?: { type?: string; verifier?: string } };
    rpcUrl: string;
    registry: string;
    subject: string;
    kind: string;
    hashKind?: (s: string) => string;
    fetchImpl?: typeof fetch;
}): Promise<OperatorTrust> {
    const notes: string[] = [];

    const att = opts.manifest.attestation;
    // Apply the extension's own "absent verification, treat as none" rule:
    // a TEE block whose verifier is not dereferenceable cannot be checked
    // by anyone, so it must not read as attested.
    let liveAttestation: 'tee' | 'none' | 'absent';
    if (!att) {
        liveAttestation = 'absent';
        notes.push('manifest carries no attestation block');
    } else if (att.type === 'tee' && typeof att.verifier === 'string' && att.verifier.startsWith('https://')) {
        liveAttestation = 'tee';
    } else {
        liveAttestation = 'none';
        notes.push(att.type === 'tee'
            ? 'manifest claims tee but its verifier is not a dereferenceable HTTPS URL — treated as none per spec'
            : `manifest reports attestation: ${att.type ?? 'unknown'}`);
    }

    let verified = false;
    try {
        // Spread conditionally: under exactOptionalPropertyTypes an
        // explicit `undefined` is not the same as an absent key.
        verified = await hasActiveBadge({
            rpcUrl: opts.rpcUrl, registry: opts.registry, subject: opts.subject,
            kind: opts.kind,
            ...(opts.hashKind ? { hashKind: opts.hashKind } : {}),
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
        if (!verified) notes.push('no active record for this subject+kind in the pinned registry');
    } catch (e) {
        notes.push(`registry unreadable (${e instanceof Error ? e.message : String(e)}) — treating as unverified`);
    }

    if (verified && liveAttestation !== 'tee') {
        notes.push('RECORD IS DURABLE, STATE IS NOT: the operator was verified, but is not running in the verified mode right now. Do not treat the record as a liveness signal.');
    }

    return { verified, liveAttestation, attestedNow: verified && liveAttestation === 'tee', notes };
}
