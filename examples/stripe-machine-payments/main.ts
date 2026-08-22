/**
 * Stripe Machine Payments sample (x402/server/node-typescript/main.ts from
 * stripe-samples/machine-payments) with ONE structural change:
 *
 *   UPSTREAM: the facilitator is a vendor credential —
 *     createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
 *
 *   HERE: the facilitator is a DNS-discovered, live-verified choice —
 *     discoverFacilitator(FACILITATOR_DOMAIN, { scheme, network })
 *
 * Everything else — Hono app, payment middleware, Stripe PaymentIntent
 * recording — is the upstream sample, unchanged. Unset FACILITATOR_DOMAIN
 * and it behaves exactly like upstream (CDP path), so the two modes
 * coexist behind one env var.
 */
import { createFacilitatorConfig } from "@coinbase/x402";
import { discoverFacilitator } from "@flareclaw/x402-trust";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { config } from "dotenv";
import { Hono } from "hono";
import Stripe from "stripe";

config();

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY environment variable is required");
  process.exit(1);
}
if (!process.env.DEPOSIT_ADDRESS) {
  console.error("DEPOSIT_ADDRESS environment variable is required");
  console.error(
    "Create one with: stripe post /v1/crypto/deposit_addresses --live --stripe-version 2026-05-27.preview -d network=base",
  );
  process.exit(1);
}
const DEPOSIT_ADDRESS = process.env.DEPOSIT_ADDRESS.toLowerCase();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  // @ts-expect-error preview API version required for crypto PaymentIntents
  apiVersion: "2026-05-27.preview",
  appInfo: {
    name: "flareclaw/x402-trust example (stripe-samples/machine-payments derivative)",
    url: "https://github.com/whawk46",
    version: "1.0.0",
  },
});

// CAIP-2 network id — the SDK's types require the `namespace:reference` shape.
const NETWORK = (process.env.X402_NETWORK ?? "eip155:8453") as `${string}:${string}`;

// ── THE CHANGE ──────────────────────────────────────────────────────────
// Choose the facilitator by resolving a domain per the x402 `discovery`
// extension (DNS TXT `_x402.<domain>` → /.well-known/x402 manifest →
// live /supported cross-check), instead of importing one vendor's
// endpoint. The returned config is a drop-in HTTPFacilitatorClient arg.
async function chooseFacilitator(): Promise<FacilitatorConfig> {
  const domain = process.env.FACILITATOR_DOMAIN;
  if (!domain) {
    // Upstream behavior, unchanged: Coinbase CDP facilitator via API keys.
    if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
      console.error(
        "Set FACILITATOR_DOMAIN to discover a facilitator, or CDP_API_KEY_ID/CDP_API_KEY_SECRET for the CDP default",
      );
      process.exit(1);
    }
    return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
  }

  const { config: discovered, kinds, resolution } = await discoverFacilitator(domain, {
    scheme: "exact",
    network: NETWORK,
    timeoutMs: 10_000,
  });

  // Optional trust gate: refuse facilitators whose execution-integrity
  // claim cannot be independently verified (attestation absent, `none`,
  // or lacking a dereferenceable verifier URL).
  if (process.env.REQUIRE_ATTESTATION === "1" && !resolution.attestationUsable) {
    throw new Error(
      `${domain} resolved (via ${resolution.via}) but publishes no independently verifiable attestation`,
    );
  }

  console.log(
    `facilitator: ${discovered.url} (via ${resolution.via}, ${kinds.length} kind(s), ` +
      `attestation ${resolution.attestationUsable ? "verifiable" : "none"})`,
  );
  return discovered;
}

const facilitatorClient = new HTTPFacilitatorClient(await chooseFacilitator());
// ── END OF THE CHANGE ───────────────────────────────────────────────────

const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

// Upstream, unchanged: record settled on-chain payments as Stripe
// PaymentIntents (transaction_verification mode). Stripe supports this
// for USDC on Base/Solana/Tempo — on other networks (e.g. a Flare
// testnet facilitator) settlement still works; only this recording leg
// is skipped by the network guard below.
resourceServer.onAfterSettle(async ({ result, requirements }) => {
  const txHash = result.transaction;
  if (!txHash || !result.success) return;
  if (NETWORK !== "eip155:8453") return; // PI recording is Base-only in this example

  const amountInCents = Math.round(Number(requirements.amount) / 10000);
  if (amountInCents < 1) return;

  const pi = await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency: "usd",
      confirm: true,
      payment_method_data: { type: "crypto" },
      payment_method_types: ["crypto"],
      payment_method_options: {
        crypto: {
          mode: "transaction_verification",
          transaction_verification_options: {
            network: "base",
            transaction_hash: txHash,
          },
        },
      },
    } as Stripe.PaymentIntentCreateParams,
    { idempotencyKey: txHash },
  );

  console.log(`Stripe PI ${pi.id}: ${amountInCents}¢ on base for tx ${txHash}`);
});

const app = new Hono();

app.use(
  paymentMiddleware(
    {
      "GET /paid": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: NETWORK,
            payTo: DEPOSIT_ADDRESS,
          },
        ],
        description: "Data retrieval endpoint",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/paid", (c) => {
  return c.json({
    foo: "bar",
  });
});

serve({
  fetch: app.fetch,
  port: 4242,
});

console.log("Server listening at http://localhost:4242");

export { app };
