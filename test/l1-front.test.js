import assert from "node:assert/strict";
import { test } from "node:test";
import {
    CollateralJournal,
    MIN_COLLATERAL_SATS,
    MAX_COLLATERAL_SATS,
    createCollateralOrder,
    termsDigest,
} from "../src/l1-collateral.js";
import { frontCollateral, cardDriverPayer } from "../src/l1-front.js";
import { harness } from "./helpers.js";
import { makeInvoice, paymentHashFor, testKeys } from "./invoice-fixture.js";

const T0 = 1_700_000_000_000; // order creation, ms
const INVOICE = makeInvoice({ amountSats: 25_000, paymentHash: paymentHashFor("front"), timestamp: T0 / 1000 });
const OTHER_INVOICE = makeInvoice({ amountSats: 25_000, paymentHash: paymentHashFor("other"), timestamp: T0 / 1000 });
const TXID = "aa".repeat(32);
const CSV = { type: "blocks", value: 144 };

const infoFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
        return { server_pubkey: testKeys.serverPk33, nuri_server_csv: CSV };
    },
});

function fakeEsplora(tx) {
    const esplora = {
        calls: 0,
        async getTx() { this.calls += 1; return tx; },
        async getTipHeight() { return 900_000; },
    };
    return esplora;
}

function makeTx(terms, { value = terms.amount_sats, script, sequence = 0xffffffff, confirmed = false } = {}) {
    return {
        txid: TXID,
        vin: [{ txid: "bb".repeat(32), vout: 0, sequence }],
        vout: [{ value: 1, scriptpubkey: "51" }, { value, scriptpubkey: script || terms.script_pubkey_hex }],
        status: confirmed ? { confirmed: true, block_height: 899_990 } : { confirmed: false },
    };
}

function fakePay() {
    const pay = async ({ invoice, amountSats, orderId }) => {
        pay.calls += 1;
        pay.args = { invoice, amountSats, orderId };
        if (pay.mode === "crash") throw new Error("SYNTHETIC_CRASH_AFTER_PAY");
        return { orderId: "ord_provider_1", fundingOutpoint: { txid: TXID, vout: 1 }, finalStatus: "COMPLETED" };
    };
    pay.calls = 0;
    pay.mode = "normal";
    return pay;
}

async function makeOrder({ journal = new CollateralJournal(":memory:"), invoice = INVOICE } = {}) {
    const { order } = await createCollateralOrder({
        clientPk33: testKeys.clientPk33,
        orderRef: "order-front-1",
        amountSats: 25_000,
        invoice,
        network: "bitcoin",
        apiBaseUrl: "https://cosigner.test",
        journal,
        now: () => T0,
        fetchImpl: infoFetch,
    });
    return { journal, order, orderId: order.order_id, terms: order.reconstruction_terms };
}

async function front(args) {
    return frontCollateral({ txid: TXID, vout: 1, invoice: INVOICE, amountSats: 25_000, now: () => T0 / 1000 + 10, ...args });
}

test("unconfirmed non-RBF deposit fronts the bound invoice exactly once", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms));
    const result = await front({ orderId, journal, esplora, pay });
    assert.equal(pay.calls, 1);
    assert.equal(result.replay, false);
    assert.equal(result.fronting, "paid");
    assert.equal(result.receipt.provider_order_id, "ord_provider_1");
    assert.equal(result.receipt.final_status, "COMPLETED");
    assert.equal(result.receipt.funding_outpoint, `${TXID}:1`);
    assert.equal(result.receipt.payment_hash, terms.payment_hash);
    assert.equal(result.receipt.eligible_0conf, true);
    assert.equal(result.receipt.rbf_proof, false);
    assert.equal(journal.get(orderId).fronting_state, "paid");
    assert.equal(pay.args.invoice, INVOICE);
});

test("replay after success returns the stored receipt and never pays twice", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms));
    await front({ orderId, journal, esplora, pay });
    const again = await front({ orderId, journal, esplora, pay });
    assert.equal(pay.calls, 1);
    assert.equal(esplora.calls, 1);
    assert.equal(again.replay, true);
    assert.equal(again.fronting, "paid");
    assert.equal(again.receipt.final_status, "COMPLETED");
});

test("crash after the driver call keeps the claim; replay reports unknown and does not pay again", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    pay.mode = "crash";
    const esplora = fakeEsplora(makeTx(terms));
    await assert.rejects(() => front({ orderId, journal, esplora, pay }), /SYNTHETIC_CRASH_AFTER_PAY/);
    assert.equal(pay.calls, 1);
    assert.equal(journal.get(orderId).fronting_state, "started");
    assert.match(journal.get(orderId).fronting_error, /SYNTHETIC_CRASH/);
    pay.mode = "normal";
    const replay = await front({ orderId, journal, esplora, pay });
    assert.equal(pay.calls, 1);
    assert.equal(replay.fronting, "unknown");
    assert.equal(replay.receipt.fronting, "started");
});

test("RBF-signaling deposit does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms, { sequence: 0xfffffffd }));
    await assert.rejects(() => front({ orderId, journal, esplora, pay }), /RBF/);
    assert.equal(pay.calls, 0);
});

test("confirmed deposit does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms, { confirmed: true }));
    await assert.rejects(() => front({ orderId, journal, esplora, pay }), /confirmed/);
    assert.equal(pay.calls, 0);
});

test("wrong deposit amount does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms, { value: terms.amount_sats - 1 }));
    await assert.rejects(() => front({ orderId, journal, esplora, pay }), /wrong_amount|expects/);
    assert.equal(pay.calls, 0);
});

test("wrong script does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms, { script: "0014" + "11".repeat(20) }));
    await assert.rejects(() => front({ orderId, journal, esplora, pay }), /wrong_script|pays/);
    assert.equal(pay.calls, 0);
});

test("expired lightning due window does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms));
    await assert.rejects(
        () => front({ orderId, journal, esplora, pay, now: () => T0 / 1000 + 91 }),
        /due window/,
    );
    assert.equal(pay.calls, 0);
});

test("an invoice other than the bound one does not front", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const pay = fakePay();
    const esplora = fakeEsplora(makeTx(terms));
    await assert.rejects(() => front({ orderId, journal, esplora, pay, invoice: OTHER_INVOICE }), /invoice differs/);
    assert.equal(pay.calls, 0);
});

test("invoice and payment hash are part of the order terms digest", async () => {
    const base = await makeOrder();
    const other = await makeOrder({ invoice: OTHER_INVOICE });
    assert.notEqual(base.terms.payment_hash, other.terms.payment_hash);
    assert.notEqual(base.orderId, other.orderId);
    assert.notEqual(termsDigest(base.terms), termsDigest({ ...base.terms, payment_hash: other.terms.payment_hash }));
    assert.equal(base.terms.invoice, INVOICE);
});

test("caps stay 5000..100000", async () => {
    assert.equal(MIN_COLLATERAL_SATS, 5_000);
    assert.equal(MAX_COLLATERAL_SATS, 100_000);
    const journal = new CollateralJournal(":memory:");
    for (const [sats, pattern] of [[4_999, /below minimum/], [100_001, /above small-cap/]]) {
        await assert.rejects(
            () => createCollateralOrder({
                clientPk33: testKeys.clientPk33,
                orderRef: `caps-${sats}`,
                amountSats: sats,
                invoice: INVOICE,
                apiBaseUrl: "https://cosigner.test",
                journal,
                now: () => T0,
                fetchImpl: infoFetch,
            }),
            pattern,
        );
    }
});

test("cardDriverPayer drives the proven driver once; replay never re-funds", async () => {
    const CARD_AMOUNT = 5_000;
    const CARD_INVOICE = makeInvoice({ amountSats: CARD_AMOUNT, paymentHash: paymentHashFor("driver"), timestamp: Date.parse("2026-08-20T00:00:00Z") / 1000 });
    const h = await harness();
    try {
        const option = { optionId: "arkade:intents", quoteId: "quote-1", depositAmount: "0.00005003", settleAmount: "0.00005000", requiredCapabilities: ["arkade_refund_material", "arkade_intents_fund", "arkade_intents_refund"] };
        const view = () => ({
            orderId: "ord_card_lightning_full", status: "AWAITING_ACTION",
            publicRecovery: { rfqId: "rfq-card-1", refundLocktime: 1_900_000_000, lockupAddress: "ark1lockup", destinationAddress: "ark1mine", senderPublicKey: "ab".repeat(32), amountSats: 5_003 },
            actions: [{ actionId: "fund-1", kind: "arkade_intents_fund", state: "ready", idempotencyKey: "fund-key", request: { to: "ark1lockup", amountSats: 5_003, asset: "BTC_ARKADE" } }],
        });
        h.swapKit.quote = async () => ({ options: [option] });
        h.swapKit.commit = async () => { h.swapKit.commitCalls += 1; return ({ orderId: "ord_card_lightning_full", status: "AWAITING_ACTION", actions: [{ actionId: "material-1", kind: "arkade_refund_material", state: "ready", idempotencyKey: "material-key", request: { scope: "ord_card_lightning_full" } }] }); };
        h.swapKit.submit = async (_orderId, action) => (action.kind === "arkade_refund_material" ? view() : { orderId: "ord_card_lightning_full", status: "COMPLETED", actions: [] });
        h.wallet.fund = async () => { h.wallet.fundCalls += 1; h.wallet.vtxo = { txid: TXID, vout: 1, value: 5_003 }; return TXID; };
        const { order } = await createCollateralOrder({
            clientPk33: testKeys.clientPk33,
            orderRef: "order-front-driver",
            amountSats: CARD_AMOUNT,
            invoice: CARD_INVOICE,
            apiBaseUrl: "https://cosigner.test",
            journal: new CollateralJournal(":memory:"),
            now: () => T0,
            fetchImpl: infoFetch,
        });
        const journal = new CollateralJournal(":memory:");
        journal.insert({
            order_id: order.order_id,
            order_ref: order.reconstruction_terms.order_ref,
            terms_digest: order.terms_digest,
            reconstruction_terms: order.reconstruction_terms,
            address: order.address,
            script_pubkey_hex: order.script_pubkey_hex,
            amount_sats: CARD_AMOUNT,
            invoice: order.invoice,
            payment_hash: order.payment_hash,
        });
        const args = { orderId: order.order_id, txid: TXID, vout: 1, journal, esplora: fakeEsplora(makeTx(order.reconstruction_terms, { value: CARD_AMOUNT })), invoice: CARD_INVOICE, amountSats: CARD_AMOUNT, pay: cardDriverPayer(h.driver), now: () => T0 / 1000 + 10 };
        const paymentHash = (await import("../src/invoice.js")).decodeMainnetInvoice(CARD_INVOICE, CARD_AMOUNT, 0).paymentHash;
        const jrow = h.journal.get(paymentHash);
        const first = await frontCollateral(args);
        assert.equal(first.fronting, "paid");
        assert.equal(first.receipt.final_status, "COMPLETED");
        assert.equal(first.receipt.provider_order_id, "ord_card_lightning_full");
        assert.equal(h.wallet.fundCalls, 1);
        const replay = await frontCollateral(args);
        assert.equal(replay.replay, true);
        assert.equal(h.wallet.fundCalls, 1);
        assert.equal(h.swapKit.commitCalls, 1);
    } finally {
        await h.cleanup();
    }
});
