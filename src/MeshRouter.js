/**
 * MeshRouter — flood routing engine for LAC Mesh
 *
 * Implements managed flooding with:
 *   - TTL-based hop limiting
 *   - msg_id deduplication (no relay loops)
 *   - Store-and-forward queue (deliver when peer reconnects)
 *   - Per-peer message queue with expiry
 *
 * Routing strategy: "lazy flood"
 *   When a packet arrives → verify sig → dedup check →
 *   if for me: deliver to app. Also relay if ttl > 1 (unless it came from direct sender).
 *   This ensures delivery even when the recipient isn't directly reachable.
 */

import { MeshDedup } from './MeshDedup.js'
import { MeshCrypto } from './MeshCrypto.js'
import { MeshPacket, PacketType } from './MeshPacket.js'

const STORE_TTL_MS     = 12 * 60 * 60 * 1000  // store undelivered msgs 12h (same as Bitchat)
const MAX_QUEUE_SIZE   = 200                    // max stored packets per node

export class MeshRouter {
  /**
   * @param {object} opts
   * @param {MeshCrypto}  opts.crypto      - this node's identity
   * @param {Function}    opts.onDeliver   - callback(MeshPacket) when msg is for us
   * @param {Function}    opts.onRelay     - callback(MeshPacket) to transmit via transport
   * @param {Function}    [opts.onPing]    - callback(peerPubkey) when peer announces presence
   * @param {object}      [opts.dedup]     - MeshDedup options
   */
  constructor({ crypto, onDeliver, onRelay, onPing, dedup = {} }) {
    this.crypto     = crypto
    this.onDeliver  = onDeliver
    this.onRelay    = onRelay
    this.onPing     = onPing || (() => {})
    this._dedup     = new MeshDedup(dedup)

    // Store-and-forward: Map<peerPubkeyHex, MeshPacket[]>
    this._queue     = new Map()

    // Known peers: Map<peerPubkeyHex, { lastSeen: ts, online: bool }>
    this._peers     = new Map()
  }

  /**
   * Process an incoming packet from transport layer.
   * @param {string} rawJson - serialized MeshPacket
   * @param {string} [fromPeer] - BLE device ID (optional, for logging)
   */
  receive(rawJson, fromPeer = null) {
    let packet
    try {
      packet = MeshPacket.deserialize(rawJson)
    } catch {
      return  // malformed — drop silently
    }

    // 1. Dedup check
    if (this._dedup.seen(packet.msg_id)) return

    // 2. Signature verification — drop unsigned or invalid
    if (!packet.sig) return
    if (!MeshCrypto.verify(packet.sigBody, packet.sig, packet.from)) return

    // 3. Handle by type
    switch (packet.type) {
      case PacketType.PING:
        this._handlePing(packet)
        break
      case PacketType.ACK:
        this._handleAck(packet)
        break
      case PacketType.MSG:
      case PacketType.BCAST:
        this._handleMessage(packet)
        break
    }
  }

  /**
   * Create and route an outgoing message.
   * @param {object} opts
   * @param {string}  opts.payload   - base64 encrypted payload
   * @param {string}  [opts.to]      - recipient pubkey hex (null = broadcast)
   * @param {number}  [opts.ttl]
   * @returns {MeshPacket}
   */
  send({ payload, to = null, ttl }) {
    const packet = new MeshPacket({
      type:    to ? PacketType.MSG : PacketType.BCAST,
      from:    this.crypto.publicKeyHex,
      to,
      payload,
      ttl,
    })

    packet.sig = this.crypto.sign(packet.sigBody)
    this._dedup.mark(packet.msg_id)  // don't relay our own packet back
    this.onRelay(packet)
    return packet
  }

  /**
   * Send a PING to announce our presence to nearby nodes.
   */
  ping() {
    const packet = new MeshPacket({
      type:    PacketType.PING,
      from:    this.crypto.publicKeyHex,
      payload: '',
    })
    packet.sig = this.crypto.sign(packet.sigBody)
    this._dedup.mark(packet.msg_id)
    this.onRelay(packet)
  }

  /**
   * Called when a peer connects — flush any queued packets for them.
   * @param {string} peerPubkeyHex
   */
  peerConnected(peerPubkeyHex) {
    this._updatePeer(peerPubkeyHex, true)
    this._flushQueue(peerPubkeyHex)
  }

  /** Called when a peer disconnects */
  peerDisconnected(peerPubkeyHex) {
    this._updatePeer(peerPubkeyHex, false)
  }

  /** Current peer count */
  get peerCount() {
    return this._peers.size
  }

  /** Online peer count */
  get onlinePeerCount() {
    return [...this._peers.values()].filter(p => p.online).length
  }

  // ── private ────────────────────────────────────────────────────────────────

  _handlePing(packet) {
    this._updatePeer(packet.from, true)
    this.onPing(packet.from)
    // Relay ping so other nodes learn about this peer too
    if (packet.shouldRelay) this.onRelay(packet.relay())
  }

  _handleAck(packet) {
    // ACK addressed to us: remove from store queue
    if (packet.to === this.crypto.publicKeyHex) {
      this._removeFromQueue(packet.from, packet.payload) // payload = original msg_id
    }
    // Relay ACK toward sender
    else if (packet.shouldRelay) {
      this.onRelay(packet.relay())
    }
  }

  _handleMessage(packet) {
    const forMe = (
      packet.type === PacketType.BCAST ||
      packet.to   === this.crypto.publicKeyHex
    )

    if (forMe) {
      this.onDeliver(packet)

      // Send ACK for direct messages
      if (packet.type === PacketType.MSG) {
        this._sendAck(packet)
      }
    }

    // Relay if ttl allows (even if also for us — helps others receive it)
    if (packet.shouldRelay) {
      const relayed = packet.relay()

      // Store-and-forward: if recipient is known but offline, queue it
      if (packet.to && !this._isPeerOnline(packet.to)) {
        this._enqueue(packet.to, relayed)
      } else {
        this.onRelay(relayed)
      }
    }
  }

  _sendAck(originalPacket) {
    const ack = new MeshPacket({
      type:    PacketType.ACK,
      from:    this.crypto.publicKeyHex,
      to:      originalPacket.from,
      payload: originalPacket.msg_id,  // ack references original msg_id
    })
    ack.sig = this.crypto.sign(ack.sigBody)
    this._dedup.mark(ack.msg_id)
    this.onRelay(ack)
  }

  _updatePeer(pubkeyHex, online) {
    this._peers.set(pubkeyHex, { lastSeen: Date.now(), online })
  }

  _isPeerOnline(pubkeyHex) {
    return this._peers.get(pubkeyHex)?.online === true
  }

  _enqueue(peerPubkeyHex, packet) {
    if (!this._queue.has(peerPubkeyHex)) {
      this._queue.set(peerPubkeyHex, [])
    }
    const q = this._queue.get(peerPubkeyHex)

    // Prune expired and overflow
    const now = Date.now()
    const fresh = q.filter(p => (p.ts + STORE_TTL_MS) > now)
    if (fresh.length >= MAX_QUEUE_SIZE) fresh.shift()  // drop oldest
    fresh.push(packet)
    this._queue.set(peerPubkeyHex, fresh)
  }

  _flushQueue(peerPubkeyHex) {
    const q = this._queue.get(peerPubkeyHex)
    if (!q?.length) return
    for (const packet of q) {
      this.onRelay(packet)
    }
    this._queue.delete(peerPubkeyHex)
  }

  _removeFromQueue(peerPubkeyHex, msgId) {
    const q = this._queue.get(peerPubkeyHex)
    if (!q) return
    this._queue.set(peerPubkeyHex, q.filter(p => p.msg_id !== msgId))
  }
}
