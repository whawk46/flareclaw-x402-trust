// GENERATED from src/x402/reconcile.ts by scripts/sdk/sync-sdk.ts — do not edit here.
// The canonical module is the one FlareClaw runs in production; this is a copy so
// that what we publish and what we run cannot diverge. Edit the canonical file.

/**
 * reconcile — the determinate answer to "what happened to this
 * authorization?" (Iman's cross-domain step 4, served as a query).
 *
 * The observation behind it: on this rail the hard half of
 * reconciliation is already structural — an EIP-3009 nonce is
 * consume-on-entry (`authorizationState`), and settlement is
 * written-inside-the-act (the `AuthorizationUsed` event + FCUSD/FCYD
 * `Transfer` in the same tx). What third parties lack is the JOIN.
 * This module performs it and returns a verdict a cold party
 * re-derives from public RPC alone:
 *
 *   settled              the nonce is consumed on-chain; evidence
 *                        names the settlement tx + the transfer it
 *                        carried (payer → payTo, amount)
 *   refused-not-charged  the nonce is unconsumed AND the authorization
 *                        window has closed — it can never settle
 *   indeterminate        with a MACHINE-READABLE reason, never a
 *                        silent shrug: rail unreachable, window still
 *                        open (could still settle), out-of-scope asset
 *
 * PURITY: the decision table is pure over injected observations; all
 * chain I/O lives behind the `RailReader` port (tests inject stubs,
 * the facilitator wires public-RPC reads). No keys anywhere — this is
 * read-only enumeration of a public rail.
 */

export type ReconcileOutcome = 'settled' | 'refused-not-charged' | 'indeterminate';

export interface ReconcileQuery {
    /** EIP-3009 asset contract address (FCUSD/FCYD on Coston2). */
    asset: string;
    /** The authorizer (`from` of the authorization). */
    payer: string;
    /** The 32-byte authorization nonce, 0x-hex. */
    nonce: string;
    /** The authorization's validBefore (unix seconds), when the caller
     *  knows it — required to prove refused-not-charged (an unconsumed
     *  nonce inside its window could still settle). */
    validBefore?: number;
}

/** What the settlement use looked like on-chain, when found. */
export interface SettlementUse {
    tx: string;
    blockNumber: number;
    /** FCUSD/FCYD transfers the settlement tx carried. */
    transfers: { from: string; to: string; amountAtomic: string }[];
}

/**
 * How a consumed nonce was consumed.
 *
 * THE 2026-08-22 CORRECTION (Circadian-agent, x402#3226): `authorizationState`
 * returns true for `used` OR `cancelled`. EIP-3009's `cancelAuthorization`
 * consumes the nonce and MOVES NO TOKENS — Circle's own revert string on Base
 * USDC says it plainly: "authorization is used or canceled", one state, two
 * causes. So the consumed flag alone cannot distinguish "the payer paid" from
 * "the payer withdrew the offer", which are opposite verdicts.
 *
 * The events do distinguish them, and both are indexed on (authorizer, nonce),
 * so a topic filter resolves it exactly and more cheaply than scanning for a
 * matching Transfer:
 *   AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)
 *   AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)
 */
export type ConsumptionKind = 'used' | 'cancelled';

/** What the consumption looked like on-chain, when the event was found. */
export interface ConsumptionRecord {
    kind: ConsumptionKind;
    tx: string;
    blockNumber: number;
    /** Transfers the tx carried. Always empty for `cancelled` — that is the point. */
    transfers: { from: string; to: string; amountAtomic: string }[];
}

/** Chain I/O port. Implementations MUST throw on I/O failure — the
 *  decision table maps a throw to `indeterminate: rail unreachable`,
 *  never to a definite verdict. */
export interface RailReader {
    /** EIP-3009 `authorizationState(payer, nonce)` — consumed (used OR cancelled)? */
    authorizationConsumed(asset: string, payer: string, nonce: string): Promise<boolean>;
    /**
     * Resolve HOW the nonce was consumed, by topic filter on
     * AuthorizationUsed / AuthorizationCanceled. Returns null only when
     * neither event is locatable — a genuine reader-range limit, and the
     * ONLY case for which "widen the range" is honest advice.
     */
    findConsumption(asset: string, payer: string, nonce: string): Promise<ConsumptionRecord | null>;
    /**
     * The chain height this reader is answering at.
     *
     * OPTIONAL ON THE PORT, ALWAYS REPORTED IN THE VERDICT. Circadian-agent
     * (x402#3226, 2026-08-22) put this ahead of the clock and gave the reason
     * that settles it: "a verdict without a read height cannot be replayed, so
     * two people disagreeing have no way to tell a reorg from a bug from a
     * different node." Reorgs are the famous case, but disagreement is the
     * common one — without a height, two parties comparing verdicts cannot
     * even establish that they read the same chain state.
     *
     * A reader that cannot supply it still gets a verdict; the verdict says
     * `replayable: false` so the degradation is visible rather than assumed
     * away. Absent must never be indistinguishable from present.
     */
    blockHeight?(): Promise<number>;
}

/**
 * WHERE AND WHEN the verdict was read. Carried on every outcome, including
 * failures, because the failures are exactly the verdicts people argue about.
 */
export interface ReconcileObservation {
    /** Chain height the rail was read at, or null when the reader cannot say. */
    blockHeight: number | null;
    /**
     * The clock reading used, in unix seconds. The clock enters this decision
     * at exactly ONE boundary (`now > validBefore`), so publishing the reading
     * lets a disputing party recompute that comparison instead of trusting it.
     */
    clockUnixSeconds: number;
    /** True when the boundary above actually decided this verdict. */
    clockWasLoadBearing: boolean;
    /** False when blockHeight is null — this verdict cannot be re-read at a fixed state. */
    replayable: boolean;
}

export interface ReconcileVerdict {
    outcome: ReconcileOutcome;
    /** One sentence a human reads; the outcome is what machines branch on. */
    reason: string;
    /** Machine-readable cause, stable vocabulary. */
    cause:
    | 'nonce-used'
    | 'authorization-cancelled'
    | 'consumption-kind-unknown'
    | 'window-closed-unconsumed'
    | 'window-open-unconsumed'
    | 'window-unknown-unconsumed'
    | 'out-of-scope-asset'
    | 'invalid-query'
    | 'rail-unreachable';
    /** Present whenever the consumption event was located, on either verdict. */
    consumption?: ConsumptionRecord;
    /** Where and when this was read. Always present, on every outcome. */
    observation: ReconcileObservation;
    /** How a cold party re-derives this verdict with no trust in us. */
    rederive: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

/** Assets this reconciler speaks for. Injectable so tests stay pure and
 *  the list can grow without touching the decision table. */
export interface ReconcileScope {
    /** lowercase address → symbol for known EIP-3009 assets. */
    assets: Record<string, string>;
    network: string;
    rpc: string;
}

export async function reconcileAuthorization(
    q: ReconcileQuery,
    reader: RailReader,
    scope: ReconcileScope,
    now: () => number,
): Promise<ReconcileVerdict> {
    // `now` is defined by this port to return UNIX SECONDS, matching
    // validBefore's units — the facilitator passes Math.floor(Date.now()/1000)
    // and the tests pass a seconds constant. Do not re-scale it here.
    const clockUnixSeconds = now();

    // Read the height FIRST, so even a verdict that fails early carries the
    // state it failed at. A height fetched after the decision would describe a
    // different chain than the one the decision was made against.
    let blockHeight: number | null = null;
    if (reader.blockHeight) {
        try { blockHeight = await reader.blockHeight(); } catch { blockHeight = null; }
    }
    /** Build the observation, marking whether the clock decided this verdict. */
    const obs = (clockWasLoadBearing: boolean): ReconcileObservation => ({
        blockHeight,
        clockUnixSeconds,
        clockWasLoadBearing,
        replayable: blockHeight !== null,
    });

    const at = blockHeight === null
        ? 'at an unknown height (this reader does not report one, so the verdict is not replayable)'
        : `at block ${blockHeight}`;
    const rederive = `Read authorizationState(payer, nonce) on the asset contract via any ${scope.network} RPC (${scope.rpc}) ${at}; `
        + 'if consumed, filter AuthorizationUsed(payer, nonce) logs for the settlement tx and decode its Transfer events.';

    if (!ADDR_RE.test(q.asset ?? '') || !ADDR_RE.test(q.payer ?? '') || !NONCE_RE.test(q.nonce ?? '')) {
        return {
            outcome: 'indeterminate', cause: 'invalid-query',
            reason: 'asset and payer must be 0x addresses and nonce a 32-byte 0x-hex value',
            observation: obs(false), rederive,
        };
    }
    const symbol = scope.assets[q.asset.toLowerCase()];
    if (!symbol) {
        return {
            outcome: 'indeterminate', cause: 'out-of-scope-asset',
            reason: `asset ${q.asset} is not an EIP-3009 asset this rail settles — no verdict, not a refusal`,
            observation: obs(false), rederive,
        };
    }

    let consumed: boolean;
    try {
        consumed = await reader.authorizationConsumed(q.asset, q.payer, q.nonce);
    } catch (e) {
        return {
            outcome: 'indeterminate', cause: 'rail-unreachable',
            reason: `rail unreachable (${(e as Error).message}) — unknown is not a verdict; retry`,
            observation: obs(false), rederive,
        };
    }

    if (consumed) {
        // CONSUMED IS NOT SETTLED. It is used-or-cancelled, and a cancelled
        // authorization moved no tokens. Resolve which by event before
        // returning any verdict — the previous version returned `settled`
        // here and told the reader to widen their log range, which is the
        // one case where widening never helps and the advice is reassuring
        // about a payment that never happened.
        let record: ConsumptionRecord | null = null;
        try {
            record = await reader.findConsumption(q.asset, q.payer, q.nonce);
        } catch {
            // Enumeration failed. We know the nonce is spent but not how,
            // and the two possibilities are OPPOSITE verdicts — so this is
            // indeterminate, never a coin-flip toward settled.
            return {
                outcome: 'indeterminate', cause: 'consumption-kind-unknown',
                reason: 'nonce is consumed but the event read failed — consumed means used OR cancelled, and those are opposite verdicts; retry',
                observation: obs(false), rederive,
            };
        }

        if (record === null) {
            return {
                outcome: 'indeterminate', cause: 'consumption-kind-unknown',
                reason: 'nonce is consumed but neither AuthorizationUsed nor AuthorizationCanceled was locatable in this reader\'s log range — re-derive with a wider range',
                observation: obs(false), rederive,
            };
        }

        if (record.kind === 'cancelled') {
            return {
                outcome: 'refused-not-charged', cause: 'authorization-cancelled',
                reason: `authorization was CANCELLED (tx ${record.tx}, block ${record.blockNumber}) — the nonce is consumed but no tokens moved; the payer was not charged`,
                consumption: record,
                observation: obs(false), rederive,
            };
        }

        return {
            outcome: 'settled', cause: 'nonce-used',
            reason: `authorization used on-chain; settlement tx ${record.tx} (block ${record.blockNumber}) carried ${record.transfers.length} ${symbol} transfer(s)`,
            consumption: record,
            observation: obs(false), rederive,
        };
    }

    if (typeof q.validBefore === 'number') {
        // THE CLOCK IS LOAD-BEARING HERE AND NOWHERE ELSE. Everything above is
        // decided by chain state; this one comparison is decided by what time
        // we think it is. The observation publishes the reading so a party who
        // disagrees can recompute the comparison instead of disputing a verdict.
        if (clockUnixSeconds > q.validBefore) {
            return {
                outcome: 'refused-not-charged', cause: 'window-closed-unconsumed',
                // HONEST ABOUT WHAT THIS DOES NOT SAY (Circadian-agent, #3226):
                // the rail cannot distinguish "a settle was attempted and
                // failed" from "nobody ever tried". x402#3231 is a live
                // instance of the first — a valid authorization the reference
                // facilitator could not settle because of a stale nonce on its
                // OWN relayer wallet. The OUTCOME is right either way (no
                // tokens moved, the payer was not charged); the reason must not
                // imply the payer withdrew.
                reason: `authorization unconsumed and its window closed at ${q.validBefore} (clock ${clockUnixSeconds}) — it can never settle, so the payer was not charged. This does NOT say whether a settle was attempted and failed or never attempted; the rail cannot distinguish those.`,
                observation: obs(true), rederive,
            };
        }
        return {
            outcome: 'indeterminate', cause: 'window-open-unconsumed',
            reason: `authorization unconsumed but valid until ${q.validBefore} (clock ${clockUnixSeconds}) — it could still settle; re-query after expiry for a determinate verdict`,
            observation: obs(true), rederive,
        };
    }
    return {
        outcome: 'indeterminate', cause: 'window-unknown-unconsumed',
        reason: 'authorization unconsumed and no validBefore supplied — cannot rule out a future settle; supply validBefore for a determinate refused-not-charged',
        observation: obs(false), rederive,
    };
}
