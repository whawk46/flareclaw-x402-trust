// GENERATED from src/x402/merkle-transcript.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * merkle-transcript — RFC 6962 Merkle commitments over a room's draw
 * transcript, so one draw can be proven without revealing the rest.
 *
 * WHY. A room's signed summary currently commits to its transcript FLAT:
 * sha256(JCS(all nonces)) and sha256(JCS(all seeds)). To prove that a single
 * draw was in the session you must therefore disclose EVERY draw. For a tenant
 * showing a third party "draw 7 happened, here is its seed", that is a
 * full-transcript disclosure to establish one fact.
 *
 * A Merkle root replaces that with an inclusion proof of ceil(log2(n)) hashes
 * that reveals nothing else, while the summary still commits to exactly one
 * value the enclave signs.
 *
 * WHY RFC 6962 RATHER THAN A TREE OF OUR OWN. Certificate Transparency's
 * Merkle Tree Hash is the transparency-log precedent this audience already
 * implements, it has published test vectors, and its two hardest details are
 * already decided in a way that has survived a decade of attack:
 *
 *   - DOMAIN SEPARATION. Leaves are hashed with a 0x00 prefix and interior
 *     nodes with 0x01. Without it an interior node's preimage can be presented
 *     as a leaf, so a proof for a value that was never in the tree verifies.
 *   - ODD NODES ARE PROMOTED, NEVER DUPLICATED. The split is at the largest
 *     power of two BELOW n, so a lone right-hand node carries up unchanged.
 *     Duplicating it instead is CVE-2012-2459: two distinct transcripts
 *     collapse to the same root, and a verifier cannot tell which it was
 *     shown.
 *
 * Both are exactly the class of underdetermined value that gets a profile
 * picked apart in review, so both are pinned by tests below rather than left
 * to the reader.
 *
 * LEAF CONTENT. A leaf commits to {drawId, nonce, seed} in JCS canonical form.
 * drawId is included deliberately: it is the payment-intent identity, and a
 * transcript whose leaves omit it cannot distinguish two draws that differ
 * only by intent — the same gap Tiago Pinto found in the SCITT draft's
 * execution digest (W3, 2026-08-18), where two distinct payments produced
 * identical digest inputs.
 */
import { createHash } from 'node:crypto';
import { jcsCanonical, assertJcsSafe } from './manifest-sig.js';

export const MERKLE_PROFILE = 'x402room-transcript-merkle/1';

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

/** RFC 6962 §2.1: MTH({}) = SHA-256 of the empty string. */
export const EMPTY_ROOT = sha256(Buffer.alloc(0)).toString('hex');

/** One transcript entry. drawId is part of the commitment, not metadata. */
export interface TranscriptEntry { drawId: string; nonce: string; seed: string }

/** RFC 6962 leaf hash: SHA-256(0x00 || entry). */
export function leafHash(entry: TranscriptEntry): Buffer {
    const canonical = { drawId: entry.drawId, nonce: entry.nonce, seed: entry.seed };
    assertJcsSafe(canonical);
    return sha256(Buffer.concat([Buffer.from([0x00]), Buffer.from(jcsCanonical(canonical), 'utf8')]));
}

/** RFC 6962 interior hash: SHA-256(0x01 || left || right). */
export function nodeHash(left: Buffer, right: Buffer): Buffer {
    return sha256(Buffer.concat([Buffer.from([0x01]), left, right]));
}

/** Largest power of two STRICTLY less than n — RFC 6962's split point. */
function splitPoint(n: number): number {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k;
}

/** Merkle Tree Hash over leaf hashes (RFC 6962 §2.1). */
function mth(leaves: Buffer[]): Buffer {
    if (leaves.length === 0) return sha256(Buffer.alloc(0));
    if (leaves.length === 1) return leaves[0]!;
    const k = splitPoint(leaves.length);
    return nodeHash(mth(leaves.slice(0, k)), mth(leaves.slice(k)));
}

/** The transcript root a signed summary commits to. */
export function transcriptRoot(entries: TranscriptEntry[]): string {
    return mth(entries.map(leafHash)).toString('hex');
}

/**
 * Merkle Tree Hash over ALREADY-hashed leaves — exposed so the RFC 6962
 * published vectors can be run through the MODULE's own tree (splitPoint + mth),
 * not a test-local lookalike. A regression in splitPoint would otherwise pass a
 * vector suite that only exercises a copy. (Crypto review M1.)
 */
export function mthOfLeafHashes(leafHashes: Buffer[]): string {
    return mth(leafHashes).toString('hex');
}

/**
 * Inclusion proof for entry `index` — the sibling hashes needed to recompute
 * the root, bottom-up. RFC 6962 §2.1.1 PATH(m, D[n]).
 */
export function inclusionProof(entries: TranscriptEntry[], index: number): string[] {
    if (index < 0 || index >= entries.length) throw new Error(`index ${index} outside transcript of ${entries.length}`);
    const path: Buffer[] = [];
    // RFC 6962 §2.1.1 appends the sibling AFTER the recursive call:
    //   PATH(m, D[n]) = PATH(m, D[0:k]) : MTH(D[k:n])
    // so the path is ordered BOTTOM-UP, deepest sibling first — which is the
    // order verification consumes it in. Pushing the sibling before recursing
    // yields a top-down path that verifies for no tree at all.
    const walk = (leaves: Buffer[], m: number): void => {
        if (leaves.length <= 1) return;
        const k = splitPoint(leaves.length);
        if (m < k) { walk(leaves.slice(0, k), m); path.push(mth(leaves.slice(k))); }
        else { walk(leaves.slice(k), m - k); path.push(mth(leaves.slice(0, k))); }
    };
    walk(entries.map(leafHash), index);
    return path.map((b) => b.toString('hex'));
}

/**
 * Verify one entry against a root WITHOUT the rest of the transcript. This is
 * the whole point: the verifier holds the entry, the proof, its index, the
 * transcript size, and the signed root — and nothing else.
 */
export function verifyInclusion(
    entry: TranscriptEntry, index: number, size: number, proof: string[], root: string,
): boolean {
    if (index < 0 || index >= size) return false;
    // RFC 6962 §2.1.1's OWN verification algorithm. An earlier version
    // re-split the tree top-down while consuming a bottom-up path, which
    // verifies for no tree at all: RFC 6962 trees are LEFT-FULL, not balanced,
    // so a node's side at each level is not recoverable by halving an index.
    // fn/sn track the leaf's index and the last index at each level, and it is
    // their parity — not arithmetic on the size — that says which side we are.
    let fn = index, sn = size - 1;
    let r = leafHash(entry);
    for (const p of proof) {
        // Canonical 64-lowercase-hex only. Buffer.from('hex') silently
        // truncates at the first invalid pair, so a 65-char string or 64 hex
        // chars followed by garbage would still decode to 32 bytes and verify —
        // proof-string malleability. (Crypto review M2.)
        if (!/^[0-9a-f]{64}$/.test(p)) return false;
        const sibling = Buffer.from(p, 'hex');
        if (sibling.length !== 32) return false;
        if (sn === 0) return false;                    // path longer than the tree
        if (fn % 2 === 1 || fn === sn) {
            r = nodeHash(sibling, r);
            while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
        } else {
            r = nodeHash(r, sibling);
        }
        fn >>= 1; sn >>= 1;
    }
    // sn must be exhausted: a SHORT path leaves tree levels unaccounted for,
    // and a padded one is rejected above by running out of levels first.
    return sn === 0 && r.toString('hex') === root;
}
