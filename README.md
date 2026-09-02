# @flareclaw/x402-trust

> ⚠️ **NOTICE: This package has graduated to [`@ashlar-blue/x402-trust`](https://www.npmjs.com/package/@ashlar-blue/x402-trust) (v0.5.2+).**  
> All active development, ISDA CDM lifecycle features, Model Context Protocol (MCP) tooling, and security updates are maintained in the flagship repository at [**`correntelabs/ashlar-blue`**](https://github.com/correntelabs/ashlar-blue) and published under [**`@ashlar-blue/x402-trust`**](https://ashlar.blue).
>
> **Migration:**
> ```bash
> npm uninstall @flareclaw/x402-trust
> npm install @ashlar-blue/x402-trust
> ```

---

**Find an x402 facilitator, and decide whether to trust it before you pay.**

Reference implementation of two proposed x402 extensions:

- **`discovery`** ([x402-foundation/x402 #2979](https://github.com/x402-foundation/x402/pull/2979)) — find a facilitator from a domain name via DNS `TXT` + `/.well-known/x402`. No central directory, no list, no gatekeeper.
- **`attestations`** ([#3000](https://github.com/x402-foundation/x402/pull/3000)) — verify what a service claims about itself *before* paying it: TEE attestation blocks and soulbound, revocable, evidence-linked reputation records.

Discovery finds a service. Attestations tell you whether to trust it.

## Three verbs

An agent that spends money has to do three things. This library does each in a
handful of lines, with **zero dependencies** and — for the two verification
verbs — **zero network and zero trust in us**.

```ts
import { checkService, Transcript, verifyReceipt } from '@flareclaw/x402-trust';

// 1. BEFORE YOU PAY — resolve a service and get a plain decision + reasons.
const t = await checkService('facilitator.example');
if (!t.safeToPay) throw new Error(t.reasons.join('; '));   // e.g. off-domain resource, stale manifest

// 2. WHAT YOU PRODUCE — commit the work your agent did to a Merkle transcript.
const work = new Transcript()
  .add('inv-002', 'GET /price?asset=XRP', '{"price":"2.99"}');
const root    = work.root();      // sign or anchor this ONE value
const receipt = work.prove(0);    // hand a counterparty a proof of just their line

// 3. WHAT YOU'RE HANDED — verify a receipt offline, trusting no one.
verifyReceipt(receipt);           // true iff the work was in the committed set
```

`checkService` composes the hardened resolver (same-origin enforcement,
SSRF/DoS guards, HTTPS-only redirects, live `/supported` cross-check) into one
call, so you do not re-implement the adversarial edge cases. The verification
functions are pure [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962) Merkle
math: if a proof verifies, the claim is true no matter who produced it — an
enterprise does not have to trust FlareClaw to use FlareClaw's proofs.

Three more offline verifiers cover the artifacts the catalog and reconciler
emit — `verifyDirectoryEntry` (one host in a census), `verifyReconcileRow` (one
row of a two-observer reconciliation), and the signed-manifest / evidence
grammar below.

**Runnable tour:** [`examples/demo.mjs`](./examples/demo.mjs) — `npm run build && node examples/demo.mjs`. Produces work, verifies it, catches a tamper, and refuses a spoofed facilitator, all offline.

The rest of this document is the building blocks `checkService` sits on, for
callers who want the lower-level surface.

## The Open Catalog, self-hostable (staged for 0.2.0)

Two further modules ship the catalog itself as a reference implementation —
the "anyone can rebuild this from public data" claim, made executable:

- **`open-catalog`** — the catalog engine: mirror the CDP Bazaar via its own
  public API (with attribution), crawl `discovery` records breadth-first with
  per-operator frontier-diversity bounds, and serve a provenance-tagged,
  sha256-digested snapshot. Run it yourself and you are an independent
  observer, not a mirror of ours.
- **`catalog-mcp`** — a transport-free MCP server core for that catalog:
  stateless protocol revision 2026-07-28 primary, sessionless legacy
  `initialize` shim, four read tools, a signable Server Card, and evidence
  (snapshot digest + on-chain anchor) carried in BOTH `_meta` and readable
  content. Wire it to any HTTP framework in ~20 lines; every dependency is
  injected.

## Zero dependencies

`npm ls` returns nothing. That is deliberate: a library whose job is *"decide whether to trust a stranger before sending them money"* cannot credibly arrive with a dependency tree you will never read. The entire trust path — DNS record parsing, manifest validation, redirect handling, the `eth_call`, the digest grammar — is auditable in one sitting.

The one consequence: we cannot compute `keccak256` at runtime, so the badge function selector and well-known `kind` hashes are compile-time constants. They are [asserted against `ethers` in the test suite](https://gitlab.com/flareclaw-saving-demo-group/flareclaw-verifier), so they are verified, not trusted. You can pass your own hasher for any other kind.

## Install

```bash
npm install @flareclaw/x402-trust
```

## Find a facilitator from a domain name

```ts
import { resolveX402 } from '@flareclaw/x402-trust';

const r = await resolveX402('flareclaw.app');

r.via;              // 'dns-txt' — found via _x402.flareclaw.app
r.manifest.facilitator.baseUrl;
r.liveKinds;        // fetched from /supported — authoritative over the manifest
r.kindsMatchLive;   // false = the operator's manifest is stale
r.attestationUsable // false = treat any TEE claim as absent
```

Runs in Node out of the box. In a browser or a worker, inject a DNS resolver (DoH) and it works unchanged:

```ts
await resolveX402('flareclaw.app', { resolveTxt: myDohResolver, fetchImpl: fetch });
```

### What it refuses to do

These are the extension's security rules, enforced rather than documented:

| Situation | Behaviour |
|---|---|
| `wk` in the TXT record points off-domain | hard error (spoofing signal) |
| Manifest redirects off-domain | hard error — the in-domain rule is re-applied to **every hop**, so the check runs on where the bytes came from, not where you asked |
| `facilitator.baseUrl` is off-domain | hard error — otherwise any domain could claim someone else's facilitator, and point every crawler at them |
| TEE block whose `verifier` is not a dereferenceable HTTPS URL | `attestationUsable: false` — an unverifiable claim must not read as a verified one |

## Decide whether to trust it

The important part, and the part most callers get wrong:

```ts
import { checkOperatorTrust } from '@flareclaw/x402-trust';

const trust = await checkOperatorTrust({
  manifest: r.manifest,
  rpcUrl:   'https://coston2-api.flare.network/ext/C/rpc',
  registry: '0xb02f83e994830C4954c89C10482665A3963229c5',  // PIN THIS
  subject:  r.manifest.badges.subject,
  kind:     'x402-facilitator-attested',
});

trust.verified;         // was this operator ever verified?      (registry)
trust.liveAttestation;  // is it in that mode right now?          (manifest)
trust.attestedNow;      // both — this is what you gate on
```

### Why these are three values and not one

A registry record is soulbound, therefore **durable**. TEE attestation is **transient**. Point the first at the second and you get a claim that is true when written and silently false later, with nothing in the record to reveal the drift.

We shipped exactly that bug. Our own `x402-facilitator-attested` record read `active` on-chain while our own manifest honestly reported `attestation: none`, because the enclave was down. The record was not lying about what it attested — a verification really did happen, and its evidence still hashes — it was being *read* as a liveness signal it cannot carry.

So:

| Question | Source of truth |
|---|---|
| *Was this operator verified, by whom, against what evidence?* | the registry record (durable, revocable) |
| *Is it operating that way right now?* | the operator's live manifest (self-degrading) |

`checkOperatorTrust` keeps them apart and only combines them explicitly. It **fails closed**: anything it cannot establish yields `attestedNow: false`.

`hasActiveBadge` likewise **throws rather than returning `false`** when it cannot reach the chain. "I could not check" and "I checked and it is not active" are different answers, and collapsing them is how an RPC outage becomes a silent trust upgrade.

## Drop into the official SDK (`@x402/core`, Stripe Machine Payments)

Every integration built from the [Stripe Machine Payments sample](https://docs.stripe.com/payments/machine/x402) (and most others built on `@x402/core`) hardcodes its facilitator:

```ts
import { facilitator } from "@coinbase/x402";           // ← a constant
const client = new HTTPFacilitatorClient(facilitator);
```

`discoverFacilitator()` turns that constant into a resolved, verified choice — one line changes:

```ts
import { HTTPFacilitatorClient } from "@x402/core/server";
import { discoverFacilitator } from "@flareclaw/x402-trust";

const { config, resolution } = await discoverFacilitator("facilitator.example.com", {
  scheme: "exact",
  network: "eip155:8453",     // require support, judged against the LIVE /supported
});
const client = new HTTPFacilitatorClient(config);        // drop-in

resolution.attestationUsable; // and you know whether its TEE claim is checkable
```

No dependency on `@x402/core` is taken — the returned `config` is a plain `{ url, timeoutMs? }` matching core's `FacilitatorConfig` shape, so your SDK version is the only SDK version involved.

One honest constraint: `HTTPFacilitatorClient` calls the fixed paths `/verify`, `/settle`, `/supported`. A discovered manifest declaring different endpoint paths cannot be expressed as a `FacilitatorConfig`, so `discoverFacilitator()` **fails at resolve time** (`reason: "endpoints"`) instead of handing you a config that 404s at pay time.

## Evidence references

Records point at the evidence that justified them. A bare URI has the trust model of brand reputation — it can be edited or taken down after the fact — so records carry a digest:

```ts
import { encodeEvidenceRef, parseEvidenceRef, sameEvidence, canonicalJson } from '@flareclaw/x402-trust';

const ref = encodeEvidenceRef({
  alg: 'sha256',
  hex: '...',
  ref: 'https://api.flareclaw.app/evidence/<digest>.json',
});
// "x402ev/1; digest=sha256:...; ref=https://..."
```

Verify one by fetching the artifact, canonicalizing it ([RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)), hashing, and comparing to the digest. A fetched artifact that **mismatches** its digest is evidence-invalid and must be a hard negative; an artifact that is merely **unreachable** should down-weight the record, not revoke it. Link rot and tampering are different failures.

## Status

`0.2.0`. Both extensions are open pull requests, not ratified standards — the wire formats may change in response to review, and this package tracks them. It is published because a specification with an installable implementation is a proposal with users attached, and one without is a PDF. Requires Node ≥20 (the manifest signer validates UTF-16 well-formedness via `String.prototype.isWellFormed`).

MIT.
