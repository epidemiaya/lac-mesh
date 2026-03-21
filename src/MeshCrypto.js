/**
 * MeshCrypto — cryptographic identity and message signing for LAC Mesh
 *
 * Uses Ed25519 (tweetnacl) — same curve as lac_crypto.py on the server.
 * Every mesh packet is signed. Unsigned or invalid packets are dropped silently.
 *
 * Key compatibility: if the user already has a LAC keypair (stored as hex),
 * pass it via `fromHex()` — no new identity needed.
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const nacl = require('tweetnacl')

// Native TextEncoder — Node 18+ and all browsers
const enc = new TextEncoder()

export class MeshCrypto {
  /** Generate a fresh Ed25519 keypair */
  static generate() {
    const kp = nacl.sign.keyPair()
    return new MeshCrypto(kp.publicKey, kp.secretKey)
  }

  /** Restore from hex strings (compatible with LAC Python key format) */
  static fromHex(pubkeyHex, seckeyHex) {
    return new MeshCrypto(hexToBytes(pubkeyHex), hexToBytes(seckeyHex))
  }

  /** Restore from base64 strings */
  static fromBase64(pubkeyB64, seckeyB64) {
    return new MeshCrypto(b64ToBytes(pubkeyB64), b64ToBytes(seckeyB64))
  }

  constructor(publicKey, secretKey) {
    this.publicKey    = publicKey   // Uint8Array 32 bytes
    this.secretKey    = secretKey   // Uint8Array 64 bytes
    this.publicKeyHex = bytesToHex(publicKey)
    this.publicKeyB64 = bytesToB64(publicKey)
  }

  /**
   * Sign a packet sigBody.
   * @param {object} payload - JSON-stringified with sorted keys
   * @returns {string} base64 signature
   */
  sign(payload) {
    const msg = enc.encode(deterministicJSON(payload))
    const sig = nacl.sign.detached(msg, this.secretKey)
    return bytesToB64(sig)
  }

  /**
   * Verify a signature.
   * @param {object} payload
   * @param {string} signatureB64
   * @param {string} senderPubkeyHex
   * @returns {boolean}
   */
  static verify(payload, signatureB64, senderPubkeyHex) {
    try {
      const msg    = enc.encode(deterministicJSON(payload))
      const sig    = b64ToBytes(signatureB64)
      const pubkey = hexToBytes(senderPubkeyHex)
      return nacl.sign.detached.verify(msg, sig, pubkey)
    } catch {
      return false
    }
  }

  /** Export as hex (LAC-compatible) */
  toHex() {
    return { publicKey: this.publicKeyHex, secretKey: bytesToHex(this.secretKey) }
  }

  /** Export as base64 */
  toBase64() {
    return { publicKey: this.publicKeyB64, secretKey: bytesToB64(this.secretKey) }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function deterministicJSON(obj) {
  const sorted = {}
  Object.keys(obj).sort().forEach(k => { sorted[k] = obj[k] })
  return JSON.stringify(sorted)
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i*2, i*2+2), 16)
  return out
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('')
}

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes))
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}
