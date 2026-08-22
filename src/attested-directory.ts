// GENERATED from src/x402/attested-directory.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * attested-directory — a census of x402 discovery records that a stranger can
 * check without trusting the party who produced it.
 *
 * THE PROBLEM THIS EXISTS FOR. Every directory in this ecosystem asks you to
 * trust an index. The measured consequence (our own sweep, 2026-08-18) is a
 * catalogue where 78% of listings have exactly one payer ever, five listings
 * carry 45% of all traffic, and listings age out for being unpopular. An index
 * that deletes you for having no customers is not infrastructure, and "trust
 * our index" is not a claim anyone should accept — including about ours.
 *
 * WHAT REPLACES THE TRUST. A census here commits to three things at once:
 *
 *   methodDigest  WHICH PROGRAM ran. Content-addressed, so "re-run it" is a
 *                 well-defined instruction rather than an invitation to write
 *                 your own and hope it matches.
 *   inputRoot     WHICH TARGETS it ran over. Without this a publisher can
 *                 quietly drop hosts whose verdicts it dislikes and no reader
 *                 can tell — the omission problem, applied to directories.
 *   outputRoot    WHAT IT FOUND, as an RFC 6962 tree rather than a flat hash.
 *
 * The tree is the part that makes it usable. A flat digest over 1,564 verdicts
 * forces anyone checking ONE host to download all 1,564 and recompute. With a
 * Merkle root, "host X had verdict Y in census C" is eleven hashes, and the
 * reader never sees the other 1,563 — which matters because a directory that
 * can only be checked wholesale will not be checked at all.
 *
 * WHAT THIS DOES NOT CLAIM. Being signed inside an enclave would prove the
 * program was not tampered with between build and run. That is a stronger
 * claim than a census signed anywhere else, and it is deliberately NOT made
 * here: this module produces the artifact, and `attestation` is populated only
 * when a caller supplies a real one. A census with no attestation says so.
 *
 * Discovery is not endorsement. A verdict describes what a program observed
 * from one vantage at one time. It says nothing about whether the operator is
 * honest, and the vocabulary below is chosen so it cannot be read that way.
 */
import { createHash } from 'node:crypto';
import { jcsCanonical, assertJcsSafe } from './manifest-sig.js';
import { transcriptRoot, inclusionProof, verifyInclusion, type TranscriptEntry } from './merkle-transcript.js';

export const DIRECTORY_SCHEMA = 'x402-attested-directory/1';

/**
 * What a census can say about a host. Ordered strongest to weakest claim, and
 * deliberately parallel to the fc-liveness vocabulary: `unreachable` is a
 * statement about OUR vantage on this date, never about the host.
 */
export type DirectoryVerdict =
    | 'discoverable-verified'   // record resolved AND the manifest is signature-authentic
    | 'discoverable'            // record resolved, no checkable signature
    | 'one-edit-away'           // valid but for fields the discovery extension introduces
    | 'not-discoverable'        // no record resolvable from here
    | 'unreachable';            // did not answer OUR vantage on this date

export interface DirectoryEntry {
    domain: string;
    verdict: DirectoryVerdict;
    /** One line a reader can check against the columns, never an accusation. */
    detail: string;
    /** The record as observed, verbatim, when there was one. */
    record?: string;
}

export interface Census {
    schema: typeof DIRECTORY_SCHEMA;
    observedAt: string;
    observer: string;
    /** sha256 of the program that produced this. "Re-run it" needs a referent. */
    methodDigest: string;
    /** How the target set was chosen — a census over a hand-picked set is not a census. */
    targetSource: string;
    size: number;
    inputRoot: string;
    outputRoot: string;
    tally: Record<DirectoryVerdict, number>;
    /** Present ONLY when the run was genuinely attested. Absent means not. */
    attestation?: { type: string; imageDigest?: string; tokenDigest?: string };
}

/** Targets as tree leaves: the question asked, independent of the answer. */
const inputLeaf = (domain: string): TranscriptEntry =>
    ({ drawId: domain, nonce: 'x402-directory-target', seed: '0x00' });

/**
 * Verdict leaves. The domain is inside the leaf, so a proof cannot be moved
 * from one host to another — without it, a verdict for a host that passed
 * could be replayed as a verdict for one that did not.
 */
const outputLeaf = (e: DirectoryEntry): TranscriptEntry => {
    // Commit the OBSERVED RECORD, not just the verdict and prose. Without it a
    // proof bundle's `record` could be swapped for arbitrary content and still
    // verify — a "verified" census entry carrying a fabricated record — and
    // two sweeps differing only in the observed record would recompute
    // identical roots, so recomputeRoots would miss a real observation
    // difference. `record ?? null` keeps the leaf defined when a host has no
    // record. (Crypto review D2, 2026-08-19.)
    const core = { domain: e.domain, verdict: e.verdict, detail: e.detail, record: e.record ?? null };
    assertJcsSafe(core);
    return {
        drawId: e.domain,
        nonce: e.verdict,
        seed: '0x' + createHash('sha256').update(jcsCanonical(core), 'utf8').digest('hex'),
    };
};

/**
 * Reject duplicate domains. A census with the same domain twice — one verdict
 * at index i, a different one at index j — lets a publisher anchor ONE digest
 * and then serve each retail verifier a valid inclusion proof for whichever
 * verdict suits, both verifying against the same outputRoot. That is exactly
 * the equivocation CT log operators are audited against, and it makes the
 * retail claim "host X had verdict Y in census C" ill-defined. (Review D1.)
 */
function assertCanonicalOrder(entries: DirectoryEntry[]): void {
    // Unique AND ascending by domain, asserted rather than imposed. buildCensus
    // must NOT silently re-sort: proveEntry/verifyEntry operate on the SAME
    // array a caller holds, so if buildCensus reordered internally, a caller's
    // index-based proof would not verify against the census's own outputRoot.
    // classifySweep already yields this order; anything else is a caller bug.
    const seen = new Set<string>();
    let prev = '';
    for (const e of entries) {
        if (seen.has(e.domain)) throw new Error(`[x402-directory] duplicate domain in census: ${e.domain}`);
        if (prev && e.domain < prev) {
            throw new Error(`[x402-directory] entries must be sorted by domain (${e.domain} after ${prev}) — use classifySweep`);
        }
        seen.add(e.domain);
        prev = e.domain;
    }
}

const EMPTY_TALLY = (): Record<DirectoryVerdict, number> => ({
    'discoverable-verified': 0, discoverable: 0, 'one-edit-away': 0,
    'not-discoverable': 0, unreachable: 0,
});

export function buildCensus(entries: DirectoryEntry[], meta: {
    observer: string; methodDigest: string; targetSource: string; observedAt: string;
    attestation?: Census['attestation'];
}): Census {
    assertCanonicalOrder(entries);
    const tally = EMPTY_TALLY();
    for (const e of entries) tally[e.verdict]++;
    return {
        schema: DIRECTORY_SCHEMA,
        observedAt: meta.observedAt,
        observer: meta.observer,
        methodDigest: meta.methodDigest,
        targetSource: meta.targetSource,
        size: entries.length,
        inputRoot: transcriptRoot(entries.map((e) => inputLeaf(e.domain))),
        outputRoot: transcriptRoot(entries.map(outputLeaf)),
        tally,
        ...(meta.attestation ? { attestation: meta.attestation } : {}),
    };
}

/** The digest a census is anchored under. */
export function censusDigest(c: Census): string {
    assertJcsSafe(c);
    return 'sha256:' + createHash('sha256').update(jcsCanonical(c), 'utf8').digest('hex');
}

/** Prove ONE host's verdict without disclosing the rest of the census. */
export function proveEntry(entries: DirectoryEntry[], index: number): {
    entry: DirectoryEntry; index: number; size: number; proof: string[];
} {
    const entry = entries[index];
    if (!entry) throw new Error(`index ${index} outside census of ${entries.length}`);
    return { entry, index, size: entries.length, proof: inclusionProof(entries.map(outputLeaf), index) };
}

/**
 * Check one host's verdict against a published outputRoot, holding nothing
 * else. This is what makes the census checkable retail rather than wholesale.
 */
export function verifyEntry(
    entry: DirectoryEntry, index: number, size: number, proof: string[], outputRoot: string,
): boolean {
    return verifyInclusion(outputLeaf(entry), index, size, proof, outputRoot);
}

/**
 * Re-derive both roots from a full target list and result set. A second
 * observer runs this against their OWN sweep: matching roots mean identical
 * observations, and differing roots localise the disagreement rather than
 * hiding it. Disagreement is the signal.
 */
export function recomputeRoots(entries: DirectoryEntry[]): { inputRoot: string; outputRoot: string } {
    return {
        inputRoot: transcriptRoot(entries.map((e) => inputLeaf(e.domain))),
        outputRoot: transcriptRoot(entries.map(outputLeaf)),
    };
}

/**
 * Compare two censuses over the same targets. Returns the domains whose
 * verdicts differ — the two-observer diff that makes a directory falsifiable.
 */
export function diffCensus(a: DirectoryEntry[], b: DirectoryEntry[]): {
    sameTargets: boolean; disagreements: { domain: string; a: DirectoryVerdict; b: DirectoryVerdict }[];
} {
    const byDomainB = new Map(b.map((e) => [e.domain, e] as const));
    const sameTargets = a.length === b.length && a.every((e) => byDomainB.has(e.domain));
    const disagreements: { domain: string; a: DirectoryVerdict; b: DirectoryVerdict }[] = [];
    for (const e of a) {
        const other = byDomainB.get(e.domain);
        if (other && other.verdict !== e.verdict) {
            disagreements.push({ domain: e.domain, a: e.verdict, b: other.verdict });
        }
    }
    return { sameTargets, disagreements };
}
