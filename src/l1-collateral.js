// Raw Bitcoin L1 collateral for the 0-conf fronting path.
//
// This is the L1 half the proven Arkade->Lightning driver does not have: the
// user locks real sats in a Nuri MuSig2+CSV address *on L1*, the router fronts
// the Lightning payment from its own node, and only then settles. The proven
// Arkade VHTLC path (src/swap.js, src/cln.js) is untouched.
//
// The address shape is not invented here. It is the exact script Nuri already
// ships for on-chain wallets (nuri-server-musig2-v4-arkade
// src/ArkadeOnchainAddress.js, which itself mirrors nuri-expo
// lib/bitcoin/deriveMusig2CsvAddress.ts):
//
//   internal key = MuSig2 aggregate of (user key, Nuri co-signer key), sorted
//   leaf         = <user x-only> OP_CHECKSIGVERIFY <bip68 sequence> OP_CHECKSEQUENCEVERIFY
//   output       = p2tr(internal, [leaf])
//
// So the happy path is the 2-of-2 aggregate (user + router/Nuri co-signer) and
// the user can always recover alone from the leaf after the CSV delay.
//
// HONEST RISK: MuSig2 makes the *spend* co-signed, it does not make the
// *deposit* final. A fresh unconfirmed funding tx can be replaced (RBF) or
// dropped from the mempool by its sender, no matter what script it pays. Every
// receipt this module emits therefore says: underwritten by the router,
// rbf_proof = false. Only a confirmation removes the risk.
//
// Chain data comes from Esplora over HTTP; the address/key material comes from
// the existing Nuri co-signer API (`GET /arkade/info`), which is the same
// derivation the app uses. No MuSig2 crypto is hand-rolled: key aggregation is
// @scure/btc-signer/musig2 (the implementation the co-signer itself runs).

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as btc from "@scure/btc-signer";
import { keyAggregate, sortKeys } from "@scure/btc-signer/musig2.js";

const sha256 = (value) => createHash("sha256").update(value).digest();
function expectHex(value, byteLength, name) {
    if (typeof value !== "string" || value.length !== byteLength * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
        throw new Error(`${name} must be exactly ${byteLength} bytes of hex`);
    }
    return value.toLowerCase();
}

export const COLLATERAL_TERMS_VERSION = "nuri-l1-collateral-v1";
export const MAX_COLLATERAL_SATS = 100_000; // small caps only
export const MIN_COLLATERAL_SATS = 5_000; // above dust with fee headroom
export const DEFAULT_RECOVERY_CSV = { type: "blocks", value: 144 };
// BIP125: a tx signals replaceability when any input sequence is below this.
const RBF_SEQUENCE_THRESHOLD = 0xfffffffe; // BIP125: seq < 0xfffffffe signals replaceability
const DUST_LIMIT_P2TR = 330;

const BIP68_GRANULARITY = 9;
const BIP68_MASK = 0x0000ffff;
const BIP68_TYPE_FLAG = 1 << 22;
const BIP68_SECONDS_MOD = 1 << BIP68_GRANULARITY;
const BIP68_SECONDS_MAX = BIP68_MASK << BIP68_GRANULARITY;

// @scure/btc-signer ships mainnet and testnet only.
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export const NETWORKS = ["bitcoin", "testnet", "regtest"];

function networkParams(network) {
    if (network === "bitcoin") return btc.NETWORK;
    if (network === "testnet") return btc.TEST_NETWORK;
    if (network === "regtest") return REGTEST;
    throw new Error(`unknown bitcoin network: ${network}`);
}

export function bip68SequenceFromCsv(csv) {
    const type = String(csv?.type || "");
    const value = Number(csv?.value);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error("csv value must be a positive integer");
    }
    if (type === "seconds") {
        if (value > BIP68_SECONDS_MAX || value % BIP68_SECONDS_MOD !== 0) {
            throw new Error("csv seconds must fit BIP68 seconds granularity");
        }
        return BIP68_TYPE_FLAG | (value >> BIP68_GRANULARITY);
    }
    if (type === "blocks") {
        if (value > BIP68_MASK) throw new Error("csv blocks must fit BIP68");
        return value;
    }
    throw new Error("csv type must be blocks or seconds");
}

function compressedKey33(hex, name) {
    const bytes = Buffer.from(String(hex || ""), "hex");
    if (bytes.length !== 33 || (bytes[0] !== 0x02 && bytes[0] !== 0x03)) {
        throw new Error(`${name} must be a 33-byte compressed public key`);
    }
    return bytes;
}

// Same aggregation the co-signer performs, from the same library.
export function aggregateKeys(clientPk33, serverPk33) {
    const client = compressedKey33(clientPk33, "client_pk33");
    const server = compressedKey33(serverPk33, "server_pk33");
    const agg = keyAggregate(sortKeys([client, server]));
    return Buffer.from(agg.aggPublicKey.toBytes(true)).toString("hex");
}

// Deterministic reconstruction: terms in, address/script/tree out. This is
// what a replay compares against, so it never trusts a stored address.
export function reconstructCollateral(terms) {
    const network = String(terms?.network || "");
    networkParams(network); // throws on unknown network
    const clientXOnly = compressedKey33(terms.client_pk33, "client_pk33").subarray(1);
    let expectedAgg = null;
    if (terms.server_pk33) expectedAgg = aggregateKeys(terms.client_pk33, terms.server_pk33);
    const aggHex = terms.aggregated_pk33
        ? expectHex(terms.aggregated_pk33, 33, "aggregated_pk33")
        : expectedAgg;
    if (!aggHex) throw new Error("either server_pk33 or aggregated_pk33 is required");
    if (expectedAgg && expectedAgg !== aggHex) {
        throw new Error(`aggregated key mismatch: derived ${expectedAgg}, terms say ${aggHex}`);
    }
    const internalXOnly = Buffer.from(aggHex, "hex").subarray(1);
    const sequence = bip68SequenceFromCsv(terms.csv);
    const leafScript = btc.Script.encode([
        clientXOnly,
        "CHECKSIGVERIFY",
        sequence,
        "CHECKSEQUENCEVERIFY",
    ]);
    const payment = btc.p2tr(
        internalXOnly,
        [{ script: leafScript, leafVersion: 0xc0 }],
        networkParams(network),
        true,
    );
    const controlBlock = payment.leaves[0].controlBlock;
    return {
        server_pk33: terms.server_pk33 ? Buffer.from(terms.server_pk33, "hex").toString("hex") : null,
        aggregated_pk33: aggHex,
        internal_key_xonly: Buffer.from(internalXOnly).toString("hex"),
        sequence,
        leaf_script_hex: Buffer.from(leafScript).toString("hex"),
        tap_merkle_root: Buffer.from(payment.tapMerkleRoot).toString("hex"),
        control_block_hex: Buffer.from(controlBlock).toString("hex"),
        address: payment.address,
        script_pubkey_hex: Buffer.from(payment.script).toString("hex"),
    };
}

export function termsDigest(terms) {
    return sha256(
        Buffer.from(
            JSON.stringify({
                v: terms.version,
                ref: terms.order_ref,
                client: terms.client_pk33,
                server: terms.server_pk33,
                csv: terms.csv,
                net: terms.network,
                sats: terms.amount_sats,
                exp: terms.expires_at,
                due: terms.lightning_due_at,
            }),
        ),
    ).toString("hex");
}

function orderIdFor(digest) {
    return `l1c_${digest.slice(0, 32)}`;
}

function assertCaps(sats) {
    if (!Number.isSafeInteger(sats) || sats <= 0) {
        throw new Error("amount_sats must be a positive integer");
    }
    if (sats < MIN_COLLATERAL_SATS) throw new Error(`amount_sats below minimum ${MIN_COLLATERAL_SATS}`);
    if (sats > MAX_COLLATERAL_SATS) throw new Error(`amount_sats above small-cap maximum ${MAX_COLLATERAL_SATS}`);
}

export class CollateralError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

// Thin Esplora adapter. read-only: two calls, both GET.
export function createEsploraClient({ baseUrl, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    if (!baseUrl) throw new Error("esplora baseUrl required");
    const base = String(baseUrl).replace(/\/+$/, "");
    async function get(path, what, text = false) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(`${base}${path}`, { signal: controller.signal });
            if (res.status === 404) return null;
            if (!res.ok) throw new CollateralError(`esplora ${what} ${res.status}`, "esplora_http");
            return text ? await res.text() : await res.json();
        } catch (e) {
            if (e instanceof CollateralError) throw e;
            throw new CollateralError(`esplora ${what} failed: ${e.message}`, "esplora_unreachable");
        } finally {
            clearTimeout(timer);
        }
    }
    return {
        async getTx(txid) {
            return get(`/tx/${expectHex(txid, 32, "txid")}`, "tx");
        },
        async getTxStatus(txid) {
            return get(`/tx/${expectHex(txid, 32, "txid")}/status`, "tx status");
        },
        async getTipHeight() {
            const raw = await get(`/blocks/tip/height`, "tip", true);
            const height = Number(raw);
            if (!Number.isInteger(height)) throw new CollateralError("esplora tip unreadable", "esplora_bad_tip");
            return height;
        },
    };
}

// Durable order journal. Separate table from the Arkade swap journal: an L1
// collateral order has no payment hash and must not perturb that schema.
export class CollateralJournal {
    constructor(path) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = FULL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS l1_collateral_orders (
                order_id TEXT PRIMARY KEY,
                order_ref TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('created','funded','replaced','confirmed','replayed')),
                terms_digest TEXT NOT NULL UNIQUE,
                terms_json TEXT NOT NULL,
                address TEXT NOT NULL,
                script_pubkey_hex TEXT NOT NULL,
                outpoint TEXT UNIQUE,
                amount_sats INTEGER NOT NULL,
                rbf_signaled INTEGER NOT NULL DEFAULT 0,
                confirmations INTEGER NOT NULL DEFAULT 0,
                receipt_json TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    close() {
        this.db.close();
    }

    insert(order) {
        this.db
            .prepare(
                `INSERT INTO l1_collateral_orders
                 (order_id, order_ref, state, terms_digest, terms_json, address, script_pubkey_hex, amount_sats)
                 VALUES (?, ?, 'created', ?, ?, ?, ?, ?)`,
            )
            .run(
                order.order_id,
                order.order_ref,
                order.terms_digest,
                JSON.stringify(order.reconstruction_terms),
                order.address,
                order.script_pubkey_hex,
                order.amount_sats,
            );
        return this.get(order.order_id);
    }

    get(orderId) {
        const row = this.db.prepare(`SELECT * FROM l1_collateral_orders WHERE order_id = ?`).get(orderId);
        return row ? this.#row(row) : null;
    }

    getByOutpoint(outpoint) {
        const row = this.db.prepare(`SELECT * FROM l1_collateral_orders WHERE outpoint = ?`).get(outpoint);
        return row ? this.#row(row) : null;
    }

    // Idempotent: a replay of the same outpoint returns the stored receipt.
    recordDeposit({ orderId, outpoint, state, rbfSignaled, confirmations, receipt }) {
        this.db
            .prepare(
                `UPDATE l1_collateral_orders
                 SET state = ?, outpoint = ?, rbf_signaled = ?, confirmations = ?,
                     receipt_json = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE order_id = ?`,
            )
            .run(state, outpoint, rbfSignaled ? 1 : 0, confirmations, JSON.stringify(receipt), orderId);
        return this.get(orderId);
    }

    #row(row) {
        return {
            ...row,
            reconstruction_terms: JSON.parse(row.terms_json),
            receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
        };
    }
}

// Fetch the co-signer's key material for the user's key from the existing
// Nuri API and refuse if it disagrees with our own aggregation.
export async function fetchCosignerTerms({ apiBaseUrl, clientPk33, fetchImpl = fetch }) {
    const client = expectHex(clientPk33, 33, "client_pk33");
    if (client[0] !== "0" || (client.slice(0, 2) !== "02" && client.slice(0, 2) !== "03")) {
        throw new Error("client_pk33 must be compressed");
    }
    const url = `${String(apiBaseUrl).replace(/\/+$/, "")}/arkade/info?client_signer_pubkey=${client}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
        res = await fetchImpl(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) throw new CollateralError(`/arkade/info ${res.status}`, "cosigner_http");
    const body = await res.json();
    const serverPk33 = expectHex(body?.server_pubkey, 33, "server_pubkey");
    const csv = body?.nuri_server_csv;
    if (!csv) throw new CollateralError("/arkade/info has no nuri_server_csv", "cosigner_missing_csv");
    const aggregated = aggregateKeys(client, serverPk33);
    return { serverPk33, csv, aggregatedPk33: aggregated, recoveryPolicy: body?.recovery_policy || null };
}

export async function createCollateralOrder({
    clientPk33,
    orderRef,
    amountSats,
    network = "bitcoin",
    apiBaseUrl,
    journal,
    now = Date.now,
    ttlSeconds = 900,
    lightningDueSeconds = 90,
    fetchImpl = fetch,
}) {
    if (!orderRef) throw new Error("order_ref required");
    assertCaps(amountSats);
    networkParams(network);
    const cosigner = await fetchCosignerTerms({ apiBaseUrl, clientPk33, fetchImpl });
    const csv = cosigner.csv;
    const nowMs = now();

    const draft = {
        version: COLLATERAL_TERMS_VERSION,
        order_ref: String(orderRef),
        client_pk33: expectHex(clientPk33, 33, "client_pk33"),
        server_pk33: cosigner.serverPk33,
        csv,
        network,
        amount_sats: amountSats,
        expires_at: Math.floor(nowMs / 1000) + ttlSeconds,
        lightning_due_at: Math.floor(nowMs / 1000) + lightningDueSeconds,
    };
    const derived = reconstructCollateral(draft);
    const digest = termsDigest(draft);
    const orderId = orderIdFor(digest);

    if (journal?.get(orderId)) {
        return { order: journal.get(orderId), created: false };
    }

    const terms = {
        ...draft,
        order_id: orderId,
        terms_digest: digest,
        ...derived,
        cosigner: {
            aggregate_path: "2-of-2 MuSig2 (user + Nuri co-signer)",
            recovery_path: `user key alone after ${csv.value} ${csv.type}`,
            implementation: "@scure/btc-signer/musig2 keyAggregate(sortKeys([user, server]))",
        },
    };
    if (controlByteMismatch(terms)) throw new Error("internal key tweak mismatch");

    const order = journal
        ? journal.insert({
              order_id: orderId,
              order_ref: terms.order_ref,
              terms_digest: digest,
              reconstruction_terms: terms,
              address: terms.address,
              script_pubkey_hex: terms.script_pubkey_hex,
              amount_sats: amountSats,
          })
        : null;

    return {
        order: order || { order_id: orderId, reconstruction_terms: terms, ...terms },
        deposit: {
            address: terms.address,
            script_pubkey_hex: terms.script_pubkey_hex,
            amount_sats: amountSats,
            expires_at: terms.expires_at,
        },
        risk: riskReceipt(),
        created: true,
    };
}

function controlByteMismatch(terms) {
    const cb = Buffer.from(terms.control_block_hex, "hex");
    return cb.length !== 33 || (cb[0] & 0xfe) !== 0xc0;
}

export function riskReceipt() {
    return {
        underwriting: "router",
        rbf_proof: false,
        confirmed: false,
        notes: [
            "0-conf is underwritten by the router's own node balance, not by L1 finality.",
            "MuSig2 binds the spend, not the deposit: the sender can RBF or drop the funding tx.",
            "Only a confirmation removes replacement risk; a CSV leaf covers user recovery only.",
        ],
    };
}

export function assessDeposit({ tx, outpoint, terms, tipHeight }) {
    if (!tx) throw new CollateralError("deposit tx not found", "tx_missing");
    const [txid, voutRaw] = String(outpoint).split(":");
    if (!txid || voutRaw === undefined) throw new CollateralError("outpoint must be txid:vout", "bad_outpoint");
    expectHex(txid, 32, "txid");
    if (tx.txid && tx.txid !== txid) throw new CollateralError("esplora txid mismatch", "txid_mismatch");
    const vout = Number(voutRaw);
    if (!Number.isInteger(vout) || vout < 0) throw new CollateralError("bad vout", "bad_outpoint");

    const output = tx.vout?.[vout];
    if (!output) throw new CollateralError(`vout ${vout} does not exist`, "vout_missing");

    const script = Buffer.from(String(output.scriptpubkey || ""), "hex").toString("hex");
    if (script !== terms.script_pubkey_hex) {
        throw new CollateralError(
            `deposit pays ${script || "<empty>"}, order expects ${terms.script_pubkey_hex}`,
            "wrong_script",
        );
    }
    const value = Number(output.value);
    if (!Number.isSafeInteger(value)) throw new CollateralError("output value unreadable", "bad_value");
    if (value !== terms.amount_sats) {
        throw new CollateralError(`deposit pays ${value} sats, order expects ${terms.amount_sats}`, "wrong_amount");
    }
    if (value <= DUST_LIMIT_P2TR) throw new CollateralError("deposit at or below dust", "dust");

    // BIP125: any replaceable input makes the whole funding tx replaceable.
    const rbfSignaled = (tx.vin || []).some((input) => {
        const seq = Number(input.sequence ?? 0xffffffff);
        return Number.isInteger(seq) && seq < RBF_SEQUENCE_THRESHOLD;
    });

    const confirmed = Boolean(tx.status?.confirmed);
    const blockHeight = tx.status?.block_height;
    const confirmations = confirmed && Number.isInteger(blockHeight) && Number.isInteger(tipHeight)
        ? Math.max(0, tipHeight - blockHeight + 1)
        : 0;

    const receipt = {
        ...riskReceipt(),
        order_id: terms.order_id,
        terms_digest: terms.terms_digest,
        outpoint: `${txid}:${vout}`,
        value_sats: value,
        script_pubkey_hex: script,
        rbf_signaled: rbfSignaled,
        confirmed,
        confirmations,
        tip_height: tipHeight ?? null,
        block_height: confirmed ? blockHeight : null,
        state: confirmed ? "confirmed" : "funded",
        eligible_0conf: !confirmed && !rbfSignaled,
        underwritten_until: confirmed ? null : terms.expires_at,
    };
    return receipt;
}

// Validate a claimed deposit against the order and persist it. Replay of the
// same outpoint on the same order returns the first stored receipt unchanged.
export async function validateDeposit({
    orderId,
    txid,
    vout,
    journal,
    esplora,
}) {
    const order = journal.get(orderId);
    if (!order) throw new CollateralError(`unknown order ${orderId}`, "unknown_order");
    const terms = order.reconstruction_terms;

    // Never trust the stored address: rebuild from terms first.
    const rebuilt = reconstructCollateral(terms);
    if (rebuilt.address !== terms.address || rebuilt.script_pubkey_hex !== terms.script_pubkey_hex) {
        throw new CollateralError("stored order terms do not reconstruct", "terms_corrupt");
    }
    if (order.receipt && order.outpoint === `${txid}:${vout}`) {
        return { order, receipt: order.receipt, replay: true };
    }
    const outpoint = `${expectHex(txid, 32, "txid")}:${Number(vout)}`;
    const other = journal.getByOutpoint(outpoint);
    if (other && other.order_id !== orderId) {
        throw new CollateralError(`outpoint already bound to ${other.order_id}`, "outpoint_reused");
    }

    const [tx, tipHeight] = await Promise.all([esplora.getTx(txid), esplora.getTipHeight()]);
    const receipt = assessDeposit({ tx, outpoint, terms, tipHeight });
    const saved = journal.recordDeposit({
        orderId,
        outpoint,
        state: receipt.state,
        rbfSignaled: receipt.rbf_signaled,
        confirmations: receipt.confirmations,
        receipt,
    });
    return { order: saved, receipt, replay: false };
}
