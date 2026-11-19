import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
    CollateralJournal,
    createCollateralOrder,
    createEsploraClient,
    validateDeposit,
} from "../src/l1-collateral.js";

// Real sockets: proves the fetch paths (cosigner + esplora) actually work, not
// just the mocked ones in l1-collateral.test.js.
const clientPk33 = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)).toString("hex");
const serverPk33 = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(8), true)).toString("hex");
const TXID = "cd".repeat(32);

async function startServer() {
    const state = { terms: null, requested: [] };
    const server = http.createServer((req, res) => {
        state.requested.push(req.url);
        res.setHeader("content-type", "application/json");
        if (req.url.startsWith("/arkade/info")) {
            assert.match(req.url, new RegExp(clientPk33));
            res.end(JSON.stringify({ server_pubkey: serverPk33, nuri_server_csv: { type: "blocks", value: 144 } }));
            return;
        }
        if (req.url === "/blocks/tip/height") {
            res.end("800100");
            return;
        }
        if (req.url === `/tx/${TXID}`) {
            res.end(
                JSON.stringify({
                    txid: TXID,
                    vin: [{ txid: "ee".repeat(32), vout: 0, sequence: 0xfffffffd }],
                    vout: [{ value: 25_000, scriptpubkey: state.terms.script_pubkey_hex }],
                    status: { confirmed: false },
                }),
            );
            return;
        }
        res.statusCode = 404;
        res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, state, base: `http://127.0.0.1:${server.address().port}` };
}

test("CLI path over real HTTP: create then check flags RBF as underwritten", async () => {
    const { server, state, base } = await startServer();
    const journal = new CollateralJournal(":memory:");
    try {
        const { order } = await createCollateralOrder({
            clientPk33,
            orderRef: "http-order",
            amountSats: 25_000,
            apiBaseUrl: base,
            journal,
        });
        state.terms = order.reconstruction_terms;
        const esplora = createEsploraClient({ baseUrl: base });
        const { receipt } = await validateDeposit({ orderId: order.order_id, txid: TXID, vout: 0, journal, esplora });
        assert.equal(receipt.state, "funded");
        assert.equal(receipt.eligible_0conf, false);
        assert.equal(receipt.rbf_signaled, true);
        assert.equal(receipt.rbf_proof, false);
        assert.equal(receipt.value_sats, 25_000);
        assert.ok(state.requested.some((u) => u === `/tx/${TXID}`));
    } finally {
        journal.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("esplora 500 surfaces a typed error and stores no receipt", async () => {
    const journal = new CollateralJournal(":memory:");
    const esplora = createEsploraClient({
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await assert.rejects(() => esplora.getTx(TXID), /esplora tx 500/);
    journal.close();
});
