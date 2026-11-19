#!/usr/bin/env node
// L1 collateral order CLI. Read-only against Nuri + Esplora; no keys, no spending.
//
//   node scripts/l1-collateral.js create --client-pk <33-byte hex> --ref order-1 --sats 25000 --invoice lnbc...
//   node scripts/l1-collateral.js check --order <order_id> --txid <hex> --vout 0
//   node scripts/l1-collateral.js front --order <order_id> --txid <hex> --vout 0 \
//        --invoice lnbc... --amount-sats 25000 [--card-config card.json] [--card-db payments.json]
//   node scripts/l1-collateral.js show --order <order_id>
//
// `front` validates the deposit and, only for an unconfirmed non-RBF deposit of
// the exact amount within the due window, pays the bound invoice once through
// the proven CardLightningDriver. Replay never pays twice.
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
            invoice: arg("invoice", process.env.COLLATERAL_INVOICE),
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
    } else if (command === "front") {
        const { frontCollateral, cardDriverPayer } = await import("../src/l1-front.js");
        const { CardLightningDriver } = await import("../src/driver.js");
        const { Journal } = await import("../src/journal.js");
        const { SwapKitV2Client } = await import("../src/swapkit.js");
        const { ProductionCardWallet } = await import("../src/card-wallet.js");
        const { readFile } = await import("node:fs/promises");
        const { dirname, resolve } = await import("node:path");
        const configPath = resolve(arg("card-config", process.env.CARD_CONFIG || "config/card-mainnet.example.json"));
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const cardDb = resolve(arg("card-db", process.env.CARD_DB || ".data/payments.journal.json"));
        const driverJournal = new Journal(cardDb);
        const driver = new CardLightningDriver({
            config,
            journal: driverJournal,
            swapKit: new SwapKitV2Client({ url: config.swapKitUrl }),
            walletFactory: () => ProductionCardWallet.create(config, dirname(cardDb)),
        });
        const esplora = createEsploraClient({
            baseUrl: arg("esplora", process.env.ESPLORA_URL || "https://blockstream.info/api"),
        });
        const result = await frontCollateral({
            orderId: arg("order"),
            txid: arg("txid"),
            vout: Number(arg("vout", "0")),
            invoice: arg("invoice"),
            amountSats: Number(arg("amount-sats")),
            journal,
            esplora,
            pay: cardDriverPayer(driver),
        });
        print({
            replay: result.replay,
            fronting: result.fronting,
            provider_order_id: result.receipt?.provider_order_id ?? null,
            funding_outpoint: result.receipt?.funding_outpoint ?? null,
            final_status: result.receipt?.final_status ?? null,
            receipt: result.receipt,
        });
        driverJournal.close();
    } else if (command === "show") {
        const order = journal.get(arg("order"));
        if (!order) throw new Error("unknown order");
        print(order);
    } else {
        throw new Error("usage: create | check | front | show");
    }
} finally {
    journal.close();
}
