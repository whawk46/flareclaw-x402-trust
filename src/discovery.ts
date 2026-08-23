// GENERATED from src/x402/discovery.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * x402 `discovery` extension — reference implementation.
 *
 * Spec: docs/plans/x402/x402-discovery-extension-spec.md (draft for
 * x402-foundation). Two mechanisms:
 *   1. `/.well-known/x402` HTTPS manifest (authoritative capability record)
 *   2. `_x402.<domain>` DNS TXT pointer (`v=x402-1; wk=<manifest url>; …`)
 *
 * This module is pure protocol logic (parse/validate/build) plus a resolver
 * that composes DNS + fetch per the spec's resolution algorithm. The public
 * facilitator serves the manifest; anyone can resolve it with resolveX402().
 */

// ──────────────────── Types ────────────────────

export type DiscoveryKind = 'facilitator' | 'resource-server' | 'both';

export interface SupportedKind {
    x402Version: number;
    scheme: string;
    network: string;
}

export interface DiscoveryAsset {
    network: string;
    address: string;
    symbol?: string;
    decimals?: number;
    standard?: string;
}

export interface DiscoveryManifest {
    x402Version: number;
    kind: DiscoveryKind;
    name?: string;
    description?: string;
    facilitator?: {
        baseUrl: string;
        endpoints: { supported: string; verify: string; settle: string };
        kinds: SupportedKind[];
        assets?: DiscoveryAsset[];
    };
    resources?: { url: string; method?: string; description?: string }[];
    /** Peer hints: bare domain names of other discovery publishers. Hints only — see sanitizePeers. */
    peers?: string[];
    attestation?: { type: string; [k: string]: unknown };
    docs?: string;
    contact?: string;
    updated?: string;
}

export interface X402TxtRecord {
    v: string;
    wk: string;
    k?: DiscoveryKind;
    net?: string[];
    scheme?: string[];
}

// ──────────────────── TXT record grammar ────────────────────

const TXT_VERSION = 'x402-1';

/**
 * Parse a `_x402.<domain>` TXT record ("v=x402-1; wk=https://…; k=…").
 * Returns null for records that aren't x402-1 (callers skip them).
 * Throws on records that claim x402-1 but are malformed.
 */
/**
 * A HARD discovery violation — a record or redirect that is present but
 * malformed or spoofing (missing/HTTP wk, invalid k, duplicate key/record,
 * out-of-domain or downgraded redirect). Distinguished by TYPE, not by message
 * text, so classification cannot be fooled by attacker-controlled strings (a
 * wk URL containing the word "conflicting") and cannot silently swallow a
 * malformed record as a DNS miss. These cache as `invalid`; DNS misses do not.
 */
export class DiscoveryViolation extends Error {}

export function parseX402TxtRecord(txt: string): X402TxtRecord | null {
    const fields = new Map<string, string>();
    for (const part of txt.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        // A repeated key inside one record is malformed. "Last wins" (Map.set)
        // is silent and DIVERGENT: another conformant implementation could take
        // the first, and the two resolve to different manifests with no way to
        // detect it — the same hazard the duplicate-RECORD rule refuses, one
        // level down. Only meaningful once we know it's an x402 record, so the
        // throw is deferred until after the v= check. (Review F6.)
        if (fields.has(key)) {
            fields.set('__dupkey', key);   // remember, decide after v= gate
        } else {
            fields.set(key, trimmed.slice(eq + 1).trim());
        }
    }
    // Version token is matched case-sensitively (the token defines the format
    // version); records that don't declare THIS version are skipped, not an
    // error, so a future version's record does not fail an old resolver.
    if (fields.get('v') !== TXT_VERSION) return null;
    const dup = fields.get('__dupkey');
    if (dup) throw new DiscoveryViolation(`[x402-discovery] duplicate key "${dup}" in one TXT record — ambiguous, refusing`);
    const wk = fields.get('wk');
    if (!wk) throw new DiscoveryViolation('[x402-discovery] TXT record missing wk=<manifest url>');
    if (!wk.startsWith('https://')) throw new DiscoveryViolation(`[x402-discovery] wk must be HTTPS: ${wk}`);
    const k = fields.get('k');
    if (k && !['facilitator', 'resource-server', 'both'].includes(k)) {
        throw new DiscoveryViolation(`[x402-discovery] invalid k=${k}`);
    }
    return {
        v: TXT_VERSION,
        wk,
        ...(k ? { k: k as DiscoveryKind } : {}),
        ...(fields.has('net') ? { net: fields.get('net')!.split(',').map(s => s.trim()).filter(Boolean) } : {}),
        ...(fields.has('scheme') ? { scheme: fields.get('scheme')!.split(',').map(s => s.trim()).filter(Boolean) } : {}),
    };
}

/**
 * What a `_x402` TXT record IS, when it isn't ours.
 *
 * WHY THIS EXISTS. A census of the Bazaar catalog on 2026-08-22 found five
 * hosts publishing a TXT record at `_x402` under a grammar that is not this
 * one, in three mutually incompatible syntaxes:
 *
 *   v=x4021;descriptor=api;url=https://api.telemost.io/.well-known/x402
 *   v=x4021;url=https://tablint.dev/.well-known/x402
 *   x402-manifest=https://vibesprings.net/.well-known/x402.json
 *   https://api.auor.io/.well-known/x402                    (bare URL, no key)
 *
 * Every one of them points at its own domain, so this is not an attack — it is
 * independent convergence on the same design. Two of them differ from a
 * conformant record by exactly two tokens.
 *
 * `parseX402TxtRecord` returns null for all of them, which is correct as a GATE
 * and useless as a DIAGNOSIS: a resolver that silently skips a near-miss makes
 * the publisher invisible and tells nobody they were one character away. The
 * fragmentation risk to `_x402` is not that someone attacks the name, it is
 * that several people spell it differently and no implementation ever says so.
 *
 * So: strict enforcement, generous diagnostics — the same doctrine
 * `diagnoseManifest` applies one layer up. THE GATE IS UNCHANGED.
 */
export type TxtDiagnosis =
    | { kind: 'conformant'; record: X402TxtRecord }
    /** Claims x402-1 and breaks the grammar. */
    | { kind: 'malformed'; message: string }
    /** Not conformant, but recognizably an attempt at this record. */
    | { kind: 'near-miss'; hints: string[]; manifestUrl?: string }
    /** A TXT record at this name that is not about x402 at all. */
    | { kind: 'foreign' };

/** Keys observed in the wild carrying the manifest URL under another name. */
const NEAR_MISS_URL_KEYS = ['url', 'manifest', 'x402-manifest', 'wk', 'href', 'uri'];

export function diagnoseX402TxtRecord(txt: string): TxtDiagnosis {
    try {
        const rec = parseX402TxtRecord(txt);
        if (rec) return { kind: 'conformant', record: rec };
    } catch (e) {
        if (e instanceof DiscoveryViolation) return { kind: 'malformed', message: e.message };
        throw e;
    }

    const raw = txt.trim();
    const hints: string[] = [];
    let manifestUrl: string | undefined;

    // Shape 1: a bare https URL with no key at all.
    if (/^https:\/\/\S+$/i.test(raw)) {
        manifestUrl = raw;
        hints.push('record is a bare URL; the grammar is `v=x402-1; wk=<url>`');
        return { kind: 'near-miss', hints, manifestUrl };
    }

    const fields = new Map<string, string>();
    for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
    }

    // Shape 2: a version token that only differs by punctuation or case.
    const v = fields.get('v');
    if (v && v !== TXT_VERSION && v.toLowerCase().replace(/[-_.\s]/g, '') === TXT_VERSION.replace(/-/g, '')) {
        hints.push(`version token is "${v}"; it must be exactly "${TXT_VERSION}"`);
    }

    // Shape 3: the manifest URL present under a key other than wk=.
    for (const k of NEAR_MISS_URL_KEYS) {
        const val = fields.get(k);
        if (k !== 'wk' && val && /^https:\/\//i.test(val)) {
            manifestUrl = val;
            hints.push(`manifest URL is carried in "${k}="; the grammar names it "wk="`);
            break;
        }
    }

    if (hints.length === 0) return { kind: 'foreign' };
    return { kind: 'near-miss', hints, ...(manifestUrl ? { manifestUrl } : {}) };
}

/** Render the TXT record value for a manifest URL (for operators with DNS). */
export function buildX402TxtRecord(p: {
    manifestUrl: string; kind?: DiscoveryKind; networks?: string[]; schemes?: string[];
}): string {
    const parts = [`v=${TXT_VERSION}`, `wk=${p.manifestUrl}`];
    if (p.kind) parts.push(`k=${p.kind}`);
    if (p.networks?.length) parts.push(`net=${p.networks.join(',')}`);
    if (p.schemes?.length) parts.push(`scheme=${p.schemes.join(',')}`);
    return parts.join('; ');
}

/**
 * Spec security rule: the wk URL must live on the queried domain or a
 * subdomain of it — a TXT record may not claim another operator's manifest.
 */
/**
 * A facilitator endpoint value that is safe to concatenate onto baseUrl and
 * fetch: a rooted relative path only. A leading single "/" makes authority
 * injection impossible (nothing after "/" reaches the authority component), and
 * "@", "://", "//" and whitespace/backslash are refused outright. This is the
 * SYNTACTIC guard; isWkInDomain on the assembled URL is the semantic backstop.
 */
export function isSafeRelativePath(p: unknown): boolean {
    return typeof p === 'string'
        && p.startsWith('/') && !p.startsWith('//')
        && !p.includes('@') && !p.includes('://')
        && !/[\s\\]/.test(p);
}

/**
 * Normalize a DNS name to the form a comparison can be made in: A-labels,
 * lowercase, no trailing dot.
 *
 * BOTH SIDES OF THE COMPARISON GO THROUGH THIS, and that is the whole point.
 * The previous version lowercased both sides but normalized only one of the
 * other two axes on each, which made the rule ASYMMETRIC in two places:
 *
 *     manifest host `api.example.com.`  vs domain `api.example.com`   → false
 *     domain        `api.example.com.`  vs host   `api.example.com`   → true
 *     manifest host `xn--bcher-kva.de`  vs domain `bücher.de`         → false
 *     domain        `xn--bcher-kva.de`  vs host   `bücher.de`         → true
 *
 * The trailing dot is the same name in the DNS and a U-label is the same name
 * as its A-label, so all four of those are one name compared with itself. Both
 * false answers FAIL CLOSED into "the wk= is out of domain", which drops a
 * conforming publisher out of discovery silently — the direction that costs the
 * publisher and never the crawler, so nobody complains and nothing is logged.
 *
 * Found by @Circadian-agent on x402-foundation/x402#2979 as an underspecified
 * comparison in the extension text; it was also a live defect in this
 * implementation, in both of the directions they named.
 *
 * The WHATWG URL parser does the A-label conversion, so this module keeps its
 * zero-import property: there is no second normalizer to disagree with the one
 * already used on the manifest side.
 */
function normalizeDnsName(name: string): string | null {
    // A bare DNS name only. Anything that could carry authority or a path is
    // rejected rather than parsed, so a caller passing a URL by mistake cannot
    // have its hostname silently extracted and compared.
    if (typeof name !== 'string' || name === '' || /[\/?#@:\\\s]/.test(name)) return null;
    try {
        return new URL(`https://${name}`).hostname.toLowerCase().replace(/\.$/, '') || null;
    } catch {
        return null;
    }
}

export function isWkInDomain(wkUrl: string, domain: string): boolean {
    try {
        const host = new URL(wkUrl).hostname.toLowerCase().replace(/\.$/, '');
        const d = normalizeDnsName(domain);
        if (!host || !d) return false;
        return host === d || host.endsWith(`.${d}`);
    } catch {
        return false;
    }
}

// ──────────────────── Which name do you ask? ────────────────────
//
// THE AMBIGUITY, AND HOW WE FOUND IT. The spec says the record lives at
// `_x402.<domain>` and never says which domain a consumer holding a RESOURCE
// URL should ask for. A census of 1,609 hosts on 2026-08-22 asked
// `_x402.<exact-host>` and recorded the draft's own author as a non-publisher:
// our record is at the apex `flareclaw.app` with `wk=` pointing at the
// subdomain `api.flareclaw.app`. Publishing at the apex is the natural choice
// for an operator with one DNS zone and several service hosts, and the naive
// reading makes them invisible.
//
// So a consumer must be allowed to walk up. That immediately creates a worse
// problem: on shared hosting (`*.workers.dev`, `*.up.railway.app`) the ancestor
// belongs to the PLATFORM, not the tenant, and one record there would make
// every tenant beneath it discoverable — including tenants who never published
// anything, and including hosts that do not exist. Our own control demonstrates
// it: `zzq-...-9931.flareclaw.app` inherits our apex record.
//
// A public-suffix list would answer "is this ancestor an operator or a
// platform", and we deliberately do NOT use one: it is a mutable external
// dependency, it disagrees with reality on private suffixes, and being wrong
// silently converts into false adoption claims.
//
// THE RULE INSTEAD — the ancestor must NAME the host. An ancestor's manifest
// speaks for a descendant only if the manifest itself references that host, in
// `facilitator.baseUrl` or in `resources[]`. That is a positive statement by
// the party who controls the zone, it needs no external list, and it closes
// the shared-hosting hole exactly: `workers.dev` publishing a record does not
// make tenant X discoverable unless the record's manifest names tenant X.

/** How far up a consumer may walk. Two ancestors, never below two labels. */
export const MAX_ANCESTOR_STEPS = 2;

/**
 * The `_x402` owner names to query for a host, nearest first.
 *
 * The FIRST entry is the host itself and is always authoritative for it. Later
 * entries are ancestors, and a record found at one is only usable if
 * `manifestCoversHost` accepts it.
 */
export function discoveryNamesFor(hostOrUrl: string): string[] {
    let host = hostOrUrl.trim().toLowerCase();
    if (host.includes('://')) {
        try { host = new URL(host).hostname.toLowerCase(); } catch { return []; }
    }
    host = host.replace(/\.$/, '').replace(/:\d+$/, '');
    if (!host || host.startsWith('.') || host.includes('/') || host.includes(' ')) return [];

    // AN ADDRESS LITERAL HAS NO NAME TO PUBLISH UNDER, so it gets no names at
    // all — not even itself. The dots in an IPv4 address are not delegation:
    // without this guard the walk asks for `_x402.0.0.1` and `_x402.0.1`, which
    // are strangers' zones, and `isWkInDomain(wk, '0.1')` would then accept
    // whatever was found there as speaking for 127.0.0.1. Found 2026-08-22
    // wiring this resolver into a suite whose mock target is a loopback literal.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')) return [];

    const labels = host.split('.');
    if (labels.length < 2 || labels.some(l => l === '')) return [host].filter(Boolean);
    const names = [host];
    for (let i = 1; i <= MAX_ANCESTOR_STEPS && labels.length - i >= 2; i++) {
        names.push(labels.slice(i).join('.'));
    }
    return names;
}

/**
 * Does a manifest published at `ownerName` speak for `host`?
 *
 * Always true when the manifest was found at the host itself. For an ancestor,
 * the manifest MUST name the host — otherwise a platform's record would vouch
 * for every tenant under it, which is how a discovery layer manufactures
 * adopters it does not have.
 *
 * Referenced URLs are only counted when they are themselves in-domain of the
 * owner, so a manifest cannot vouch for a host it does not control either.
 */
export function manifestCoversHost(m: unknown, ownerName: string, host: string): boolean {
    const owner = ownerName.toLowerCase().replace(/\.$/, '');
    const target = host.toLowerCase().replace(/\.$/, '');
    if (owner === target) return true;                       // found at the host itself
    if (!(target === owner || target.endsWith(`.${owner}`))) return false;  // not even below it
    if (typeof m !== 'object' || m === null) return false;

    const man = m as Record<string, any>;
    const hostOf = (u: unknown): string | null => {
        if (typeof u !== 'string') return null;
        try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
    };
    const named: string[] = [];
    const base = hostOf(man.facilitator?.baseUrl);
    if (base) named.push(base);
    if (Array.isArray(man.resources)) {
        for (const r of man.resources) {
            const h = hostOf(typeof r === 'string' ? r : r?.url ?? r?.resource);
            if (h) named.push(h);
        }
    }
    // A named host only counts if the OWNER could legitimately speak for it.
    return named.some(n => n === target && (n === owner || n.endsWith(`.${owner}`)));
}

// ──────────────────── Manifest validation ────────────────────

/**
 * One structural violation, classified by WHO introduced the requirement.
 *
 * The distinction is the point. A host that fails only on `introducedBy:
 * 'x402-discovery'` is one mechanical edit from compliant; a host failing a
 * 'core' rule has a different problem. Reporting them identically is what
 * makes adoption look like a wall instead of an afternoon.
 */
export interface ManifestViolation {
    field: string;
    message: string;
    introducedBy: 'x402-discovery' | 'core';
}

/**
 * Collect EVERY structural violation instead of stopping at the first.
 *
 * Why this exists (Melchiorre Oliva on PR #2979, 2026-08-18): our resolver
 * refused his manifest with `invalid kind: undefined` and read nothing else.
 * Everything else in the record was valid, but a first-throw validator cannot
 * say so — the operator learns one field per debugging round-trip and has no
 * way to tell "one edit away" from "fundamentally wrong". He measured 383
 * hosts (39.5% of those serving a manifest) violating nothing except fields
 * this extension introduces. That population is invisible unless a resolver
 * reports the whole diagnosis and says which requirements are new.
 *
 * The GATE ITSELF IS UNCHANGED: resolveX402 still refuses a manifest that
 * fails any rule. Strict enforcement, generous diagnostics.
 */
export function diagnoseManifest(m: unknown): { ok: boolean; violations: ManifestViolation[] } {
    const v: ManifestViolation[] = [];
    if (typeof m !== 'object' || m === null) {
        return { ok: false, violations: [{ field: '(root)', message: 'manifest is not an object', introducedBy: 'core' }] };
    }
    const man = m as Record<string, any>;

    if (typeof man.x402Version !== 'number') {
        v.push({ field: 'x402Version', message: 'missing x402Version', introducedBy: 'core' });
    }
    if (!['facilitator', 'resource-server', 'both'].includes(man.kind)) {
        v.push({
            field: 'kind',
            message: man.kind === undefined
                ? 'missing kind — REQUIRED by this extension; add "facilitator", "resource-server" or "both"'
                : `invalid kind: ${JSON.stringify(man.kind)}`,
            introducedBy: 'x402-discovery',
        });
    }
    if (man.kind === 'facilitator' || man.kind === 'both') {
        const f = man.facilitator;
        if (!f) {
            v.push({ field: 'facilitator', message: 'kind includes facilitator but facilitator block missing', introducedBy: 'x402-discovery' });
        } else {
            if (typeof f.baseUrl !== 'string' || !f.baseUrl.startsWith('https://')) {
                v.push({ field: 'facilitator.baseUrl', message: 'facilitator.baseUrl must be HTTPS', introducedBy: 'x402-discovery' });
            }
            for (const ep of ['supported', 'verify', 'settle']) {
                const val = f.endpoints?.[ep];
                if (typeof val !== 'string') {
                    v.push({ field: `facilitator.endpoints.${ep}`, message: `facilitator.endpoints.${ep} missing`, introducedBy: 'x402-discovery' });
                } else if (!isSafeRelativePath(val)) {
                    // An endpoint is concatenated onto baseUrl and fetched. If
                    // it can inject authority (`@victim.com/x`, `.victim.com/x`,
                    // `//victim.com/x`, an absolute `https://victim/x`), it aims
                    // a conforming crawler at a third party — the amplification
                    // the same-origin rule exists to stop, moved from baseUrl to
                    // the endpoints. Require a plain rooted path. (Review F1.)
                    v.push({ field: `facilitator.endpoints.${ep}`, message: `facilitator.endpoints.${ep} must be a rooted relative path (leading "/", no scheme/authority)`, introducedBy: 'x402-discovery' });
                }
            }
            if (!Array.isArray(f.kinds) || f.kinds.length === 0) {
                v.push({ field: 'facilitator.kinds', message: 'facilitator.kinds must be a non-empty array', introducedBy: 'x402-discovery' });
            } else {
                for (const k of f.kinds) {
                    if (typeof k?.scheme !== 'string' || typeof k?.network !== 'string') {
                        v.push({ field: 'facilitator.kinds[]', message: 'each kind needs {scheme, network}', introducedBy: 'x402-discovery' });
                        break;
                    }
                }
            }
        }
    }
    return { ok: v.length === 0, violations: v };
}

/**
 * True when a manifest's ONLY problems are requirements this extension
 * introduced — i.e. it was a valid x402 manifest before this spec and is one
 * mechanical edit from valid after it. This is the population worth counting
 * when anyone asks what the extension costs deployed hosts.
 */
export function isOneEditAway(m: unknown): boolean {
    const d = diagnoseManifest(m);
    return !d.ok && d.violations.every(x => x.introducedBy === 'x402-discovery');
}

/** Structural validation per the spec. Throws with a reason on failure. */
export function validateManifest(m: unknown): DiscoveryManifest {
    const d = diagnoseManifest(m);
    if (!d.ok) {
        // Report ALL of it, and say when the record was valid before this
        // extension existed — one debugging round-trip instead of one per
        // field, and the operator can tell a small edit from a real problem.
        const all = d.violations.map(x => `${x.field}: ${x.message}`).join('; ');
        const hint = d.violations.every(x => x.introducedBy === 'x402-discovery')
            ? ' — all violations are fields THIS extension introduces; the manifest was otherwise valid'
            : '';
        throw new Error(`[x402-discovery] ${all}${hint}`);
    }
    return m as DiscoveryManifest;
}

// ──────────────────── Peer hints ────────────────────
//
// Peers are hints, not vouchers: each surviving entry is only a name to
// feed back into resolveX402() from the beginning, with every check in
// this module applied unchanged. Nothing transfers from the referring
// manifest, which is why an attacker-writable list is safe to consume —
// provided the consumer enforces the cap and the bare-name grammar
// below instead of dereferencing whatever it is handed.

/** Spec cap: entries beyond this are ignored (and worth flagging). */
export const MAX_PEER_HINTS = 32;

const BARE_DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Filter a manifest's `peers` array down to entries a consumer may act on:
 * bare multi-label DNS names — no scheme, path, port, or userinfo, no IP
 * literals, not the manifest's own domain — capped at MAX_PEER_HINTS.
 * Everything dropped is returned as a signal, mirroring droppedResources.
 */
export function sanitizePeers(raw: unknown, ownDomain: string): { peers: string[]; dropped: string[] } {
    if (!Array.isArray(raw)) return { peers: [], dropped: [] };
    const own = ownDomain.toLowerCase().replace(/\.$/, '');
    const peers: string[] = [];
    const dropped: string[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const name = entry.trim().toLowerCase().replace(/\.$/, '');
        const isIpV4 = /^[\d.]+$/.test(name);
        if (!BARE_DNS_NAME.test(name) || isIpV4 || name.includes(':') || name === own) {
            dropped.push(entry);
            continue;
        }
        if (seen.has(name)) continue;
        seen.add(name);
        if (peers.length >= MAX_PEER_HINTS) { dropped.push(entry); continue; }
        peers.push(name);
    }
    return { peers, dropped };
}

// ──────────────────── Resolution algorithm ────────────────────

/** Bounded so a redirect loop can't spin a crawler. */
const MAX_MANIFEST_REDIRECTS = 3;
/** A manifest is a small JSON document. Anything larger is an attack. */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MANIFEST_TIMEOUT_MS = 10_000;

// ── Resolved-address guard ──
//
// HTTPS-only plus the in-domain rule is NOT enough to stop a crawler
// being aimed inside its own network: the publisher controls their own
// DNS, so an in-domain hostname can resolve to 10.0.0.5 or
// 169.254.169.254, and a DNS-01 ACME challenge issues a perfectly valid
// certificate for a name that never points anywhere public. TLS then
// fails against the internal victim, but the crawler has still made the
// connection — a connect/port-probe primitive handed to anyone who can
// publish a TXT record. So: resolve first, refuse private destinations.

/** True for addresses no discovery fetch should ever connect to:
 *  loopback, link-local, RFC1918/ULA private ranges, unspecified. */
export function isPrivateAddress(ip: string): boolean {
    const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 0 || a === 10 || a === 127
            || (a === 100 && b >= 64 && b <= 127)          // CGNAT
            || (a === 169 && b === 254)                     // link-local (cloud metadata)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168);
    }
    const v6 = ip.toLowerCase();
    return v6 === '::' || v6 === '::1'
        || v6.startsWith('fe80:')                           // link-local
        || v6.startsWith('fc') || v6.startsWith('fd');      // ULA fc00::/7
}

export type LookupImpl = (hostname: string) => Promise<string[]>;

/**
 * Reject a URL whose host is, or resolves to, a private address. Checked
 * before EVERY fetch, including each redirect hop — a public first hop
 * redirecting to an internal name is the classic bypass. (DNS rebinding
 * between this check and the connect remains possible; this is the
 * standard mitigation, not a sandbox — pin resolution if you need more.)
 */
async function assertPublicDestination(url: string, lookup: LookupImpl): Promise<void> {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    // Literal IP: judge it directly.
    if (/^[\d.]+$/.test(host) || host.includes(':')) {
        if (isPrivateAddress(host)) {
            throw new Error(`[x402-discovery] refusing private destination ${host} (${url})`);
        }
        return;
    }
    const addrs = await lookup(host);
    if (addrs.length === 0) throw new Error(`[x402-discovery] ${host} resolved to no addresses`);
    const bad = addrs.find(isPrivateAddress);
    if (bad) {
        throw new Error(`[x402-discovery] refusing ${host}: resolves to private address ${bad} (${url})`);
    }
}

async function defaultLookup(hostname: string): Promise<string[]> {
    const dns = await import('dns');
    const results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return results.map(r => r.address);
}

/**
 * Fetch a manifest with a deadline and a size cap.
 *
 * Neither existed before: a hostile host could serve a multi-gigabyte
 * body, or trickle bytes forever, and every conforming crawler would
 * hang or exhaust memory. Discovery is designed to be crawled by
 * strangers, so an unbounded read is a denial-of-service handed to
 * anyone who publishes a TXT record.
 */
async function fetchBounded(url: string, fetchImpl: typeof fetch): Promise<{ res: Response; body: unknown }> {
    const res = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) return { res, body: undefined };
    if (!res.ok) return { res, body: undefined };

    const declaredHdr = res.headers?.get?.('content-length');
    const declared = declaredHdr != null ? Number(declaredHdr) : NaN;
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
        throw new DiscoveryViolation(`[x402-discovery] manifest too large: ${declared} bytes (cap ${MAX_MANIFEST_BYTES})`);
    }
    // STREAM and abort mid-body the moment the cap is exceeded. res.text() and
    // res.json() both buffer the WHOLE body into memory first, so a host that
    // omits Content-Length (the check above is then skipped) could push
    // gigabytes before any length test fires — a memory-exhaustion DoS handed
    // to every conforming crawler. The 10s timeout caps duration, not peak
    // memory. (Adversarial F2 / silent-failure 1d.)
    const reader = (res as Response).body?.getReader?.();
    if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_MANIFEST_BYTES) {
                await reader.cancel().catch(() => { /* best effort */ });
                throw new DiscoveryViolation(`[x402-discovery] manifest exceeded ${MAX_MANIFEST_BYTES} bytes mid-stream`);
            }
            chunks.push(value);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        return { res, body: JSON.parse(raw) };
    }
    // No stream reader (an injected test fetch): text() still caps by measured
    // length. REFUSE the json() fallback — an unbounded read would silently
    // disable the one control this function exists to provide.
    if (typeof (res as Response).text === 'function') {
        const raw = await res.text();
        if (raw.length > MAX_MANIFEST_BYTES) {
            throw new DiscoveryViolation(`[x402-discovery] manifest exceeded ${MAX_MANIFEST_BYTES} bytes`);
        }
        return { res, body: JSON.parse(raw) };
    }
    throw new Error('[x402-discovery] response exposes neither body stream nor text() — cannot bound the read, refusing');
}

export interface ResolveResult {
    manifest: DiscoveryManifest;
    manifestUrl: string;
    via: 'dns-txt' | 'well-known';
    txtRecord?: X402TxtRecord;
    /** Live GET {baseUrl}{endpoints.supported} result (authoritative over manifest kinds). */
    liveKinds?: SupportedKind[];
    /** True when live kinds and manifest kinds agree (spec: divergence = misconfiguration). */
    kindsMatchLive?: boolean;
    /**
     * Outcome of the live cross-check, EXPLICIT so "not checked" can never be
     * read as "checked and matched":
     *   ok          — fetched, kinds[] present, kindsMatchLive is meaningful
     *   skipped     — skipLiveCheck, or no facilitator block
     *   unreachable — non-2xx, redirect, timeout, size breach, or bad JSON
     *   malformed   — 2xx but no kinds[] array to compare
     *   refused     — the endpoint was not a safe same-origin path
     */
    liveCheck?: 'ok' | 'skipped' | 'unreachable' | 'malformed' | 'refused';
    /**
     * Resource URLs removed because they pointed off-domain or weren't
     * HTTPS. NON-EMPTY IS A SIGNAL, not noise: the spec invites indexers
     * to probe `resources[]`, so an off-domain entry is an attempt to
     * aim a stranger's crawler somewhere. Surface it; don't just drop it.
     */
    droppedResources?: string[];
    /**
     * Peer hints that survived sanitizePeers — names only, each still to
     * be resolved from scratch. Never act on a peer without re-resolving.
     */
    peers?: string[];
    /** Peer entries dropped by sanitizePeers. Non-empty is a manifest-quality signal. */
    droppedPeers?: string[];
    /**
     * False whenever an `attestation` block cannot be independently checked
     * (absent, `type: none`, or no dereferenceable HTTPS verifier URL).
     * Consumers MUST treat a false value as "not attested" — the spec's
     * "absent verification, treat as `none`" rule, made machine-readable so
     * a caller can't accidentally believe an unverifiable claim.
     */
    attestationUsable?: boolean;
}

// ──────────────────── Negative caching ────────────────────
//
// RFC 2308's lesson, learned by DNS the hard way: under stress the
// NEGATIVE answer is the majority answer. Discovery is designed to be
// crawled across many domains, and most domains do not speak x402 at
// all — so a resolver with no negative cache re-pays full DNS + TCP +
// TLS for every non-participant, forever, and hammers a host that is
// already down.
//
// But a negative cached too long is a self-inflicted outage: a domain
// that just published its record, or just recovered, must not stay
// invisible. So the TTL depends on WHY, because the remedies differ:
//
//   no-record   — the domain simply doesn't advertise x402. The steady
//                 state for most of the internet; safe to remember for
//                 a while, and adoption is not a same-minute event.
//   unreachable — network failure, timeout, 5xx. Almost always
//                 transient, so this gets the SHORTEST TTL; punishing a
//                 recovering host for half an hour is our bug, not its.
//   invalid     — the document was served and is wrong (malformed, or
//                 violates a security rule). An operator must deploy to
//                 fix it, so re-fetching it every few seconds helps
//                 nobody — but it is not permanent either.
//
// We deliberately do NOT cache successes. "Was discoverable" and "is
// operating that way now" are different questions (the same doctrine
// the attestations spec enforces): the live cross-check exists to be
// live. We cache the absence of a service, never its presence.

export type NegativeReason = 'no-record' | 'unreachable' | 'invalid';

export const NEGATIVE_TTL_MS: Readonly<Record<NegativeReason, number>> = Object.freeze({
    'no-record': 30 * 60_000,
    unreachable: 60_000,
    invalid: 5 * 60_000,
});

/** Bounded so a crawler sweeping many domains cannot grow it forever. */
const NEGATIVE_CACHE_MAX = 5_000;
const negativeCache = new Map<string, { reason: NegativeReason; message: string; expiresAt: number }>();

export class X402NegativeCacheError extends Error {
    constructor(public readonly reason: NegativeReason, public readonly cachedMessage: string, domain: string) {
        super(`[x402-discovery] ${domain} cached as ${reason}: ${cachedMessage}`);
        this.name = 'X402NegativeCacheError';
    }
}

function rememberNegative(domain: string, reason: NegativeReason, message: string, now: number, ttls: Record<NegativeReason, number>): void {
    // Oldest-out when full. A crawler's working set is far smaller than
    // its total reach, so this is enough to stop unbounded growth
    // without pretending to be an LRU.
    if (negativeCache.size >= NEGATIVE_CACHE_MAX) {
        const oldest = negativeCache.keys().next();
        if (!oldest.done) negativeCache.delete(oldest.value);
    }
    negativeCache.set(domain, { reason, message, expiresAt: now + ttls[reason] });
}

/** Drop cached negatives — tests, and operator triage after a fix. */
export function clearDiscoveryCache(domain?: string): void {
    if (domain) negativeCache.delete(domain);
    else negativeCache.clear();
}

/** Inspect the cache without mutating it (observability, tests). */
export function discoveryCacheEntry(domain: string, now = Date.now()):
    { reason: NegativeReason; message: string; expiresInMs: number } | null {
    const hit = negativeCache.get(domain);
    if (!hit || hit.expiresAt <= now) return null;
    return { reason: hit.reason, message: hit.message, expiresInMs: hit.expiresAt - now };
}

/**
 * Resolve a domain's x402 capability per the spec:
 * TXT `_x402.<domain>` → manifest URL, else `https://<domain>/.well-known/x402`;
 * then cross-check the facilitator's live `supported` endpoint.
 */
export async function resolveX402(domain: string, opts?: {
    fetchImpl?: typeof fetch;
    resolveTxt?: (name: string) => Promise<string[][]>;
    skipLiveCheck?: boolean;
    /**
     * Address resolution for the private-destination guard. Defaults to
     * real DNS when using the real `fetch`; when a fetchImpl is injected
     * (tests, transports that resolve internally) the guard runs only if
     * a lookupImpl is supplied — a fake fetch makes real DNS both
     * meaningless and a hidden network dependency.
     */
    lookupImpl?: LookupImpl;
    /** Skip the negative cache for this call (forced refresh). */
    noCache?: boolean;
    /** Override negative TTLs (tests, aggressive crawlers). */
    negativeTtlMs?: Partial<Record<NegativeReason, number>>;
    /** Injectable clock so TTL expiry is testable without waiting. */
    now?: () => number;
}): Promise<ResolveResult> {
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const nowFn = opts?.now ?? Date.now;
    const ttls = { ...NEGATIVE_TTL_MS, ...(opts?.negativeTtlMs ?? {}) };
    // Private-destination guard. FAIL-CLOSED refinement (F4): the guard is
    // disabled (null) ONLY when the caller has gone FULLY OFFLINE — injecting
    // BOTH a fake resolveTxt AND a fake fetchImpl, i.e. a test with no real
    // network where the guard is moot. A production caller injecting only a
    // custom fetchImpl (a retry/proxy wrapper) still resolves real DNS, so it
    // keeps the real guard rather than silently losing SSRF protection.
    // lookupImpl always wins when supplied.
    const lookup: LookupImpl | null = opts?.lookupImpl
        ?? (opts?.fetchImpl && opts?.resolveTxt ? null : defaultLookup);
    const guard = async (url: string) => { if (lookup) await assertPublicDestination(url, lookup); };
    const resolveTxt = opts?.resolveTxt ?? (async (name: string) => {
        const dns = await import('dns');
        return dns.promises.resolveTxt(name);
    });

    if (!opts?.noCache) {
        const hit = negativeCache.get(domain);
        if (hit && hit.expiresAt > nowFn()) {
            throw new X402NegativeCacheError(hit.reason, hit.message, domain);
        }
        if (hit) negativeCache.delete(domain);   // expired: re-probe
    }

    /** Classify a failure, remember it, and rethrow unchanged. */
    const failWith = (reason: NegativeReason, e: unknown): never => {
        const message = e instanceof Error ? e.message : String(e);
        if (!opts?.noCache) rememberNegative(domain, reason, message, nowFn(), ttls);
        throw e;
    };

    let manifestUrl = `https://${domain}/.well-known/x402`;
    let via: ResolveResult['via'] = 'well-known';
    let txtRecord: X402TxtRecord | undefined;

    try {
        const records = await resolveTxt(`_x402.${domain}`);
        // Take ALL parseable records, not the first. "First one wins" is a
        // race anyone who can add a single TXT record can win by ordering —
        // a shared DNS panel, a delegated subdomain, a partial compromise.
        // SPF and DMARC both treat duplicates as a hard error for exactly
        // this reason, and we hit the DMARC version of it on our own domain.
        const parsedAll = records
            .map(chunks => parseX402TxtRecord(chunks.join('')))
            .filter((r): r is X402TxtRecord => r !== null);
        if (parsedAll.length > 1) {
            throw new DiscoveryViolation(
                `[x402-discovery] ${parsedAll.length} conflicting v=x402-1 TXT records at _x402.${domain} — ambiguous, refusing to choose`,
            );
        }
        const parsed = parsedAll[0];
        if (parsed) {
            if (!isWkInDomain(parsed.wk, domain)) {
                throw new DiscoveryViolation(`[x402-discovery] TXT wk points outside ${domain}: ${parsed.wk}`);
            }
            manifestUrl = parsed.wk;
            via = 'dns-txt';
            txtRecord = parsed;
        }
    } catch (e) {
        // A HARD violation (malformed/spoofing record) caches as `invalid` — an
        // operator must fix DNS, and it must NOT be silently ignored and fall
        // through to well-known as if the domain published nothing. Everything
        // else (NXDOMAIN, no TXT, SERVFAIL, timeout) is a genuine DNS miss and
        // falls through. Classified by TYPE, so an attacker cannot dodge it
        // with a crafted message and a real parse bug cannot masquerade as a
        // miss. (Silent-failure 1a.)
        if (e instanceof DiscoveryViolation) failWith('invalid', e);
    }

    // Follow redirects MANUALLY, re-applying the in-domain rule to every
    // hop. Default `redirect: 'follow'` checked the URL we asked for, not
    // the URL the bytes came from: an in-domain `wk` that 302s to
    // https://evil.example/.well-known/x402 sailed through the check and
    // we reported the in-domain URL as its source. That defeats the one
    // control the (unauthenticated) DNS layer has, and turns a conforming
    // crawler into the open redirect the spec explicitly claims to prevent.
    let fetched: Awaited<ReturnType<typeof fetchBounded>>;
    let res: Response;
    try {
        await guard(manifestUrl);
        fetched = await fetchBounded(manifestUrl, fetchImpl);
        res = fetched.res;
        for (let hop = 0; res.status >= 300 && res.status < 400 && hop < MAX_MANIFEST_REDIRECTS; hop++) {
            const location = res.headers.get('location');
            if (!location) break;
            const nextUrl = new URL(location, manifestUrl);
            const next = nextUrl.toString();
            // isWkInDomain checks only the host, not the scheme. An in-domain
            // https manifest that 302s to http://same-domain/m passed the host
            // check and was then fetched over cleartext — a silent downgrade.
            // (Review F3.)
            if (nextUrl.protocol !== 'https:') {
                throw new DiscoveryViolation(`[x402-discovery] manifest redirect downgrades to non-HTTPS: ${next}`);
            }
            if (!isWkInDomain(next, domain)) {
                throw new DiscoveryViolation(`[x402-discovery] manifest redirect leaves ${domain}: ${next}`);
            }
            manifestUrl = next;   // report where the bytes ACTUALLY came from
            await guard(manifestUrl);   // every hop — a public host redirecting inward is the classic bypass
            fetched = await fetchBounded(manifestUrl, fetchImpl);
            res = fetched.res;
        }
    } catch (e) {
        // A DiscoveryViolation (redirect leaves domain, HTTPS downgrade, size
        // breach) is a spoofing/DoS signal an operator must FIX — it caches as
        // `invalid` (5 min), not the short `unreachable` TTL an outage gets, so
        // a redirect-out-of-domain does not get the fast-recovery treatment.
        // (Review F11 / silent-failure 1c.) Everything else is a genuine
        // transport failure.
        if (e instanceof DiscoveryViolation) return failWith('invalid', e);
        return failWith('unreachable', e);
    }
    if (res.status >= 300 && res.status < 400) {
        failWith('invalid', new Error(`[x402-discovery] too many manifest redirects for ${domain}`));
    }
    if (!res.ok) {
        // 404 is the ordinary "this domain does not speak x402" answer —
        // the majority answer across the internet, and the one worth
        // remembering longest. Other statuses are server-side trouble.
        failWith(res.status === 404 || res.status === 410 ? 'no-record' : 'unreachable',
            new Error(`[x402-discovery] manifest fetch failed: ${res.status} ${manifestUrl}`));
    }
    let manifest: DiscoveryManifest;
    try {
        manifest = validateManifest(fetched.body);
    } catch (e) {
        // Served, but wrong. Needs an operator deploy to fix.
        return failWith('invalid', e);
    }

    // Same-origin rule applied to the manifest's OWN pointer. Validating
    // only the TXT `wk` left the rule one hop from useless: evil.example
    // could serve a fully valid manifest naming someone else's facilitator
    // as its own — "claiming another operator's facilitator", which the
    // spec asserts is prevented — and every conforming crawler would then
    // hammer that third party's /supported on its behalf.
    if (manifest.facilitator && !isWkInDomain(manifest.facilitator.baseUrl, domain)) {
        failWith('invalid', new Error(
            `[x402-discovery] facilitator.baseUrl points outside ${domain}: ${manifest.facilitator.baseUrl}`,
        ));
    }

    // Execute the spec's own "absent verification, treat as none" rule
    // instead of merely writing it down. A `tee` block whose verifier is
    // not a dereferenceable HTTPS URL cannot be independently checked by
    // anyone, so it must not read as attested — that is the difference
    // between a claim and a verified claim, which is the whole product.
    // `attestationUsable` means "there is a same-origin HTTPS verifier a
    // consumer could dereference", NOT "the attestation is verified" — this
    // resolver does not fetch the verifier. It is deliberately conservative:
    // the verifier must be in-domain, the same rule baseUrl and resources[]
    // obey, so a manifest cannot get a positive signal by naming an
    // attacker-run verifier. A cross-domain verifier leaves the value false
    // rather than pointing a trusting consumer off-origin. (Review F10.)
    const att = (manifest as { attestation?: { type?: string; verifier?: string } }).attestation;
    const attestationUsable = !!att && att.type !== 'none'
        && typeof att.verifier === 'string' && att.verifier.startsWith('https://')
        && isWkInDomain(att.verifier, domain);

    // ── SSRF defence (the spec tells crawlers to fetch these) ──
    // `resources[].url` was validated nowhere, while the resolution
    // algorithm explicitly invites indexers to probe each one. That is
    // server-side request forgery by specification: a host lists
    // http://169.254.169.254/latest/meta-data/ or an internal address and
    // every conforming crawler fetches it from INSIDE its own network.
    // We constrained `wk` and `baseUrl` and left the field designed to be
    // dereferenced. Same rule, applied consistently.
    const droppedResources: string[] = [];
    if (Array.isArray(manifest.resources)) {
        const kept = manifest.resources.filter(r => {
            const ok = typeof r?.url === 'string'
                && r.url.startsWith('https://')
                && isWkInDomain(r.url, domain);
            if (!ok && typeof r?.url === 'string') droppedResources.push(r.url);
            return ok;
        });
        if (kept.length !== manifest.resources.length) {
            (manifest as { resources?: unknown[] }).resources = kept;
        }
    }

    // Peer hints: sanitize before anyone can act on them. The raw array is
    // attacker-writable input by design; what leaves this resolver is only
    // names that a consumer may lawfully feed back into resolveX402().
    const peerScan = sanitizePeers((manifest as { peers?: unknown }).peers, domain);
    if ((manifest as { peers?: unknown }).peers !== undefined) {
        (manifest as { peers?: string[] }).peers = peerScan.peers;
    }

    const out: ResolveResult = {
        manifest, manifestUrl, via, attestationUsable,
        ...(peerScan.peers.length ? { peers: peerScan.peers } : {}),
        ...(peerScan.dropped.length ? { droppedPeers: peerScan.dropped } : {}),
        ...(droppedResources.length ? { droppedResources } : {}),
        ...(txtRecord ? { txtRecord } : {}),
    };

    if (opts?.skipLiveCheck || !manifest.facilitator) {
        out.liveCheck = 'skipped';
        return out;
    }
    {
        const f = manifest.facilitator;
        // liveCheck is an EXPLICIT discriminant: without it, a live /supported
        // that 500s or serves a body with no kinds[] produces the identical
        // shape as skipLiveCheck — so "we didn't check" reads as "we checked
        // and it matched". A consumer treating kindsMatchLive !== false as
        // "consistent" would accept a facilitator whose one live signal is
        // dead. (Silent-failure 1b.)
        const liveUrl = `${f.baseUrl}${f.endpoints.supported}`;
        // The endpoint was validated as a rooted path at diagnoseManifest, but
        // re-check the ASSEMBLED url is same-origin before fetching — defense in
        // depth against the F1 amplification. baseUrl is proven in-domain; this
        // closes the concatenation.
        if (!isSafeRelativePath(f.endpoints.supported) || !isWkInDomain(liveUrl, domain)) {
            out.liveCheck = 'refused';
        } else {
            // SECURITY controls run OUTSIDE the health-catch and PROPAGATE: an
            // SSRF (private-address) attempt or an oversized-body DoS on the
            // live URL is serious enough to refuse the whole resolution, not to
            // downgrade to a quiet 'unreachable'. guard() throws on a private
            // destination; fetchBounded throws DiscoveryViolation on a size
            // breach.
            await guard(liveUrl);
            try {
                const live = await fetchBounded(liveUrl, fetchImpl);
                if (!live.res.ok) {
                    out.liveCheck = 'unreachable';
                } else {
                    const body = live.body as { kinds?: SupportedKind[] };
                    if (!Array.isArray(body?.kinds)) {
                        out.liveCheck = 'malformed';
                    } else {
                        const norm = (ks: SupportedKind[]) => ks
                            .map(k => `${k.x402Version}|${k.scheme}|${k.network}`)
                            .sort()
                            .join(',');
                        out.liveKinds = body.kinds;
                        out.kindsMatchLive = norm(body.kinds) === norm(f.kinds);
                        out.liveCheck = 'ok';
                    }
                }
            } catch (e) {
                // A size-cap breach is a DoS — re-throw it. A transport failure,
                // redirect, or malformed JSON is just a dead/misconfigured live
                // signal — a HEALTH outcome, not a crash out of resolveX402.
                // (Silent-failure 1b/1c.)
                if (e instanceof DiscoveryViolation) throw e;
                out.liveCheck = 'unreachable';
            }
        }
    }
    return out;
}
