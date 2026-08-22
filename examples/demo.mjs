/**
 * @flareclaw/x402-trust — a five-minute tour of the whole library.
 *
 *   node examples/demo.mjs      (after `npm run build` in this package)
 *
 * Runs entirely offline. The three acts are the three things an agent that
 * spends money has to do. In production the imports are simply:
 *
 *     import { checkService, verifyReceipt, Transcript } from '@flareclaw/x402-trust';
 *
 * Here we import the built package so the demo runs from a clean checkout, and
 * we inject a stub resolver into checkService so Act 3 needs no network. Every
 * other line is exactly what real code looks like.
 */
import {
    Transcript, verifyReceipt, checkService,
} from '../dist/index.js';

const rule = (t) => console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`);
const ok = (b) => (b ? '\x1b[32m✓ true\x1b[0m' : '\x1b[31m✗ false\x1b[0m');

// ══════════════════ ACT 1 — WHAT YOU PRODUCE ══════════════════
// Your agent did three units of work for a counterparty. Commit them to a
// Merkle transcript: one root you sign or anchor, and a receipt per unit.
rule('ACT 1 — your agent did work, and commits it to a verifiable transcript');

const work = new Transcript()
    .add('inv-001', 'GET /price?asset=FLR', '{"price":"0.0231","ts":1755},sig')
    .add('inv-002', 'GET /price?asset=XRP', '{"price":"2.9910","ts":1756},sig')
    .add('inv-003', 'POST /settle 0.05 FCYD', '{"txHash":"0xabc…","ok":true}');

const root = work.root();
console.log(`  committed ${work.size} units of work`);
console.log(`  transcript root : ${root}`);
console.log('  → you sign/anchor this ONE value; it commits to every unit.');

// You hand the counterparty a receipt for just the unit they paid for —
// invoice inv-002 — and nothing else about the session.
const receipt = work.prove(1);
console.log(`\n  receipt for inv-002 (${receipt.proof.length}-hash path, ${receipt.size}-leaf tree):`);
console.log(`    ${JSON.stringify(receipt.entry)}`);

// ══════════════════ ACT 2 — WHAT YOU'RE HANDED ══════════════════
// The counterparty checks that receipt against the signed root. No network.
// No call to us. If it verifies, the work was in the committed set — whoever
// produced it. That is the whole promise: you don't have to trust FlareClaw.
rule('ACT 2 — the counterparty verifies the receipt offline, trusting no one');

console.log(`  receipt verifies against the root?     ${ok(verifyReceipt(receipt))}`);

const forged = { ...receipt, entry: { ...receipt.entry, seed: '{"price":"9.9999"}' } };
console.log(`  a receipt with a doctored result?      ${ok(verifyReceipt(forged))}`);

const misplaced = { ...receipt, index: 0 };
console.log(`  the real receipt at the wrong index?   ${ok(verifyReceipt(misplaced))}`);
console.log('\n  → pure RFC-6962 math. The tamper is caught with zero trust in the producer.');

// ══════════════════ ACT 3 — BEFORE YOU PAY ══════════════════
// Your agent is about to pay a service it discovered by domain. Resolve it,
// verify what can be verified, and get a plain safeToPay decision + reasons.
rule('ACT 3 — before paying a service, check it');

// In production: `await checkService('facilitator.example')`. Here we inject a
// stub resolver so the demo is fully offline; the decision logic is untouched.
const MANIFEST = {
    x402Version: 1, kind: 'facilitator', name: 'Example Facilitator',
    facilitator: {
        baseUrl: 'https://fac.example.com',
        endpoints: { supported: '/supported', verify: '/verify', settle: '/settle' },
        kinds: [{ x402Version: 1, scheme: 'exact', network: 'coston2' }],
    },
};
const stub = (manifest) => ({
    resolveTxt: async () => { throw new Error('ENOTFOUND'); }, // no DNS TXT → well-known
    fetchImpl: async (url) => {
        const routes = {
            'https://example.com/.well-known/x402': manifest,
            'https://fac.example.com/supported': { kinds: MANIFEST.facilitator.kinds },
        };
        const body = routes[String(url)];
        if (body === undefined) return { ok: false, status: 404 };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
});

const good = await checkService('example.com', stub(MANIFEST));
console.log(`  honest facilitator  → safeToPay: ${ok(good.safeToPay)}`);
for (const r of good.reasons) console.log(`      · ${r}`);

// The same call against a manifest that lists an OFF-DOMAIN resource — a
// classic redirect-your-payment spoof. The resolver drops it and surfaces it;
// checkService turns that into a refusal.
const spoofed = { ...MANIFEST, resources: [{ url: 'https://evil.example/drain', description: 'not ours' }] };
const bad = await checkService('example.com', stub(spoofed));
console.log(`\n  spoofed facilitator → safeToPay: ${ok(bad.safeToPay)}`);
for (const r of bad.reasons) console.log(`      · ${r}`);

rule('done — produce, verify, decide. Zero dependencies, zero trust in us.');
