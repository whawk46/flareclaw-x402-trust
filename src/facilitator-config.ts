// GENERATED from src/x402/facilitator-config.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * Official-SDK adapter: turn x402 `discovery` resolution into the
 * `FacilitatorConfig` that `@x402/core`'s `HTTPFacilitatorClient`
 * accepts — so the one hardcoded line in every integration built from
 * the Stripe Machine Payments sample,
 *
 *     import { facilitator } from "@coinbase/x402";
 *     const client = new HTTPFacilitatorClient(facilitator);
 *
 * becomes a resolved choice:
 *
 *     import { discoverFacilitator } from "@flareclaw/x402-trust";
 *     const { config } = await discoverFacilitator("facilitator.example.com");
 *     const client = new HTTPFacilitatorClient(config);
 *
 * The adapter deliberately does NOT depend on @x402/core: it returns a
 * plain object matching core's `FacilitatorConfig` shape ({ url,
 * timeoutMs? }), so this package stays zero-dependency and the caller's
 * SDK version is the only SDK version involved.
 *
 * One constraint the SDK imposes that discovery does not:
 * `HTTPFacilitatorClient` constructs endpoint URLs as `${url}/verify`,
 * `${url}/settle`, `${url}/supported` — fixed paths. The discovery
 * manifest may declare ANY relative endpoint paths, so a manifest that
 * uses non-conventional paths cannot be expressed as a FacilitatorConfig
 * at all. We refuse loudly (`reason: "endpoints"`) instead of returning
 * a config whose /verify would 404 — a config that fails at pay time is
 * strictly worse than an error at resolve time.
 */

import {
    resolveX402,
    type ResolveResult,
    type SupportedKind,
} from './discovery.js';

/**
 * Shape-compatible with `FacilitatorConfig` from `@x402/core`
 * (`createAuthHeaders` omitted: discovered public facilitators are
 * unauthenticated; callers needing auth can spread one in).
 */
export interface DiscoveredFacilitatorConfig {
    url: string;
    timeoutMs?: number;
}

export type DiscoverFailureReason =
    /** Domain resolved but its manifest has no facilitator block. */
    | 'not-a-facilitator'
    /** Manifest endpoints are not the SDK's fixed /verify /settle /supported. */
    | 'endpoints'
    /** Facilitator exists but does not support the required scheme/network. */
    | 'kind-unsupported';

export class FacilitatorDiscoveryError extends Error {
    constructor(
        public readonly reason: DiscoverFailureReason,
        message: string,
        /** Full resolution result — callers can inspect what WAS found. */
        public readonly resolution: ResolveResult,
    ) {
        super(message);
        this.name = 'FacilitatorDiscoveryError';
    }
}

export interface DiscoverFacilitatorOptions {
    /** Require support for this scheme (e.g. "exact"). Checked against the LIVE kinds when available. */
    scheme?: string;
    /** Require support for this network (e.g. "coston2", "eip155:114"). */
    network?: string;
    /** Copied into the returned config for the SDK's per-request timeout. */
    timeoutMs?: number;
    /** Pass-throughs to resolveX402 (tests, custom transports). */
    fetchImpl?: typeof fetch;
    resolveTxt?: (name: string) => Promise<string[][]>;
    lookupImpl?: (hostname: string) => Promise<string[]>;
    noCache?: boolean;
}

/** The endpoint paths `@x402/core`'s HTTPFacilitatorClient hardcodes. */
const SDK_ENDPOINTS = { supported: '/supported', verify: '/verify', settle: '/settle' } as const;

export interface DiscoverFacilitatorResult {
    /** Drop-in constructor arg for `new HTTPFacilitatorClient(config)`. */
    config: DiscoveredFacilitatorConfig;
    /** The kinds the choice was validated against (live when available). */
    kinds: SupportedKind[];
    /** Full discovery output: attestationUsable, peers, txtRecord, … */
    resolution: ResolveResult;
}

/**
 * Resolve a domain per the x402 `discovery` extension and return an
 * official-SDK-compatible facilitator config, verified against the
 * facilitator's LIVE `/supported` endpoint (authoritative over the
 * manifest, per the spec).
 */
export async function discoverFacilitator(
    domain: string,
    opts: DiscoverFacilitatorOptions = {},
): Promise<DiscoverFacilitatorResult> {
    const resolution = await resolveX402(domain, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.resolveTxt ? { resolveTxt: opts.resolveTxt } : {}),
        ...(opts.lookupImpl ? { lookupImpl: opts.lookupImpl } : {}),
        ...(opts.noCache ? { noCache: true } : {}),
    });

    const fac = resolution.manifest.facilitator;
    if (!fac) {
        throw new FacilitatorDiscoveryError(
            'not-a-facilitator',
            `${domain} publishes x402 discovery data but no facilitator block (kind: ${resolution.manifest.kind})`,
            resolution,
        );
    }

    for (const [name, path] of Object.entries(SDK_ENDPOINTS)) {
        const declared = fac.endpoints[name as keyof typeof SDK_ENDPOINTS];
        if (declared !== path) {
            throw new FacilitatorDiscoveryError(
                'endpoints',
                `${domain} declares ${name} at "${declared}", but @x402/core's HTTPFacilitatorClient `
                + `only calls the fixed path "${path}" — this facilitator cannot be used through the `
                + `official SDK's client. (It may still be usable through a client that honors `
                + `manifest endpoint paths.)`,
                resolution,
            );
        }
    }

    // The spec makes the live endpoint authoritative over the manifest.
    const kinds = resolution.liveKinds ?? fac.kinds;
    if (opts.scheme || opts.network) {
        const ok = kinds.some(k =>
            (opts.scheme === undefined || k.scheme === opts.scheme)
            && (opts.network === undefined || k.network === opts.network));
        if (!ok) {
            const want = [opts.scheme, opts.network].filter(Boolean).join(' on ');
            const have = kinds.map(k => `${k.scheme} on ${k.network}`).join(', ') || 'none';
            throw new FacilitatorDiscoveryError(
                'kind-unsupported',
                `${domain} does not support ${want} (live supported: ${have})`,
                resolution,
            );
        }
    }

    return {
        config: {
            url: fac.baseUrl.replace(/\/+$/, ''),
            ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        },
        kinds,
        resolution,
    };
}
