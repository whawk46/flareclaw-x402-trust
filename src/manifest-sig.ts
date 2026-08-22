// GENERATED from src/x402/manifest-sig.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * x402sig1 — detached Ed25519 signature over the discovery manifest.
 *
 * Mirrors Martin Sansone's x402-signed-manifest-ref 1.1.0 construction
 * EXACTLY — Ed25519 over the RFC 8785 (JCS) canonical bytes DIRECTLY,
 * not over a prehash — because the verifiers that exist today
 * (Melchiorre's daily sweep, Martin's kit, our own magentix verify
 * scripts) all check that shape, and the point of signing is to be
 * counted by checkers we did not write. Field set matches his current
 * examples/well-known/x402.sig: v, canon, sig_input, alg, kid, sig,
 * content_digest, signedAt. `kid` is the FULL DNS name of the key
 * record (DKIM-selector style, e.g. s1._x402key.api.flareclaw.app),
 * so a verifier never guesses the lookup name.
 *
 * Extension over the reference: our manifest is LIVE-TRUTH — the
 * attestation block and freshness staple re-derive per request, so a
 * static committed .sig would go stale on the next staple rotation
 * (≤15 min). We therefore sign PER-SERVE: the .sig route builds the
 * same manifest body the main route would serve right now and signs
 * those bytes. The two fetches can still straddle a rotation; the
 * digest-agreement rule (report signature-invalid ONLY when the
 * verifier's own canonical sha256 of the manifest it fetched equals
 * this .sig's content_digest, otherwise undetermined) is what keeps
 * that race sound — content_digest says exactly which bytes were
 * signed.
 *
 * The signer is a MANIFEST IDENTITY: it holds no funds and can move no
 * money. Compromise of it can forge discovery manifests and nothing
 * else — same class as the receipt identity in job-receipt.ts, which
 * is why sign() is injected and this module never touches a key, a
 * network, or the clock.
 */

import { createHash, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from 'node:crypto';

export const MANIFEST_SIG_VERSION = 'x402sig1';
/** DKIM-style selector — the label the DNS TXT key record lives under. */
export const MANIFEST_SIG_SELECTOR = 's1';

export interface ManifestSig {
    v: typeof MANIFEST_SIG_VERSION;
    canon: 'RFC8785-JCS';
    sig_input: 'canonical-bytes';
    alg: 'Ed25519';
    /** Full DNS name of the TXT record carrying the verifying key. */
    kid: string;
    /** base64url Ed25519 signature over the canonical bytes. */
    sig: string;
    content_digest: { alg: 'SHA-256'; value: string };
    signedAt: string;
}

/**
 * Guard before claiming JCS parity: our jcs() below implements the
 * subset RFC 8785 needs for JSON built from strings, booleans, null,
 * safe integers, arrays and plain objects. Full ES6 number formatting
 * (fractions, exponents) is deliberately NOT implemented — a manifest
 * that needs it must not be signed with this module, loudly.
 */
export function assertJcsSafe(v: unknown): void {
    if (typeof v === 'string') {
        // A lone (unpaired) surrogate serializes differently across JCS
        // implementations — Node's JSON.stringify escapes it, some strict JCS
        // libraries reject or pass it through — so two honest verifiers can
        // compute DIFFERENT digests over the same logical value. Where the
        // string is attacker-influenced (a census detail/record derived from a
        // remote host response) that is a cross-implementation digest-
        // disagreement, so reject non-well-formed strings up front.
        if (typeof (v as { isWellFormed?: () => boolean }).isWellFormed === 'function'
            && !(v as unknown as string).isWellFormed()) {
            throw new Error('unsignable string: contains unpaired surrogate (not well-formed UTF-16)');
        }
        return;
    }
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
        if (!Number.isInteger(v) || Math.abs(v) > 2 ** 52) {
            throw new Error(`non-trivial number ${v}: full JCS ES6 formatting required`);
        }
        return;
    }
    if (typeof v !== 'object') throw new Error(`unsignable value of type ${typeof v}`);
    if (Array.isArray(v)) { v.forEach(assertJcsSafe); return; }
    Object.values(v as Record<string, unknown>).forEach(assertJcsSafe);
}

/** RFC 8785 JCS canonical form (subset guarded by assertJcsSafe). */
export function jcsCanonical(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(jcsCanonical).join(',')}]`;
    return `{${Object.keys(v as Record<string, unknown>).sort()
        .map(k => `${JSON.stringify(k)}:${jcsCanonical((v as Record<string, unknown>)[k])}`)
        .join(',')}}`;
}

/** The DNS name a manifest served for `host` binds its key to. */
export function manifestSigKid(host: string): string {
    return `${MANIFEST_SIG_SELECTOR}._x402key.${host}`;
}

export interface BuildManifestSigInput {
    manifest: unknown;
    kid: string;
    /** base64url Ed25519 signature over the given canonical bytes. */
    sign: (canonicalBytes: Buffer) => string;
    now: () => number;
}

export function buildManifestSig({ manifest, kid, sign, now }: BuildManifestSigInput): ManifestSig {
    assertJcsSafe(manifest);
    const bytes = Buffer.from(jcsCanonical(manifest), 'utf8');
    return {
        v: MANIFEST_SIG_VERSION,
        canon: 'RFC8785-JCS',
        sig_input: 'canonical-bytes',
        alg: 'Ed25519',
        kid,
        sig: sign(bytes),
        content_digest: {
            alg: 'SHA-256',
            value: createHash('sha256').update(bytes).digest('hex'),
        },
        signedAt: new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
}

/**
 * Independent check of a ManifestSig against a raw base64url Ed25519
 * public key (the exact string a verifier reads out of the DNS TXT
 * record's k= tag). Returns the digest-agreement verdict a sweep
 * should report: 'authentic' | 'signature-invalid' | 'undetermined'.
 * 'undetermined' means the manifest bytes in hand are not the bytes
 * the .sig commits to (the per-serve race, or a tampered pairing) —
 * per Melchiorre's rule that is NOT an accusation of a bad signature.
 */
export function verifyManifestSig(
    manifest: unknown, sig: ManifestSig, publicKeyB64url: string,
): 'authentic' | 'signature-invalid' | 'undetermined' {
    if (sig.v !== MANIFEST_SIG_VERSION || sig.canon !== 'RFC8785-JCS'
        || sig.sig_input !== 'canonical-bytes' || sig.alg !== 'Ed25519') {
        throw new Error('unexpected suite — refusing to guess at an unknown construction');
    }
    assertJcsSafe(manifest);
    const bytes = Buffer.from(jcsCanonical(manifest), 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== sig.content_digest.value) return 'undetermined';
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64url }, format: 'jwk' });
    return edVerify(null, bytes, key, Buffer.from(sig.sig, 'base64url'))
        ? 'authentic' : 'signature-invalid';
}

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed (RFC 8410 shape). */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface Ed25519Signer {
    /** base64url signature over the given bytes. */
    sign: (bytes: Buffer) => string;
    /** Raw 32-byte public key, base64url — the DNS TXT k= value. */
    publicKeyB64url: string;
}

/**
 * Build a signer from a base64url 32-byte Ed25519 seed (the secret's
 * stored form). The key object never leaves this closure; callers get
 * a sign function and the PUBLIC key only.
 */
export function ed25519SignerFromSeed(seedB64url: string): Ed25519Signer {
    const seed = Buffer.from(seedB64url.trim(), 'base64url');
    if (seed.length !== 32) throw new Error(`manifest signing seed must be 32 bytes, got ${seed.length}`);
    const privateKey = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
    });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('failed to derive public key from seed');
    return {
        sign: (bytes: Buffer) => edSign(null, bytes, privateKey).toString('base64url'),
        publicKeyB64url: jwk.x,
    };
}

/** The TXT record value verifiers parse (Martin's records.txt format). */
export function manifestSigTxtValue(publicKeyB64url: string): string {
    return `v=x402key1; alg=Ed25519; k=${publicKeyB64url}`;
}
