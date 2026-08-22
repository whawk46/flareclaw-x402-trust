// GENERATED from src/x402/directory-classify.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * directory-classify — the ONE place a raw DNS sweep row becomes a directory
 * verdict.
 *
 * WHY THIS IS ITS OWN MODULE. The classification was duplicated across
 * build-directory-census.ts and directory-lane.ts and had already DIVERGED:
 * the two produced different `detail` strings for the same host. Because
 * `detail` is committed inside the census Merkle leaf (attested-directory.ts
 * outputLeaf), that divergence meant the two scripts computed DIFFERENT census
 * digests over identical observations — a reproducibility defect in an
 * artifact whose entire value is that a third party can reproduce it. One
 * source of truth removes the class of bug, not just this instance.
 *
 * THE LOAD-BEARING RULE. A DNS-only method has NO evidence about host
 * reachability. NXDOMAIN on `_x402.<host>` means "no such record", not "host
 * down". So this classifier NEVER emits `unreachable`: that verdict belongs to
 * a method that actually probed the host (the fc-liveness lane), and emitting
 * it here would assert a host was offline on the strength of a missing TXT
 * record. A verdict vocabulary must be narrowed to the claims the method can
 * support; the `detail` strings say exactly which claim is being made.
 */
import type { DirectoryEntry } from './attested-directory.js';

/** One row of the DNS discovery sweep (scripts/x402/dns-discovery-sweep.mjs). */
export interface SweepRow {
    host: string;
    /** TXT strings at `_x402.<host>`, or null when the query returned nothing. */
    disc: string[] | null;
    /** TXT strings at `s1._x402key.<host>`, or null. */
    key: string[] | null;
}

/** A TXT answer with at least one non-blank string. `[]` and `[""]` are empty. */
export function hasContent(a: string[] | null): a is string[] {
    return Array.isArray(a) && a.some((t) => typeof t === 'string' && t.trim().length > 0);
}

/**
 * Classify one sweep row into a committed directory verdict.
 *
 * The returned `detail` is part of the census leaf, so it is treated as a
 * stable, canonical string — changing its wording changes every census digest
 * and is a deliberate, breaking act, not an editorial one.
 */
export function classifySweepRow(r: SweepRow): DirectoryEntry {
    // No usable discovery TXT: not discoverable. We distinguish "no record at
    // all" from "a record with no content" in the detail, because they are
    // different facts even though the verdict is the same.
    if (!hasContent(r.disc)) {
        return {
            domain: r.host,
            verdict: 'not-discoverable',
            detail: r.disc === null ? 'no _x402 TXT record (NXDOMAIN or no answer)' : 'empty _x402 TXT content',
        };
    }
    const rec = r.disc.find((t) => /v=x402/i.test(t));
    if (!rec) {
        return {
            domain: r.host,
            verdict: 'not-discoverable',
            detail: '_x402 TXT present but no v=x402 record among its strings',
        };
    }
    // A signing key published under the host is what upgrades "resolves" to
    // "checkable". Recorded as a distinct verdict rather than flattened.
    const signed = hasContent(r.key) && r.key.some((t) => /v=x402key1/i.test(t));
    return {
        domain: r.host,
        verdict: signed ? 'discoverable-verified' : 'discoverable',
        detail: signed
            ? 'record resolves; signing key published under the host'
            : 'record resolves; no signing key in DNS',
        record: rec,
    };
}

/**
 * Classify a whole sweep into a DETERMINISTIC, sorted entry list. Row order in
 * a census must not depend on how the sweep happened to finish, or two
 * observers who saw identical facts would still commit to different roots.
 */
export function classifySweep(rows: SweepRow[]): DirectoryEntry[] {
    return rows.map(classifySweepRow).sort((a, b) => (a.domain < b.domain ? -1 : 1));
}
