// GENERATED from src/x402/census-reconcile.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * census-reconcile — a checkable statement of where two observers disagree.
 *
 * THE GAP THIS FILLS. Every party in this ecosystem publishes its own index
 * and asks readers to trust it. When two indexes disagree — and they always
 * do — there is no artifact for the disagreement itself, so a reader must pick
 * an observer to believe. Tonight alone: an uptime observatory reporting 36.7%
 * alive while a cross-probe of the same targets reported 92.5%; our own
 * second-observer sweep differing from a peer's on 17 of 1,521 hosts; and a
 * first draft of our own census mislabelling 1,418 hosts.
 *
 * Melchiorre Oliva's phrase for it is the right one: disagreement is the
 * signal. This makes the signal into an object.
 *
 * THE VOCABULARY IS BORROWED ON PURPOSE. Iman Schrock proposed a five-category
 * reconciliation vocabulary in the SCITT disclosure-evidence thread
 * (2026-08-16) and Emek adopted it in -03. It was built for reconciling two
 * populations of settlement evidence, and it fits two populations of discovery
 * observations without modification. Inventing a sixth vocabulary for the same
 * problem would be worse than useless — the value of a category name is that
 * two parties already agree what it means.
 *
 * Iman also corrected his own runner's strongest category DOWNWARD, because a
 * missing record only shows absence from a supplied population. That
 * correction is load-bearing here: this module NEVER concludes which observer
 * is right. It cannot. Two honest observers with different vantages,
 * different clocks and different resolvers will disagree without either being
 * wrong, and an artifact that adjudicates would be asserting more than its
 * inputs support.
 *
 * WHAT A READER GETS. The reconciliation is Merkle-committed, so a third party
 * who trusts NEITHER observer can verify one host's row — "these two disagreed
 * about this domain, this way" — from a handful of hashes, without downloading
 * either census.
 */
import { createHash } from 'node:crypto';
import { jcsCanonical, assertJcsSafe } from './manifest-sig.js';
import { transcriptRoot, inclusionProof, verifyInclusion, type TranscriptEntry } from './merkle-transcript.js';
import { recomputeRoots } from './attested-directory.js';
import type { Census, DirectoryEntry, DirectoryVerdict } from './attested-directory.js';

export const RECONCILE_SCHEMA = 'x402-census-reconciliation/1';

/**
 * Iman Schrock's five categories (SCITT, 2026-08-16), mapped to discovery.
 * The names are deliberately his; the mapping is stated so the borrowing is
 * checkable rather than decorative.
 */
export type ReconcileCategory =
    /** Both observers saw the host and agree on the verdict. */
    | 'matched'
    /** In A's population, absent from B's. NOT a claim that B missed it. */
    | 'observed-by-a-only'
    /** In B's population, absent from A's. */
    | 'observed-by-b-only'
    /** Both saw it, verdicts differ. No adjudication is offered or possible. */
    | 'divergent'
    /** At least one observer could not determine a verdict. */
    | 'indeterminate';

export interface ReconcileRow {
    domain: string;
    category: ReconcileCategory;
    a?: DirectoryVerdict;
    b?: DirectoryVerdict;
    /** Why this row is in this category, checkable against the columns. */
    note: string;
}

export interface Reconciliation {
    schema: typeof RECONCILE_SCHEMA;
    reconciledAt: string;
    /** Both censuses are identified by digest, never by nickname. */
    a: { observer: string; digest: string; size: number; observedAt: string };
    b: { observer: string; digest: string; size: number; observedAt: string };
    /** Union of both target populations — the denominator, stated. */
    size: number;
    rowsRoot: string;
    tally: Record<ReconcileCategory, number>;
    /**
     * Stated, not implied: this artifact does not decide who was right, and a
     * reader who wants a verdict must go and observe for themselves.
     */
    adjudication: 'none — two honest vantages may differ without either being wrong';
    /** Clock skew between the two observations, which explains many divergences. */
    observationSkewSeconds: number;
}

const EMPTY_TALLY = (): Record<ReconcileCategory, number> => ({
    matched: 0, 'observed-by-a-only': 0, 'observed-by-b-only': 0,
    divergent: 0, indeterminate: 0,
});

/**
 * Row leaves carry the domain, both verdicts AND the note. The note was
 * previously outside the commitment, so a relayer could rewrite a verified
 * row's note to adjudicating language ("observer B is known-bad") and the
 * proof would still verify — defeating the no-adjudication doctrine at exactly
 * the layer a third party checks. It is committed now. (Review R2.)
 */
const rowLeaf = (r: ReconcileRow): TranscriptEntry => {
    const core = { domain: r.domain, category: r.category, a: r.a ?? null, b: r.b ?? null, note: r.note };
    assertJcsSafe(core);
    return {
        drawId: r.domain,
        nonce: r.category,
        seed: '0x' + createHash('sha256').update(jcsCanonical(core), 'utf8').digest('hex'),
    };
};

const VALID_VERDICTS: ReadonlySet<string> = new Set<DirectoryVerdict>([
    'discoverable-verified', 'discoverable', 'one-edit-away', 'not-discoverable', 'unreachable',
]);

/** A verdict that admits the observer could not tell. */
const isIndeterminate = (v: DirectoryVerdict | undefined): boolean => v === 'unreachable';

export function reconcile(
    aCensus: Census, aEntries: DirectoryEntry[],
    bCensus: Census, bEntries: DirectoryEntry[],
    reconciledAt: string,
    digestOf: (c: Census) => string,
): { reconciliation: Reconciliation; rows: ReconcileRow[] } {
    // R1 — the entries must actually be the ones each census committed to.
    // Without this, a reconciler embeds a census's genuine digest as the
    // provenance of verdicts it never produced — a Merkle-committed, retail-
    // provable FABRICATED attribution, in the one artifact whose whole pitch
    // is "checkable by someone who trusts neither observer". Recompute both
    // root pairs and refuse on any mismatch.
    for (const [label, census, entries] of [['a', aCensus, aEntries], ['b', bCensus, bEntries]] as const) {
        if (entries.length !== census.size) {
            throw new Error(`[reconcile] ${label}: ${entries.length} entries but census.size ${census.size}`);
        }
        const r = recomputeRoots(entries);
        if (r.inputRoot !== census.inputRoot || r.outputRoot !== census.outputRoot) {
            throw new Error(`[reconcile] ${label}: entries do not recompute to the census's committed roots — refusing to attribute them`);
        }
    }
    // A present-but-invalid verdict must never reach the category ladder: an
    // entry with a dropped/blank verdict would otherwise slip through every
    // guard and land in 'matched' (undefined === undefined), publishing a
    // committed agreement out of a corrupt record. (Silent-failure 2a.)
    for (const [label, entries] of [['a', aEntries], ['b', bEntries]] as const) {
        for (const e of entries) {
            if (!VALID_VERDICTS.has(e.verdict)) {
                throw new Error(`[reconcile] ${label}: entry ${e.domain} has an out-of-vocabulary verdict ${JSON.stringify(e.verdict)}`);
            }
        }
    }
    const aBy = new Map(aEntries.map((e) => [e.domain, e] as const));
    const bBy = new Map(bEntries.map((e) => [e.domain, e] as const));
    // The denominator is the UNION. Reconciling only the intersection hides
    // exactly the population difference most worth seeing.
    const domains = [...new Set([...aBy.keys(), ...bBy.keys()])].sort();

    const rows: ReconcileRow[] = domains.map((domain): ReconcileRow => {
        const av = aBy.get(domain)?.verdict, bv = bBy.get(domain)?.verdict;
        if (av && !bv) {
            return { domain, category: 'observed-by-a-only', a: av,
                note: `in ${aCensus.observer}'s population, absent from ${bCensus.observer}'s — not a claim either missed it` };
        }
        if (bv && !av) {
            return { domain, category: 'observed-by-b-only', b: bv,
                note: `in ${bCensus.observer}'s population, absent from ${aCensus.observer}'s — not a claim either missed it` };
        }
        if (isIndeterminate(av) || isIndeterminate(bv)) {
            return { domain, category: 'indeterminate', ...(av ? { a: av } : {}), ...(bv ? { b: bv } : {}),
                note: 'at least one observer reported a vantage-limited verdict; no comparison is safe' };
        }
        if (av === bv) {
            return { domain, category: 'matched', ...(av ? { a: av } : {}), ...(bv ? { b: bv } : {}), note: 'both observers, same verdict' };
        }
        return { domain, category: 'divergent', ...(av ? { a: av } : {}), ...(bv ? { b: bv } : {}),
            note: 'both observed it and disagree; this artifact does not decide which is correct' };
    });

    const tally = EMPTY_TALLY();
    for (const r of rows) tally[r.category]++;

    // Skew is part of the honesty story ("timing explains many divergences"),
    // so an unparseable observedAt is a refusal, not a silent -1 sentinel that
    // still publishes. (Review R3.)
    const aT = Date.parse(aCensus.observedAt), bT = Date.parse(bCensus.observedAt);
    if (!Number.isFinite(aT) || !Number.isFinite(bT)) {
        throw new Error('[reconcile] a census has an unparseable observedAt — cannot compute skew, refusing');
    }
    const skew = Math.abs(aT - bT) / 1000;

    return {
        rows,
        reconciliation: {
            schema: RECONCILE_SCHEMA,
            reconciledAt,
            a: { observer: aCensus.observer, digest: digestOf(aCensus), size: aCensus.size, observedAt: aCensus.observedAt },
            b: { observer: bCensus.observer, digest: digestOf(bCensus), size: bCensus.size, observedAt: bCensus.observedAt },
            size: rows.length,
            rowsRoot: transcriptRoot(rows.map(rowLeaf)),
            tally,
            adjudication: 'none — two honest vantages may differ without either being wrong',
            observationSkewSeconds: Math.round(skew),
        },
    };
}

/** Prove ONE host's reconciliation row without disclosing either census. */
export function proveRow(rows: ReconcileRow[], index: number): {
    row: ReconcileRow; index: number; size: number; proof: string[];
} {
    const row = rows[index];
    if (!row) throw new Error(`index ${index} outside reconciliation of ${rows.length}`);
    return { row, index, size: rows.length, proof: inclusionProof(rows.map(rowLeaf), index) };
}

export function verifyRow(
    row: ReconcileRow, index: number, size: number, proof: string[], rowsRoot: string,
): boolean {
    return verifyInclusion(rowLeaf(row), index, size, proof, rowsRoot);
}

/** The digest a reconciliation is anchored under. */
export function reconciliationDigest(r: Reconciliation): string {
    assertJcsSafe(r);
    return 'sha256:' + createHash('sha256').update(jcsCanonical(r), 'utf8').digest('hex');
}
