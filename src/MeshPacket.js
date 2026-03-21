/**
 * MeshPacket — wire format for LAC Mesh messages
 *
 * Every packet is a signed JSON object serialized to UTF-8 bytes.
 * Max size: 512 bytes (fits comfortably in BLE MTU after fragmentation).
 *
 * Packet types:
 *   MSG   — encrypted user message (to specific peer)
 *   BCAST — broadcast to all nodes in mesh (public channel)
 *   PING  — node presence announcement
 *   ACK   — delivery acknowledgement
 */

import { v4 as uuidv4 } from 'uuid'

export const PacketType = Object.freeze({
  MSG:   'MSG',
  BCAST: 'BCAST',
  PING:  'PING',
  ACK:   'ACK',
})

export const MAX_TTL     = 7    // max hops
export const DEFAULT_TTL = 5   // default hops
export const MAX_BYTES   = 512  // max serialized size

export class MeshPacket {
  /**
   * Create a new outgoing packet.
   * @param {object} opts
   * @param {string}  opts.type       - PacketType
   * @param {string}  opts.from       - sender pubkey hex
   * @param {string}  [opts.to]       - recipient pubkey hex (null = broadcast)
   * @param {string}  [opts.payload]  - encrypted message payload (base64)
   * @param {number}  [opts.ttl]      - hops remaining
   * @param {string}  [opts.sig]      - Ed25519 signature (set after signing)
   */
  constructor({ type, from, to = null, payload = '', ttl = DEFAULT_TTL, sig = null, msg_id = null, ts = null }) {
    this.msg_id  = msg_id || uuidv4()
    this.type    = type
    this.from    = from
    this.to      = to
    this.payload = payload
    this.ttl     = Math.min(ttl, MAX_TTL)
    this.sig     = sig
    this.ts      = ts || Date.now()
  }

  /**
   * The signable body — everything except `sig` itself.
   */
  get sigBody() {
    return {
      msg_id:  this.msg_id,
      type:    this.type,
      from:    this.from,
      to:      this.to,
      payload: this.payload,
      ttl:     this.ttl,
      ts:      this.ts,
    }
  }

  /**
   * Serialize to JSON string for transmission over BLE.
   * Throws if packet exceeds MAX_BYTES.
   */
  serialize() {
    const json = JSON.stringify({
      ...this.sigBody,
      sig: this.sig,
    })
    if (json.length > MAX_BYTES) {
      throw new Error(`MeshPacket too large: ${json.length} bytes (max ${MAX_BYTES})`)
    }
    return json
  }

  /**
   * Deserialize from JSON string received over BLE.
   * @param {string} json
   * @returns {MeshPacket}
   */
  static deserialize(json) {
    const obj = JSON.parse(json)
    return new MeshPacket(obj)
  }

  /**
   * Return a relay copy with decremented TTL.
   */
  relay() {
    return new MeshPacket({
      ...this.sigBody,
      sig: this.sig,
      ttl: this.ttl - 1,
    })
  }

  /** Is this packet addressed to a specific peer (not broadcast)? */
  get isDirect() {
    return this.to !== null
  }

  /** Should this packet be relayed further? */
  get shouldRelay() {
    return this.ttl > 1
  }

  toString() {
    return `[${this.type}] ${this.msg_id.slice(0, 8)}… from=${this.from.slice(0, 8)}… ttl=${this.ttl}`
  }
}
