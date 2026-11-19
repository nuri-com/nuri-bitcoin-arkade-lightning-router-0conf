// Raw L1 collateral -> Lightning fronting.
//
// The deposit is only *seen* on L1 (no confirmation). The router pays the
// BOLT11 from its own node balance through the proven CardLightningDriver, so
// the funding decision and the invoice must be bound before a single sat is
// sent:
//
//   order.amount_sats === invoice amount === deposit output value
//   order.payment_hash === invoice payment hash (bound at order creation)
//   now < lightning_due_at (and < expires_at)
//   receipt.eligible_0conf === true (unconfirmed AND non-RBF signaling)
//
// Exactly-once is enforced by a durable claim written *before* the driver call.
// A replay that finds a claim but no result reports `fronting: "unknown"` and
// does not pay again: a crash cannot be distinguished from an in-flight send.

import { CollateralError, validateDeposit } from "./l1-collateral.js";
import { decodeMainnetInvoice, normalizeInvoice } from "./invoice.js";

const PAID = "paid";
const STARTED = "started";

function assertOrderPayable({ order, receipt, invoice, amountSats, nowSeconds }) {
    const terms = order.reconstruction_terms;

    if (receipt.eligible_0conf !== true) {
        throw new CollateralError(
            receipt.confirmed
                ? "deposit is confirmed; 0-conf fronting not eligible"
                : "deposit signals RBF; 0-conf fronting not eligible",
            receipt.confirmed ? "deposit_confirmed" : "deposit_rbf",
        );
    }
    if (!Number.isSafeInteger(amountSats) || amountSats !== terms.amount_sats || amountSats !== receipt.value_sats) {
        throw new CollateralError(
            `amount mismatch: order ${terms.amount_sats}, deposit ${receipt.value_sats}, invoice ${amountSats}`,
            "amount_mismatch",
        );
    }
    if (nowSeconds >= Number(terms.lightning_due_at)) {
        throw new CollateralError(`lightning due window passed at ${terms.lightning_due_at}`, "lightning_due_passed");
    }
    if (nowSeconds >= Number(terms.expires_at)) {
        throw new CollateralError(`collateral order expired at ${terms.expires_at}`, "order_expired");
    }
    const storedInvoice = terms.invoice ? normalizeInvoice(terms.invoice) : null;
    if (storedInvoice && storedInvoice !== normalizeInvoice(invoice)) {
        throw new CollateralError("invoice differs from the one bound to the order", "invoice_mismatch");
    }
    if (terms.payment_hash && receipt.payment_hash && terms.payment_hash !== receipt.payment_hash) {
        throw new CollateralError("deposit receipt payment hash differs from the order", "payment_hash_mismatch");
    }
}

// One payer call = the proven driver, whose own journal already refuses a
// second wallet.send for the same payment hash. The provider order id comes
// from the driver itself; the L1 order id is a different namespace.
export function cardDriverPayer(driver) {
    return async ({ invoice, amountSats }) => {
        const created = await driver.create({ invoice, amountSats, execute: true });
        if (!created?.orderId) throw new Error("driver create returned no provider order id");
        return driver.finalize({ invoice, amountSats, orderId: created.orderId, execute: true });
    };
}

/**
 * Validate the claimed deposit, require 0-conf eligibility, and front the
 * invoice exactly once.
 *
 * `pay` is the seam: ({invoice, amountSats, orderId}) -> driver receipt.
 */
export async function frontCollateral({
    orderId,
    txid,
    vout,
    invoice,
    amountSats,
    journal,
    esplora,
    pay,
    now = () => Date.now() / 1000,
}) {
    if (typeof pay !== "function") throw new Error("pay function required");
    const order = journal.get(orderId);
    if (!order) throw new CollateralError(`unknown order ${orderId}`, "unknown_order");

    // Replay before any chain or network work: paid is final.
    if (order.receipt?.fronting === PAID) {
        return { order, receipt: order.receipt, replay: true, fronting: PAID };
    }
    // A claim without a result means a previous run may already have sent.
    if (order.receipt?.fronting === STARTED) {
        return { order, receipt: order.receipt, replay: true, fronting: "unknown" };
    }

    const nowSeconds = now();
    const facts = decodeMainnetInvoice(invoice, amountSats, nowSeconds);
    const { order: saved, receipt } = await validateDeposit({ orderId, txid, vout, journal, esplora });

    assertOrderPayable({ order: saved, receipt, invoice: facts.invoice, amountSats, nowSeconds });
    if (saved.reconstruction_terms.payment_hash && saved.reconstruction_terms.payment_hash !== facts.paymentHash) {
        throw new CollateralError(
            `invoice payment hash ${facts.paymentHash} differs from order ${saved.reconstruction_terms.payment_hash}`,
            "payment_hash_mismatch",
        );
    }

    // Durable claim: the only gate that can stop a second driver call.
    if (!journal.claimFronting(orderId, { invoice: facts.invoice, paymentHash: facts.paymentHash })) {
        const current = journal.get(orderId);
        return {
            order: current,
            receipt: current.receipt,
            replay: true,
            fronting: current.receipt?.fronting === PAID ? PAID : "unknown",
        };
    }

    try {
        const driverReceipt = await pay({
            invoice: facts.invoice,
            amountSats: facts.amountSats,
            orderId,
        });
        const final = journal.recordFronting(orderId, {
            providerOrderId: driverReceipt?.orderId ?? null,
            fundingOutpoint: driverReceipt?.fundingOutpoint ?? null,
            finalStatus: driverReceipt?.finalStatus ?? "UNKNOWN",
        });
        return { order: final, receipt: final.receipt, replay: false, fronting: PAID, driverReceipt };
    } catch (error) {
        // The claim stays STARTED: paying again could double-spend the balance.
        journal.recordFrontingFailure(orderId, error instanceof Error ? error.message : String(error));
        throw error;
    }
}
