#!/usr/bin/env node
// L1 collateral order CLI. Read-only against Nuri + Esplora; no keys, no spending.
//
//   node scripts/l1-collateral.js create --client-pk <33-byte hex> --ref order-1 --sats 25000
//   node scripts/l1-collateral.js check --order <order_id> --txid <hex> --vout 0
//   node scripts/l1-collateral.js show --order <order_id>
//
// Env: NURI_COSIGNER_URL (default https://arkade.nuri.com/v4),
//      ESPLORA_URL (default https://blockstream.info/api),
//      COLLATERAL_JOURNAL (default .data/l1-collateral.sqlite)

import {
    CollateralJournal,
    createCollateralOrder,
    createEsploraClient,
    validateDeposit,
} from "../src/l1-collateral.js";

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const journal = new CollateralJournal(arg("journal", process.env.COLLATERAL_JOURNAL || ".data/l1-collateral.sqlite"));
const command = process.argv[2];

function print(value) {
    console.log(JSON.stringify(value, null, 2));
}

try {
    if (command === "create") {
        const { order, deposit, risk } = await createCollateralOrder({
            clientPk33: arg("client-pk"),
            orderRef: arg("ref", `cli-${Date.now()}`),
            amountSats: Number(arg("sats", "25000")),
            network: arg("network", "bitcoin"),
            apiBaseUrl: arg("cosigner", process.env.NURI_COSIGNER_URL || "https://arkade.nuri.com/v4"),
            journal,
        });
        print({ order_id: order.order_id, deposit, risk, reconstruction_terms: order.reconstruction_terms });
    } else if (command === "check") {
        const esplora = createEsploraClient({
            baseUrl: arg("esplora", process.env.ESPLORA_URL || "https://blockstream.info/api"),
        });
        const { receipt, replay } = await validateDeposit({
            orderId: arg("order"),
            txid: arg("txid"),
            vout: Number(arg("vout", "0")),
            journal,
            esplora,
        });
        print({ replay, receipt });
    } else if (command === "show") {
        const order = journal.get(arg("order"));
        if (!order) throw new Error("unknown order");
        print(order);
    } else {
        throw new Error("usage: create | check | show");
    }
} finally {
    journal.close();
}
