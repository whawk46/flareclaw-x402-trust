// GENERATED from src/x402/evidence-ref.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * Canonical evidence reference — `x402ev/1`.
 *
 * WHY THIS EXISTS (giskard09, x402-foundation/x402#3000, 2026-08-01):
 * our `attestations` spec amendment added `evidenceDigest` and
 * `evidenceAnchor` alongside `evidenceRef` — but said nothing about how
 * a REGISTRY CONTRACT carries them. Ours (`FCAttestationBadges`) has a
 * single `string evidenceRef` field, and so will most others: adding
 * typed columns means a redeploy and a new address, which breaks every
 * manifest already pointing at the registry. So the triple has to
 * survive inside one string, and it has to do so in a form two
 * independent implementations can compare BYTE FOR BYTE.
 *
 * Grammar (canonical form):
 *
 *   x402ev/1; digest=<alg>:<hex>[; anchor=<caip2>:<contract>:<record>][; ref=<uri>]
 *
 *   - `x402ev/1`  version tag; parsers reject unknown majors.
 *   - `digest=`   REQUIRED. Algorithm-prefixed so the format survives a
 *                 hash migration (crypto-agility, ledger §17a):
 *                 `sha256:<64 lowercase hex>` today.
 *   - `anchor=`   OPTIONAL. Where the digest is independently recorded:
 *                 CAIP-2 chain + contract + record id, e.g.
 *                 `eip155:114:0xb02f…29c5:6`. Omit when the registry
 *                 record CARRYING this string is itself the anchor —
 *                 a badge that contains the digest needs no second
 *                 witness, and claiming one would be noise.
 *   - `ref=`      OPTIONAL. Where a human or crawler can FETCH the
 *                 artifact. Rot is expected; the digest is the truth.
 *
 * Canonicalization (what makes byte comparison meaningful):
 *   fixed field order (digest, anchor, ref) · separator exactly "; " ·
 *   algorithm and hex lowercased · addresses lowercased (comparison
 *   beats EIP-55 vanity here) · no trailing separator. Parsers MUST
 *   accept fields in any order and MUST re-emit canonical order.
 *
 * Non-goal: this does not replace free-text context. Human notes belong
 * in the artifact the digest covers, not in the reference to it.
 */

/**
 * Canonical JSON for anything we digest (RFC 8785 / JCS subset).
 *
 * Lives here, next to the reference format, because the digest is only
 * meaningful if two implementations serialize the SAME artifact to the
 * SAME bytes. Every place we hash an evidence artifact MUST use this —
 * a second, subtly different canonicalizer is how digests silently stop
 * matching.
 *
 * Rules: object keys sorted, no insignificant whitespace, arrays keep
 * their order (order is semantic in JSON), primitives via JSON.stringify.
 *
 * This is not "JCS-ish" — it is RFC 8785, and we test it as such.
 * RFC 8785 is *defined* in ECMAScript terms, which is why so little code
 * is needed here: JS sorts strings by UTF-16 code unit (what JCS
 * mandates), and `JSON.stringify` already implements JCS number
 * formatting (Number::toString) and minimal string escaping. Verified
 * against the RFC author's own vectors — arrays, french, structures,
 * unicode, values, weird — byte-for-byte, vendored in
 * `tests/x402/vectors/jcs/` so it cannot silently regress.
 *
 * One honest boundary: RFC 8785 canonicalizes PARSED JSON data, so
 * information lost at parse time (duplicate keys, the original text of
 * a number like `1.0`) is out of scope by design, not by omission.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface EvidenceRef {
    /** Hash algorithm, lowercase. `sha256` today. */
    alg: string;
    /** Digest of the evidence artifact, lowercase hex, no 0x. */
    hex: string;
    /** Optional independent record of the digest. */
    anchor?: {
        /** CAIP-2 chain id, e.g. `eip155:114`. */
        chain: string;
        /** Contract holding the anchor record, lowercase hex with 0x. */
        contract: string;
        /** Record identifier within that contract (token id, index, …). */
        record: string;
    };
    /** Optional fetchable location of the artifact. */
    ref?: string;
}

export const EVIDENCE_REF_VERSION = 'x402ev/1';

const SEP = '; ';
const HEX_BY_ALG: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };

/** Canonical string for on-chain storage and byte-level comparison. */
export function encodeEvidenceRef(e: EvidenceRef): string {
    const alg = e.alg.toLowerCase();
    const hex = e.hex.toLowerCase().replace(/^0x/, '');
    const expected = HEX_BY_ALG[alg];
    if (!expected) throw new Error(`unsupported digest algorithm: ${e.alg}`);
    if (!new RegExp(`^[0-9a-f]{${expected}}$`).test(hex)) {
        throw new Error(`${alg} digest must be ${expected} lowercase hex chars`);
    }
    const parts = [EVIDENCE_REF_VERSION, `digest=${alg}:${hex}`];
    if (e.anchor) {
        // Normalize FIRST, then validate — callers legitimately pass
        // EIP-55 checksummed addresses and mixed-case CAIP namespaces.
        const chain = e.anchor.chain.toLowerCase();
        const contract = e.anchor.contract.toLowerCase();
        const record = e.anchor.record;
        if (!/^[-a-z0-9]+:[-_a-z0-9]+$/.test(chain)) throw new Error(`anchor chain must be CAIP-2, got: ${e.anchor.chain}`);
        if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error(`anchor contract must be a 20-byte hex address`);
        if (!/^[0-9a-zA-Z._-]+$/.test(record)) throw new Error(`anchor record has illegal characters`);
        parts.push(`anchor=${chain}:${contract}:${record}`);
    }
    if (e.ref) {
        // URIs are case-sensitive and must survive verbatim; only the
        // separator is forbidden inside them.
        if (e.ref.includes(SEP)) throw new Error('ref must not contain "; "');
        parts.push(`ref=${e.ref}`);
    }
    return parts.join(SEP);
}

/** Parse a canonical (or field-reordered) reference. Returns null if it is not one. */
export function parseEvidenceRef(s: string): EvidenceRef | null {
    const parts = s.split(SEP).map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const version = parts[0]!;
    if (!version.startsWith('x402ev/')) return null;
    if (version.split('/')[1]?.split('.')[0] !== '1') return null; // unknown major

    let digest: { alg: string; hex: string } | undefined;
    let anchor: EvidenceRef['anchor'];
    let ref: string | undefined;

    for (const part of parts.slice(1)) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.slice(0, eq);
        const value = part.slice(eq + 1);
        if (key === 'digest') {
            const colon = value.indexOf(':');
            if (colon < 0) return null;
            const alg = value.slice(0, colon).toLowerCase();
            const hex = value.slice(colon + 1).toLowerCase();
            const expected = HEX_BY_ALG[alg];
            if (!expected || !new RegExp(`^[0-9a-f]{${expected}}$`).test(hex)) return null;
            digest = { alg, hex };
        } else if (key === 'anchor') {
            // chain is CAIP-2 (`namespace:reference`), so split from the right.
            const bits = value.split(':');
            if (bits.length < 4) return null;
            const record = bits.pop()!;
            const contract = bits.pop()!;
            anchor = { chain: bits.join(':').toLowerCase(), contract: contract.toLowerCase(), record };
        } else if (key === 'ref') {
            ref = value;
        }
        // Unknown keys are ignored — forward compatibility.
    }
    if (!digest) return null;
    return { alg: digest.alg, hex: digest.hex, ...(anchor ? { anchor } : {}), ...(ref ? { ref } : {}) };
}

/**
 * True when two references describe the same evidence. Compares the
 * canonical DIGEST, never the ref — a moved artifact is still the same
 * evidence, and a rewritten artifact at the same URL is not.
 */
export function sameEvidence(a: string, b: string): boolean {
    const pa = parseEvidenceRef(a);
    const pb = parseEvidenceRef(b);
    if (!pa || !pb) return false;
    return pa.alg === pb.alg && pa.hex === pb.hex;
}

/** Round-trip a reference into canonical byte form (idempotent). */
export function canonicalizeEvidenceRef(s: string): string | null {
    const parsed = parseEvidenceRef(s);
    return parsed ? encodeEvidenceRef(parsed) : null;
}
