# Stripe Machine Payments × x402 discovery

This is [`stripe-samples/machine-payments`](https://github.com/stripe-samples/machine-payments)'s
x402 server (`x402/server/node-typescript/main.ts`) with **one structural change**:

**Upstream**, the facilitator is a vendor credential:

```ts
const facilitatorClient = new HTTPFacilitatorClient(
  createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET),
);
```

**Here**, the facilitator is a DNS-discovered, live-verified choice:

```ts
const { config, resolution } = await discoverFacilitator(process.env.FACILITATOR_DOMAIN, {
  scheme: "exact",
  network: NETWORK,          // validated against the facilitator's LIVE /supported
});
const facilitatorClient = new HTTPFacilitatorClient(config);   // drop-in
```

Resolution follows the x402 `discovery` extension
([x402-foundation/x402 #2979](https://github.com/x402-foundation/x402/pull/2979)):
DNS TXT `_x402.<domain>` → `/.well-known/x402` manifest → live `/supported`
cross-check, with the extension's security rules enforced (in-domain constraints on
every redirect hop, private-destination refusal, bounded fetches). Set
`REQUIRE_ATTESTATION=1` to additionally refuse facilitators whose execution-integrity
claim can't be independently verified.

Unset `FACILITATOR_DOMAIN` and the sample behaves exactly like upstream (CDP path) —
the two modes coexist behind one env var, which is the point: **facilitator choice
becomes configuration, not code.**

## Run

```bash
npm install
FACILITATOR_DOMAIN=api.flareclaw.app X402_NETWORK=coston2 \
STRIPE_SECRET_KEY=sk_test_... DEPOSIT_ADDRESS=0x... \
npm run dev
```

`api.flareclaw.app` and `testnet.flareclaw.app` publish live discovery records today
(the latter resolves via the DNS TXT path). On networks other than Base the Stripe
PaymentIntent recording leg is skipped (Stripe's `transaction_verification` supports
USDC on Base/Solana/Tempo); x402 settlement itself works wherever the discovered
facilitator settles.

## Why

Today every integration built from the sample inherits one company's facilitator as a
hardcoded credential. The protocol is open; facilitator choice should be too. DNS +
`.well-known` make that choice resolvable, verifiable, and vendor-neutral — the same
way MX records made mail servers findable without a registry.

Upstream sample © Stripe (MIT); modifications MIT.
