import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import {
    CollateralJournal,
    createCollateralOrder,
    reconstructCollateral,
    riskReceipt,
    validateDeposit,
} from "../src/l1-collateral.js";

const clientPk33 = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true)).toString("hex");
const serverPk33 = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).toString("hex");
const CSV = { type: "blocks", value: 144 };
const TIP = 900_000;

function infoFetch() {
    return async (url) => {
        assert.match(url, /\/arkade\/info\?client_signer_pubkey=/);
        return {
            ok: true,
            status: 200,
            async json() {
                return { server_pubkey: serverPk33, nuri_server_csv: CSV, recovery_policy: { blocks: 144 } };
            },
        };
    };
}

function fakeEsplora({ tx, tip = TIP }) {
    return {
        calls: [],
        async getTx(txid) {
            this.calls.push(["tx", txid]);
            return tx;
        },
        async getTipHeight() {
            this.calls.push(["tip"]);
            return tip;
        },
    };
}

function makeTx(terms, { value = terms.amount_sats, script, sequence = 0xfffffffd, confirmed = false, height } = {}) {
    return {
        txid: "aa".repeat(32),
        vin: [{ txid: "bb".repeat(32), vout: 0, sequence }],
        vout: [
            { value: 1, scriptpubkey: "51" },
            { value, scriptpubkey: script || terms.script_pubkey_hex },
        ],
        status: confirmed ? { confirmed: true, block_height: height ?? TIP - 2 } : { confirmed: false },
    };
}

async function makeOrder({ journal = new CollateralJournal(":memory:"), now = () => 1_700_000_000_000 } = {}) {
    const { order } = await createCollateralOrder({
        clientPk33,
        orderRef: "order-replay-1",
        amountSats: 25_000,
        network: "bitcoin",
        apiBaseUrl: "https://cosigner.test",
        journal,
        now,
        fetchImpl: infoFetch(),
    });
    const terms = order.reconstruction_terms;
    return { journal, orderId: order.order_id, terms };
}

test("reconstruction is deterministic and address matches a fresh p2tr rebuild", async () => {
    const { orderId, terms } = await makeOrder();
    const again = reconstructCollateral(terms);
    assert.equal(again.address, terms.address);
    assert.equal(again.script_pubkey_hex, terms.script_pubkey_hex);
    assert.equal(again.leaf_script_hex, terms.leaf_script_hex);
    assert.deepEqual(again.csv === undefined ? terms.csv : again.csv, terms.csv);
    assert.ok(orderId.startsWith("l1c_"));
    // Independent rebuild from the leaf, not through our helper.
    const rebuilt = btc.p2tr(
        Buffer.from(terms.internal_key_xonly, "hex"),
        [{ script: Buffer.from(terms.leaf_script_hex, "hex"), leafVersion: 0xc0 }],
        btc.NETWORK,
        true,
    );
    assert.equal(rebuilt.address, terms.address);
    assert.equal(Buffer.from(rebuilt.script).toString("hex"), terms.script_pubkey_hex);
    // Leaf really is <user> CHECKSIGVERIFY <seq> CSV.
    assert.ok(terms.leaf_script_hex.startsWith(`20${terms.client_pk33.slice(2)}ad`));
    assert.ok(terms.leaf_script_hex.endsWith("b2"));
});

test("pinned live mainnet vector: reproduces @lennard's on-chain wallet", () => {
    // Vector pinned by nuri-server-musig2-v4-arkade scripts/onchain-address-proof.mjs.
    const r = reconstructCollateral({
        client_pk33: "03271f2b3e7abe30a080038f62233108c1ac62d9623f79689f87f86e89613dc9d7",
        aggregated_pk33: "023cc6758badef6752417b6969ba4bdc8983855563ab3693ebd3184d99e93a7330",
        network: "bitcoin",
        csv: { type: "seconds", value: 6674432 },
    });
    assert.equal(r.address, "bc1p3qk7647mnrzrq0fyj4zrzv5qmfrysgd7u4h9u5t7x5fqae3zlxastndvrd");
    assert.equal(r.sequence, 0x4032ec); // 6674432s >> 9 | BIP68 type flag
    assert.equal(r.leaf_script_hex, "20271f2b3e7abe30a080038f62233108c1ac62d9623f79689f87f86e89613dc9d7ad03ec3240b2");
});

test("aggregated key disagreement between server key and terms is rejected", () => {
    assert.throws(
        () =>
            reconstructCollateral({
                client_pk33: clientPk33,
                server_pk33: serverPk33,
                aggregated_pk33: clientPk33,
                network: "bitcoin",
                csv: CSV,
            }),
        /aggregated key mismatch/,
    );
});

test("risk receipt says router-underwritten and not RBF-proof", async () => {
    const { terms } = await makeOrder();
    const receipt = riskReceipt();
    assert.equal(receipt.underwriting, "router");
    assert.equal(receipt.rbf_proof, false);
    assert.equal(terms.cosigner.aggregate_path.includes("MuSig2"), true);
});

test("wrong script is rejected", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms, { script: "0014" + "11".repeat(20) }) });
    await assert.rejects(() => validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora }), /wrong_script|pays/);
    assert.equal(journal.get(orderId).receipt, null);
});

test("wrong amount is rejected", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms, { value: terms.amount_sats - 1 }) });
    await assert.rejects(() => validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora }), /wrong_amount|expects/);
});

test("RBF-signaling deposit is funded but ineligible for 0-conf", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms, { sequence: 0xfffffffd }) });
    const { receipt } = await validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    assert.equal(receipt.rbf_signaled, true);
    assert.equal(receipt.rbf_proof, false);
    assert.equal(receipt.underwriting, "router");
    assert.equal(receipt.state, "funded");
    assert.equal(receipt.eligible_0conf, false);
    assert.equal(receipt.confirmed, false);
});

test("non-signaling deposit is funded, not replaced", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms, { sequence: 0xffffffff }) });
    const { receipt } = await validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    assert.equal(receipt.rbf_signaled, false);
    assert.equal(receipt.state, "funded");
    assert.equal(receipt.eligible_0conf, true);
});

test("confirmed deposit counts confirmations and drops the underwriting window", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms, { confirmed: true, height: TIP - 2 }) });
    const { receipt } = await validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.confirmations, 3);
    assert.equal(receipt.state, "confirmed");
    assert.equal(receipt.underwritten_until, null);
});

test("replay of the same outpoint returns the stored receipt without refetching", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const esplora = fakeEsplora({ tx: makeTx(terms) });
    const first = await validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    const second = await validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    assert.equal(first.replay, false);
    assert.equal(second.replay, true);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(esplora.calls.filter(([k]) => k === "tx").length, 1);
    assert.equal(journal.db.prepare("SELECT COUNT(*) c FROM l1_collateral_orders").get().c, 1);
});

test("same outpoint on a different order is refused", async () => {
    const journal = new CollateralJournal(":memory:");
    const a = await makeOrder({ journal });
    const b = await makeOrder({ journal, now: () => 1_700_000_001_000 });
    assert.notEqual(a.orderId, b.orderId);
    const esplora = fakeEsplora({ tx: makeTx(a.terms) });
    await validateDeposit({ orderId: a.orderId, txid: "aa".repeat(32), vout: 1, journal, esplora });
    await assert.rejects(
        () => validateDeposit({ orderId: b.orderId, txid: "aa".repeat(32), vout: 1, journal, esplora }),
        /already bound/,
    );
});

test("same order inputs replayed through createCollateralOrder reuse the same order id", async () => {
    const journal = new CollateralJournal(":memory:");
    const first = await makeOrder({ journal });
    const again = await createCollateralOrder({
        clientPk33,
        orderRef: "order-replay-1",
        amountSats: 25_000,
        network: "bitcoin",
        apiBaseUrl: "https://cosigner.test",
        journal,
        now: () => 1_700_000_000_000,
        fetchImpl: infoFetch(),
    });
    assert.equal(again.created, false);
    assert.equal(again.order.order_id, first.orderId);
});

test("corrupt stored terms are caught before validation", async () => {
    const { journal, orderId, terms } = await makeOrder();
    const tampered = { ...terms, script_pubkey_hex: "5120" + "00".repeat(32) };
    journal.db.prepare("UPDATE l1_collateral_orders SET terms_json = ? WHERE order_id = ?").run(JSON.stringify(tampered), orderId);
    const esplora = fakeEsplora({ tx: makeTx(terms) });
    await assert.rejects(
        () => validateDeposit({ orderId, txid: "aa".repeat(32), vout: 1, journal, esplora }),
        /do not reconstruct/,
    );
});
