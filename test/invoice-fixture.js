// Minimal BOLT11 encoder for tests. Only what decodeMainnetInvoice reads:
// network prefix, whole-sat amount, timestamp, expiry, payment hash.
// The 65-byte signature is filler: light-bolt11-decoder does not verify it.
// BOLT11 packs the data part as a 5-bit *bitstream* (10-bit tag+length header),
// so this writes bits, not symbols.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";

class Bits {
  constructor() { this.acc = 0; this.bits = 0; this.out = []; }
  write(value, count) {
    for (let i = count - 1; i >= 0; i -= 1) {
      this.acc = (this.acc << 1) | ((value >>> i) & 1);
      this.bits += 1;
      if (this.bits === 5) { this.out.push(this.acc); this.acc = 0; this.bits = 0; }
    }
  }
  bytes(buffer) { for (const byte of buffer) this.write(byte, 8); }
  pad() { if (this.bits) { this.out.push(this.acc << (5 - this.bits)); this.acc = 0; this.bits = 0; } }
  tag(type, payload) {
    this.write(type, 5);
    this.write(Math.ceil((payload.length * 8) / 5), 10); // 10-bit word count
    this.bytes(payload);
    this.pad(); // fields occupy whole 5-bit words
  }
  flush() { if (this.bits) this.out.push(this.acc << (5 - this.bits)); return this.out; }
}

export function makeInvoice({ amountSats, paymentHash, timestamp, expiry = 3600 }) {
  const bits = new Bits();
  bits.write(timestamp, 35);
  bits.tag(1, Buffer.from(paymentHash, "hex"));
  bits.tag(13, Buffer.from("nuri test", "utf8"));
  const expiryBytes = Buffer.alloc(4);
  expiryBytes.writeUInt32BE(expiry);
  bits.tag(6, expiryBytes);
  bits.bytes(Buffer.concat([Buffer.alloc(64, 7), Buffer.from([0])])); // 104 words
  const hrp = `lnbc${amountSats / 100}u`; // 1u = 100 sats, BOLT11 amounts are BTC-based
  return bech32.encode(hrp, bits.flush(), 2048);
}

export function paymentHashFor(seed) {
  return createHash("sha256").update(`nuri-test-invoice:${seed}`).digest("hex");
}

// Real keys so amounts/prefix come from the same library the driver decodes with.
export const testKeys = {
  clientPk33: Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true)).toString("hex"),
  serverPk33: Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true)).toString("hex"),
};
