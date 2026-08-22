// GENERATED from src/x402/trust-sdk.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * @flareclaw/x402-trust — the trust layer for agents that spend money.
 *
 * An agent about to pay another agent has two questions, and an agent that just
 * did work has one obligation. This module answers all three in a handful of
 * lines, with zero dependencies and — for the verification half — zero network
 * and zero trust in us:
 *
 *   BEFORE YOU PAY   checkService(domain) — discover a service, verify what can
 *                    be verified, and get a plain safeToPay decision with the
 *                    reasons behind it. Composes the hardened resolver
 *                    (same-origin enforcement, SSRF/DoS guards, HTTPS-only,
 *                    live cross-check) so a caller need not re-implement the
 *                    adversarial edge cases.
 *
 *   WHAT YOU'RE HANDED   verifyReceipt / verifyDirectoryEntry / verifyReconcileRow
 *                    — check ONE row of a Merkle-committed receipt, census, or
 *                    reconciliation against its signed root, holding nothing
 *                    else. Pure math (RFC 6962). It does not call us, and it
 *                    does not trust us: if the proof verifies, the claim is
 *                    true whoever produced it.
 *
 *   WHAT YOU PRODUCE   new Transcript() — accumulate {id, input, output} entries
 *                    and emit a root plus per-entry inclusion proofs, so the
 *                    work YOUR agent did is provable to a third party without
 *                    disclosing the rest of the session.
 *
 * The verification functions are the point of the whole library: an enterprise
 * does not have to trust FlareClaw to use FlareClaw's proofs. That is the only
 * kind of trust layer worth adopting.
 */
import {
    resolveX402, type ResolveResult, X402NegativeCacheError,
} from './discovery.js';
import {
    transcriptRoot, inclusionProof, verifyInclusion, type TranscriptEntry,
} from './merkle-transcript.js';
import { verifyEntry, type DirectoryEntry } from './attested-directory.js';
import { verifyRow, type ReconcileRow } from './census-reconcile.js';

// ──────────────────── BEFORE YOU PAY ────────────────────

export interface ServiceTrust {
    domain: string;
    /** A discovery record or manifest resolved at all. */
    reachable: boolean;
    /** It resolved to a valid x402 discovery manifest. */
    discoverable: boolean;
    /** How the manifest was found. */
    via?: 'dns-txt' | 'well-known';
    /** The manifest carries a TEE/attestation claim. */
    attested: boolean;
    /**
     * The attestation claim is INDEPENDENTLY CHECKABLE — a same-origin HTTPS
     * verifier the caller could dereference. False for an absent, `none`, or
     * off-origin verifier: a claim, not a verified claim.
     */
    attestationCheckable: boolean;
    /** Live /supported cross-check outcome (ok/skipped/unreachable/malformed/refused). */
    liveCheck?: ResolveResult['liveCheck'];
    /** True when the facilitator's live kinds match its manifest kinds. */
    liveConsistent: boolean | null;
    /** Manifest entries the resolver DROPPED as off-domain — a spoofing signal, surfaced not hidden. */
    warnings: string[];
    /** The composed decision under the chosen policy. */
    safeToPay: boolean;
    /** Why, in plain words — safe to log, safe to show a human. */
    reasons: string[];
    /** The raw resolver result, for callers that want the detail. */
    resolution?: ResolveResult;
}

export interface CheckServiceOptions {
    /** Require an independently-checkable attestation for safeToPay (default false). */
    requireAttestation?: boolean;
    /** Require the live /supported cross-check to have PASSED (default false — 'skipped' is allowed). */
    requireLiveConsistent?: boolean;
    /** Pass-throughs for tests / custom transports. */
    resolveTxt?: Parameters<typeof resolveX402>[1] extends infer O ? O extends { resolveTxt?: infer T } ? T : never : never;
    fetchImpl?: typeof fetch;
    lookupImpl?: Parameters<typeof resolveX402>[1] extends infer O ? O extends { lookupImpl?: infer L } ? L : never : never;
    noCache?: boolean;
}

/**
 * Resolve a domain and decide whether an agent should pay it. The default
 * policy is deliberately conservative but not paranoid: a service is safe to
 * pay when it is genuinely discoverable, nothing was dropped as a spoofing
 * attempt, and the live cross-check did not REFUSE (a dead live signal is a
 * warning, not a veto, unless you ask for one). Tighten with requireAttestation
 * / requireLiveConsistent.
 */
export async function checkService(domain: string, opts: CheckServiceOptions = {}): Promise<ServiceTrust> {
    const reasons: string[] = [];
    let resolution: ResolveResult | undefined;
    try {
        resolution = await resolveX402(domain, {
            ...(opts.resolveTxt ? { resolveTxt: opts.resolveTxt } : {}),
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.lookupImpl ? { lookupImpl: opts.lookupImpl } : {}),
            ...(opts.noCache ? { noCache: true } : {}),
        });
    } catch (e) {
        // A resolver refusal (spoofing/malformed/SSRF/DoS) is a firm NO, and its
        // reason is worth surfacing rather than collapsing to "unreachable".
        const cached = e instanceof X402NegativeCacheError;
        return {
            domain, reachable: false, discoverable: false, attested: false,
            attestationCheckable: false, liveConsistent: null, warnings: [],
            safeToPay: false,
            reasons: [`resolution ${cached ? 'refused (cached)' : 'failed'}: ${(e as Error).message}`],
        };
    }

    const attested = !!(resolution.manifest as { attestation?: { type?: string } }).attestation
        && (resolution.manifest as { attestation?: { type?: string } }).attestation!.type !== 'none';
    const attestationCheckable = resolution.attestationUsable === true;
    const liveConsistent = resolution.kindsMatchLive ?? null;
    const warnings = [
        ...(resolution.droppedResources ?? []).map((r) => `dropped off-domain resource: ${r}`),
        ...(resolution.droppedPeers ?? []).map((p) => `dropped peer hint: ${p}`),
    ];

    reasons.push(`discoverable via ${resolution.via}`);
    if (attested) reasons.push(attestationCheckable ? 'attestation claim is same-origin checkable' : 'attestation claim present but NOT independently checkable');
    if (resolution.liveCheck) reasons.push(`live cross-check: ${resolution.liveCheck}`);
    if (liveConsistent === false) reasons.push('WARNING: live /supported disagrees with the manifest');
    for (const w of warnings) reasons.push(`WARNING: ${w}`);

    let safeToPay = resolution.liveCheck !== 'refused' && warnings.length === 0;
    if (opts.requireAttestation && !attestationCheckable) { safeToPay = false; reasons.push('policy: attestation required, none checkable'); }
    if (opts.requireLiveConsistent && liveConsistent !== true) { safeToPay = false; reasons.push('policy: live consistency required, not confirmed'); }

    return {
        domain, reachable: true, discoverable: true, via: resolution.via,
        attested, attestationCheckable,
        ...(resolution.liveCheck ? { liveCheck: resolution.liveCheck } : {}),
        liveConsistent, warnings, safeToPay, reasons, resolution,
    };
}

// ──────────────────── WHAT YOU'RE HANDED (offline, zero-trust) ────────────────────

/** One retail receipt proof: an entry, its position, the tree size, the path, the signed root. */
export interface ReceiptProof {
    entry: TranscriptEntry;
    index: number;
    size: number;
    proof: string[];
    root: string;
}

/**
 * Verify ONE draw/work receipt against its signed root, holding nothing else.
 * Pure RFC 6962. Returns true iff the entry was genuinely in the committed
 * transcript at that position — no network, no trust in the producer.
 */
export function verifyReceipt(p: ReceiptProof): boolean {
    return verifyInclusion(p.entry, p.index, p.size, p.proof, p.root);
}

/** Verify one directory-census entry against a census outputRoot. */
export function verifyDirectoryEntry(
    entry: DirectoryEntry, index: number, size: number, proof: string[], outputRoot: string,
): boolean {
    return verifyEntry(entry, index, size, proof, outputRoot);
}

/** Verify one reconciliation row against a reconciliation rowsRoot. */
export function verifyReconcileRow(
    row: ReconcileRow, index: number, size: number, proof: string[], rowsRoot: string,
): boolean {
    return verifyRow(row, index, size, proof, rowsRoot);
}

// ──────────────────── WHAT YOU PRODUCE ────────────────────

/**
 * Build a verifiable transcript of the work your agent did. Add {id, input,
 * output} entries; emit a root you sign/anchor and per-entry inclusion proofs a
 * counterparty can check with verifyReceipt — WITHOUT seeing the rest.
 *
 * `id` is committed (it distinguishes two otherwise-identical entries — the
 * payment-intent identity), so the transcript cannot be made to undercount two
 * distinct pieces of work.
 */
export class Transcript {
    private entries: TranscriptEntry[] = [];

    /** Append one unit of work: an identifier, its input, and its output. */
    add(id: string, input: string, output: string): this {
        this.entries.push({ drawId: id, nonce: input, seed: output });
        return this;
    }

    /** Number of entries so far. */
    get size(): number { return this.entries.length; }

    /** The Merkle root to sign or anchor — the single value that commits to all entries. */
    root(): string { return transcriptRoot(this.entries); }

    /** A retail inclusion proof for entry `index`, ready to hand to a verifier. */
    prove(index: number): ReceiptProof {
        const entry = this.entries[index];
        if (!entry) throw new Error(`index ${index} outside transcript of ${this.entries.length}`);
        return { entry, index, size: this.entries.length, proof: inclusionProof(this.entries, index), root: this.root() };
    }
}
