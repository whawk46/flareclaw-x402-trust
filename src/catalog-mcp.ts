// GENERATED from src/x402/catalog-mcp.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * The x402 Open Catalog — public MCP server core.
 *
 * Protocol posture (SEP-2575 review, docs/plans/x402/2026-08-14-sep-2575-
 * stateless-mcp-review.md): primary = the RELEASED stateless spec revision
 * 2026-07-28 — every request self-contained, no sessions, POST-only JSON —
 * plus a thin LEGACY SHIM answering `initialize` for the deployed-client
 * majority (≤2025-11-25). The shim is legal statelessly: `Mcp-Session-Id`
 * was always optional pre-2575, and no tool here needs cross-call state.
 *
 * This module is transport-free on purpose: it maps one parsed JSON body +
 * two headers to one {status, body} answer, so the facilitator wires it to
 * Express in a few lines and tests drive it with zero network.
 *
 * Evidence doctrine (#3149, three info-loss instances in one week): the
 * snapshot digest + on-chain anchor ride BOTH the result `_meta`
 * (`app.flareclaw/evidence`, the sanctioned server-metadata slot per
 * #3002) AND the human-readable content, because clients demonstrably
 * drop `_meta` before the caller sees it.
 *
 * Cache doctrine (SEP-2549): catalog reads carry `cacheScope: "public"`
 * with a `ttlMs` derived from the actual refresh cadence — the hint tells
 * the truth about when the underlying anchored snapshot can change.
 *
 * Tool names use underscores (`catalog_search`), not dots: several
 * deployed clients validate names against [a-zA-Z0-9_-] and a
 * distribution wedge must not fail the strictest common validator.
 */

import {
    queryCatalog, catalogStats, catalogSnapshotDigest, loadCatalog,
    type OpenCatalogQuery,
} from './open-catalog.js';
import type { ReconcileQuery, ReconcileVerdict } from './reconcile.js';

export const MCP_PROTOCOL_STATELESS = '2026-07-28';
/** Newest first; `initialize` negotiation answers with the first of these. */
export const MCP_PROTOCOL_LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_SUPPORTED_VERSIONS = [MCP_PROTOCOL_STATELESS, ...MCP_PROTOCOL_LEGACY];

const META_PROTOCOL_KEY = 'io.modelcontextprotocol/protocolVersion';
const EVIDENCE_META_KEY = 'app.flareclaw/evidence';

/** JSON-RPC error codes — spec-assigned, not ours to invent. */
const E_PARSE = -32700;
const E_INVALID_REQUEST = -32600;
const E_METHOD_NOT_FOUND = -32601;   // HTTP 404 per 2026-07-28
const E_INVALID_PARAMS = -32602;
const E_UNSUPPORTED_PROTOCOL = -32022; // HTTP 400, lists `supported`
const E_MISSING_CLIENT_CAPABILITY = -32021;

export const CATALOG_MCP_SERVER_INFO = {
    name: 'flareclaw-open-catalog',
    title: 'The x402 Open Catalog',
    version: '0.1.0',
} as const;

const INSTRUCTIONS =
    'The x402 Open Catalog over MCP: a community-run, provenance-tagged index of x402 '
    + 'resources — the CDP Bazaar mirrored via its own public API, plus discovery-crawled '
    + 'records (#2979) carrying independently-checkable attestation status. Nothing here is '
    + 'an endorsement: every row names its source and how to re-derive it without trusting '
    + 'this server, and every result carries the served snapshot\'s sha256 digest plus its '
    + 'on-chain anchor (x402cat/1 self-tx on Flare Coston2) in both _meta and content.';

export interface CatalogAnchorInfo { tx: string; digest: string; at: string }

export interface HostResolution {
    via: 'dns-txt' | 'well-known';
    kind: string;
    attestationUsable: boolean;
    kindsMatchLive?: boolean;
    baseUrl?: string;
}

export interface CatalogMcpDeps {
    statePath: string;
    /** Live anchor state from the serving process; null before first anchor. */
    anchor?: () => CatalogAnchorInfo | null;
    /** How often the serving process refreshes the snapshot (ttl honesty). */
    refreshIntervalMs?: number;
    /** Live discovery resolution for verify_host; absent → tool reports unavailable. */
    resolveHost?: (domain: string) => Promise<HostResolution>;
    /** Rail-side settlement reconciliation (src/x402/reconcile.ts);
     *  absent → the reconcile tool reports unavailable. */
    reconcile?: (q: ReconcileQuery) => Promise<ReconcileVerdict>;
    explorerBase?: string;
    now?: () => number;
}

export interface CatalogMcpHeaders {
    /** MCP-Protocol-Version */
    protocolVersion?: string;
    /** Mcp-Method (SEP-2243) — when present it MUST match the body method. */
    mcpMethod?: string;
}

export interface McpHttpAnswer { status: number; body: unknown | null }

// ── Envelope helpers ─────────────────────────────────────────────────

type RpcId = string | number | null;

function errorAnswer(
    status: number, id: RpcId, code: number, message: string, data?: unknown,
): McpHttpAnswer {
    return {
        status,
        body: { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
    };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Evidence + cache hints ───────────────────────────────────────────

function evidenceBlock(deps: CatalogMcpDeps): Record<string, unknown> {
    const explorer = deps.explorerBase ?? 'https://coston2-explorer.flare.network';
    const anchor = deps.anchor?.() ?? null;
    return {
        snapshotDigest: catalogSnapshotDigest(deps.statePath),
        // The anchored digest may legitimately LAG the served one between a
        // refresh and its anchor confirmation — both are exposed so the lag
        // is visible, never hidden (honest-manifest doctrine).
        anchor: anchor ? { ...anchor, explorer: `${explorer}/tx/${anchor.tx}` } : null,
    };
}

function evidenceSentence(ev: Record<string, unknown>): string {
    const anchor = ev.anchor as ({ tx: string; digest: string; explorer: string } | null);
    const served = (ev.snapshotDigest as string | null) ?? 'none (no snapshot yet)';
    if (!anchor) return `Evidence: served snapshot ${served}; no on-chain anchor yet this boot.`;
    const lag = anchor.digest === ev.snapshotDigest ? '' : ' (anchor lags the served snapshot — refresh newer than last anchor)';
    return `Evidence: served snapshot ${served}; anchored on Coston2 by ${anchor.tx} (${anchor.explorer})${lag}.`;
}

/**
 * ttl = time until the serving process's next scheduled refresh, floored
 * at one minute. Derived from the snapshot's own timestamps so the hint
 * cannot claim freshness the process doesn't deliver.
 */
function snapshotTtlMs(deps: CatalogMcpDeps): number {
    const s = loadCatalog(deps.statePath);
    const last = Math.max(
        s.crawledAt ? Date.parse(s.crawledAt) || 0 : 0,
        s.mirrorFetchedAt ? Date.parse(s.mirrorFetchedAt) || 0 : 0,
    );
    if (!last) return 60_000;
    const interval = deps.refreshIntervalMs ?? 12 * 3_600_000;
    const now = deps.now?.() ?? Date.now();
    return Math.max(60_000, last + interval - now);
}

/** Every result carries serverInfo (spec SHOULD) + resultType (required). */
function decorate(result: Record<string, unknown>, deps: CatalogMcpDeps, opts?: {
    ttlMs?: number; cacheScope?: 'public' | 'private'; evidence?: boolean;
}): Record<string, unknown> {
    const meta: Record<string, unknown> = { serverInfo: CATALOG_MCP_SERVER_INFO };
    if (opts?.evidence) meta[EVIDENCE_META_KEY] = evidenceBlock(deps);
    return {
        ...result,
        resultType: 'success',
        ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs, cacheScope: opts.cacheScope ?? 'public' } : {}),
        _meta: { ...(result._meta as object ?? {}), ...meta },
    };
}

// ── Tools ────────────────────────────────────────────────────────────

/** Alphabetical and stays that way: deterministic tools/list order is a
 *  spec requirement (prompt-cache friendliness), enforced by a test. */
export const CATALOG_MCP_TOOLS = [
    {
        name: 'catalog_get',
        description: 'Look up Open Catalog entries for one resource URL or domain, across both provenance lanes (bazaar-mirror + discovery). Returns every matching row with its source and re-derivation recipe.',
        inputSchema: {
            type: 'object',
            properties: {
                resource: { type: 'string', description: 'Resource URL (exact or prefix) or a bare domain name' },
            },
            required: ['resource'],
        },
    },
    {
        name: 'catalog_search',
        description: 'Query the Open Catalog: filter by source (bazaar-mirror | discovery), network, or independently-verifiable attestation; paginated. Every row is provenance-tagged — how to re-derive it without trusting this server.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', enum: ['bazaar-mirror', 'discovery'] },
                network: { type: 'string', description: 'e.g. "coston2", "base", "eip155:114"' },
                attested: { type: 'boolean', description: 'true → only entries whose attestation claim is independently checkable' },
                limit: { type: 'number', description: '1–500, default 50' },
                offset: { type: 'number' },
            },
        },
    },
    {
        name: 'catalog_stats',
        description: 'Headline numbers: mirrored vs discovered vs attested counts, networks the Bazaar structurally excludes, the served snapshot\'s sha256 digest and its on-chain anchor.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'reconcile',
        description: 'Determinate verdict for one EIP-3009 payment authorization on the Coston2 rail: settled (with the settlement tx + transfers), refused-not-charged (window closed, nonce unconsumed — can never settle), or indeterminate with a machine-readable reason. Every verdict re-derivable from public RPC: authorizationState + AuthorizationUsed logs.',
        inputSchema: {
            type: 'object',
            properties: {
                asset: { type: 'string', description: 'EIP-3009 asset contract address (0x…)' },
                payer: { type: 'string', description: 'The authorizer — the `from` of the authorization (0x…)' },
                nonce: { type: 'string', description: 'The 32-byte authorization nonce (0x + 64 hex)' },
                validBefore: { type: 'number', description: 'The authorization\'s validBefore (unix seconds). Required to prove refused-not-charged: an unconsumed nonce inside its window could still settle.' },
            },
            required: ['asset', 'payer', 'nonce'],
        },
    },
    {
        name: 'verify_host',
        description: 'Two-observation verdict for a hostname: a LIVE x402 discovery resolution (DNS TXT → /.well-known/x402 → live capability cross-check) compared against this catalog\'s last anchored crawl observation. Discovery is not endorsement; this reports checkability, not trustworthiness.',
        inputSchema: {
            type: 'object',
            properties: {
                domain: { type: 'string', description: 'Bare hostname, e.g. "api.flareclaw.app"' },
            },
            required: ['domain'],
        },
    },
] as const;

const HOSTNAME_RE = /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;

function toolResult(
    deps: CatalogMcpDeps,
    summary: string,
    structured: Record<string, unknown>,
    opts: { ttlMs: number; cacheScope?: 'public' | 'private' },
): Record<string, unknown> {
    const ev = evidenceBlock(deps);
    // Belt and suspenders (#3149): evidence in content AND _meta.
    const text = `${summary}\n${evidenceSentence(ev)}\n\n${JSON.stringify(structured, null, 2)}`;
    return decorate({
        content: [{ type: 'text', text }],
        structuredContent: { ...structured, evidence: ev },
        isError: false,
    }, deps, { ...opts, evidence: true });
}

async function callTool(
    id: RpcId, name: unknown, args: Record<string, unknown>, deps: CatalogMcpDeps,
): Promise<McpHttpAnswer> {
    const ok = (result: Record<string, unknown>): McpHttpAnswer =>
        ({ status: 200, body: { jsonrpc: '2.0', id, result } });

    switch (name) {
        case 'catalog_search': {
            const q: OpenCatalogQuery = {
                ...(args.source === 'bazaar-mirror' || args.source === 'discovery' ? { source: args.source } : {}),
                ...(typeof args.network === 'string' ? { network: args.network } : {}),
                ...(args.attested === true ? { attested: true } : {}),
                ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
                ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
            };
            const r = queryCatalog(q, deps.statePath);
            return ok(toolResult(deps,
                `${r.pagination.total} matching entries (returning ${r.rows.length} from offset ${r.pagination.offset}).`,
                r as unknown as Record<string, unknown>,
                { ttlMs: snapshotTtlMs(deps) }));
        }
        case 'catalog_get': {
            const needle = typeof args.resource === 'string' ? args.resource.trim().toLowerCase() : '';
            if (!needle) return errorAnswer(400, id, E_INVALID_PARAMS, 'catalog_get requires a non-empty "resource" string');
            const s = loadCatalog(deps.statePath);
            const rows: unknown[] = [];
            for (const d of s.discovered) {
                const base = (d.baseUrl ?? `https://${d.domain}`).toLowerCase();
                if (d.domain.toLowerCase() === needle || base === needle || base.startsWith(needle)
                    || d.resources.some(u => u.toLowerCase().startsWith(needle))) {
                    rows.push({ source: 'discovery', ...d });
                }
                if (rows.length >= 50) break;
            }
            for (const m of s.mirror) {
                const r = m.resource.toLowerCase();
                if (r === needle || r.startsWith(needle) || r.includes(`//${needle}/`) || r.endsWith(`//${needle}`)) {
                    rows.push({ source: 'bazaar-mirror', ...m });
                }
                if (rows.length >= 50) break;
            }
            return ok(toolResult(deps,
                rows.length ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} for "${needle}" (capped at 50).`
                    : `No catalog entry matches "${needle}". Absence here means "not observed by our lanes", not "does not exist".`,
                { matches: rows },
                { ttlMs: snapshotTtlMs(deps) }));
        }
        case 'catalog_stats': {
            const stats = catalogStats(deps.statePath);
            return ok(toolResult(deps,
                `Open Catalog: ${stats.mirrored} mirrored (of ${stats.mirrorTotalUpstream} upstream), ${stats.discovered} discovery-crawled, ${stats.attested} with independently-checkable attestation.`,
                stats as unknown as Record<string, unknown>,
                { ttlMs: snapshotTtlMs(deps) }));
        }
        case 'reconcile': {
            if (!deps.reconcile) {
                return errorAnswer(400, id, E_INVALID_PARAMS, 'reconcile is not available on this deployment');
            }
            const q: ReconcileQuery = {
                asset: typeof args.asset === 'string' ? args.asset.trim() : '',
                payer: typeof args.payer === 'string' ? args.payer.trim() : '',
                nonce: typeof args.nonce === 'string' ? args.nonce.trim() : '',
                ...(typeof args.validBefore === 'number' ? { validBefore: args.validBefore } : {}),
            };
            const v = await deps.reconcile(q);
            // A determinate verdict is immutable on-chain history; an
            // indeterminate one can flip as soon as the rail answers or
            // the window closes.
            const ttlMs = v.outcome === 'indeterminate' ? 60_000 : 24 * 3_600_000;
            return ok(toolResult(deps,
                `${v.outcome.toUpperCase()}: ${v.reason}`,
                v as unknown as Record<string, unknown>,
                { ttlMs }));
        }
        case 'verify_host': {
            const domain = typeof args.domain === 'string' ? args.domain.trim().toLowerCase().replace(/\.$/, '') : '';
            if (!HOSTNAME_RE.test(domain)) {
                return errorAnswer(400, id, E_INVALID_PARAMS, 'verify_host requires a bare, valid hostname (no scheme, no path)');
            }
            const s = loadCatalog(deps.statePath);
            const catalogEntry = s.discovered.find(d => d.domain.toLowerCase() === domain) ?? null;
            let live: Record<string, unknown>;
            if (!deps.resolveHost) {
                live = { ok: false, error: 'live resolution not available on this deployment' };
            } else {
                try {
                    const r = await deps.resolveHost(domain);
                    live = { ok: true, ...r };
                } catch (e) {
                    live = { ok: false, error: e instanceof Error ? e.message : String(e) };
                }
            }
            // A refusal that names ONE field teaches an operator almost
            // nothing: they cannot tell "one mechanical edit away" from
            // "fundamentally wrong", and they learn one field per debugging
            // round-trip. resolveX402 now reports every violation and flags
            // when they are all fields THIS extension introduced, so surface
            // that distinction in the verdict itself rather than burying it
            // in an error string. (Raised by Melchiorre Oliva on #2979 after
            // this tool refused his otherwise-valid manifest, 2026-08-18.)
            const oneEditAway = !live.ok && typeof live.error === 'string'
                && live.error.includes('all violations are fields THIS extension introduces');
            const verdict = live.ok
                ? (live.attestationUsable ? 'discoverable, attestation independently checkable'
                    : 'discoverable, no checkable attestation (treat as none per spec)')
                : oneEditAway
                    ? 'not discoverable YET — the manifest is valid apart from fields this discovery extension introduces; one mechanical edit away'
                    : (catalogEntry ? 'not resolvable now; was observed by our last crawl — freshness beats history'
                        : 'not discoverable: no x402 record resolvable and none observed by our crawl');
            return ok(toolResult(deps,
                `${domain}: ${verdict}. Two observations — live resolution now, vs this catalog's last anchored crawl${catalogEntry ? ` (${catalogEntry.lastVerified})` : ' (absent)'}.`,
                {
                    domain, verdict, live,
                    // Explicit so a caller can count this population without
                    // parsing prose — the honest migration-cost denominator.
                    ...(oneEditAway ? { oneEditAway: true } : {}),
                    catalog: catalogEntry
                        ? { present: true, via: catalogEntry.via, lastVerified: catalogEntry.lastVerified, attestationVerifiable: catalogEntry.attestationVerifiable }
                        : { present: false },
                },
                // A live probe is only fresh for about as long as the
                // facilitator's own manifest cache (60s).
                { ttlMs: 60_000 }));
        }
        default:
            return errorAnswer(400, id, E_INVALID_PARAMS, `unknown tool: ${String(name)}`, {
                available: CATALOG_MCP_TOOLS.map(t => t.name),
            });
    }
}

// ── The handler ──────────────────────────────────────────────────────

/** Map a body-parse failure (transport layer) to the spec's JSON-RPC shape. */
export function catalogMcpParseError(message = 'body is not valid JSON'): McpHttpAnswer {
    return errorAnswer(400, null, E_PARSE, message);
}

export async function handleCatalogMcp(
    body: unknown, headers: CatalogMcpHeaders, deps: CatalogMcpDeps,
): Promise<McpHttpAnswer> {
    if (Array.isArray(body)) {
        return errorAnswer(400, null, E_INVALID_REQUEST, 'JSON-RPC batching is not supported (removed in 2025-06-18)');
    }
    if (!isPlainObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
        return errorAnswer(400, null, E_INVALID_REQUEST, 'expected a single JSON-RPC 2.0 request object');
    }
    const method = body.method;
    const rawId = body.id;
    const id: RpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    const isNotification = rawId === undefined;
    const params = isPlainObject(body.params) ? body.params : {};

    // SEP-2243: when the routing headers are present they must not lie.
    if (headers.mcpMethod !== undefined && headers.mcpMethod !== method) {
        return errorAnswer(400, id, E_INVALID_REQUEST,
            `Mcp-Method header ("${headers.mcpMethod}") does not match body method ("${method}")`);
    }

    // ── Version gate ──
    const hv = headers.protocolVersion;
    let stateless = false;
    if (hv === MCP_PROTOCOL_STATELESS) {
        stateless = true;
    } else if (hv !== undefined && !(MCP_PROTOCOL_LEGACY as readonly string[]).includes(hv)) {
        return errorAnswer(400, id, E_UNSUPPORTED_PROTOCOL,
            `unsupported protocol version: ${hv}`, { supported: MCP_SUPPORTED_VERSIONS });
    }
    // Absent header = a legacy client before/at initialize; the shim serves it.

    if (stateless) {
        const meta = isPlainObject(params._meta) ? params._meta : {};
        if (meta[META_PROTOCOL_KEY] !== MCP_PROTOCOL_STATELESS) {
            return errorAnswer(400, id, E_INVALID_REQUEST,
                `_meta["${META_PROTOCOL_KEY}"] must be present and match the MCP-Protocol-Version header`);
        }
        if (method === 'initialize' || method === 'ping' || method === 'logging/setLevel') {
            return errorAnswer(404, id, E_METHOD_NOT_FOUND,
                `${method} was removed in ${MCP_PROTOCOL_STATELESS} — every request is self-contained`);
        }
        // server/discover is the bootstrap method — the one request a
        // client may send before knowing what to declare.
        if (!isNotification && method !== 'server/discover' && !isPlainObject(params.clientCapabilities)) {
            return errorAnswer(400, id, E_MISSING_CLIENT_CAPABILITY,
                'clientCapabilities is required on every stateless request');
        }
    }

    // Notifications: acknowledge and do nothing — this server keeps no
    // session state to update. 202 with no body, per Streamable HTTP.
    if (isNotification) return { status: 202, body: null };

    const ok = (result: Record<string, unknown>): McpHttpAnswer =>
        ({ status: 200, body: { jsonrpc: '2.0', id, result } });

    switch (method) {
        case 'initialize': {
            // Legacy shim: negotiate DOWN to our newest legacy revision;
            // deliberately NO session id — this server has no sessions,
            // which was always legal (Mcp-Session-Id is optional pre-2575).
            const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
            const negotiated = (MCP_PROTOCOL_LEGACY as readonly string[]).includes(requested)
                ? requested : MCP_PROTOCOL_LEGACY[0];
            return ok(decorate({
                protocolVersion: negotiated,
                capabilities: { tools: { listChanged: false } },
                serverInfo: CATALOG_MCP_SERVER_INFO,
                instructions: INSTRUCTIONS,
            }, deps));
        }
        case 'ping':
            // Removed in 2026-07-28 (handled above); legacy clients use it
            // as a keepalive and deserve a truthful empty result.
            return ok(decorate({}, deps));
        case 'server/discover':
            return ok(decorate({
                supportedVersions: MCP_SUPPORTED_VERSIONS,
                capabilities: { tools: { listChanged: false }, extensions: {} },
                serverInfo: CATALOG_MCP_SERVER_INFO,
                instructions: INSTRUCTIONS,
            }, deps, { ttlMs: 24 * 3_600_000, cacheScope: 'public' }));
        case 'tools/list':
            return ok(decorate(
                { tools: CATALOG_MCP_TOOLS as unknown as unknown[] },
                deps, { ttlMs: 24 * 3_600_000, cacheScope: 'public', evidence: true },
            ));
        case 'tools/call': {
            const args = isPlainObject(params.arguments) ? params.arguments : {};
            return callTool(id, params.name, args, deps);
        }
        default:
            return errorAnswer(404, id, E_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
}

// ── Server Card (SEP-2127, .well-known/mcp.json) ─────────────────────

/**
 * Same shape family as /.well-known/x402: one host, two well-knowns, one
 * signed identity — the facilitator serves this next to the x402 manifest
 * and signs it with the same per-serve Ed25519 lane, so the DNS-published
 * key vouches for the MCP surface too.
 */
export function buildMcpServerCard(base: string, deps: CatalogMcpDeps): Record<string, unknown> {
    return {
        name: CATALOG_MCP_SERVER_INFO.name,
        title: CATALOG_MCP_SERVER_INFO.title,
        version: CATALOG_MCP_SERVER_INFO.version,
        description: 'MCP access to The x402 Open Catalog — community-run, provenance-tagged, every entry re-derivable from public data; snapshot digests anchored on Flare Coston2.',
        url: `${base}/mcp`,
        transport: 'streamable-http',
        protocol: { supportedVersions: MCP_SUPPORTED_VERSIONS, statelessOnly: false, sessions: 'none' },
        capabilities: { tools: { listChanged: false }, extensions: {} },
        tools: CATALOG_MCP_TOOLS.map(t => ({ name: t.name, description: t.description })),
        evidence: evidenceBlock(deps),
        related: { x402Manifest: `${base}/.well-known/x402`, catalogHttp: `${base}/catalog`, docs: base },
        independence: 'community-run; independent of the x402 Foundation and of Coinbase',
    };
}
