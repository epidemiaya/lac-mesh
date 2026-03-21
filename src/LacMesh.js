/**
 * LacMesh — main entry point for the LAC offline mesh transport
 *
 * Orchestrates BleTransport + MeshRouter + MeshCrypto into a single
 * easy-to-use API. Designed to drop into any LAC client with minimal
 * changes — just 3 lines in App.jsx.
 *
 * Usage:
 *   import { LacMesh } from 'lac-mesh'
 *
 *   const mesh = new LacMesh({
 *     onMessage: (msg) => renderMessage(msg),
 *     onStatus:  (s)   => updateStatusBar(s),
 *   })
 *
 *   await mesh.start()
 *
 *   // Send (replaces WebSocket send when offline):
 *   mesh.send({ to: recipientPubkey, text: 'hello', encrypted: base64payload })
 *
 *   // In App.jsx sendMessage():
 *   if (wsConnected) sendWS(msg)
 *   else mesh.send(msg)
 */

import { MeshCrypto }  from './MeshCrypto.js'
import { MeshRouter }  from './MeshRouter.js'
import { BleTransport } from './BleTransport.js'
import { PacketType }   from './MeshPacket.js'

export { MeshCrypto, MeshRouter, BleTransport, PacketType }

export const MeshStatus = Object.freeze({
  STOPPED:      'STOPPED',
  STARTING:     'STARTING',
  IDLE:         'IDLE',        // running, no peers
  CONNECTED:    'CONNECTED',   // running, ≥1 peer
  NO_BLUETOOTH: 'NO_BLUETOOTH',
})

export class LacMesh {
  /**
   * @param {object} opts
   * @param {Function}     opts.onMessage     - callback({ from, to, payload, ts, msg_id })
   * @param {Function}     [opts.onStatus]    - callback(MeshStatus, { peers: number })
   * @param {Function}     [opts.onPeer]      - callback({ id, event: 'join'|'leave' })
   * @param {Function}     [opts.onLog]       - debug log callback(string)
   * @param {string}       [opts.pubkeyHex]   - existing LAC pubkey (reuse identity)
   * @param {string}       [opts.seckeyHex]   - existing LAC seckey (reuse identity)
   * @param {object}       [opts.dedup]       - MeshDedup options
   */
  constructor({
    onMessage,
    onStatus  = () => {},
    onPeer    = () => {},
    onLog     = () => {},
    pubkeyHex = null,
    seckeyHex = null,
    dedup     = {},
  }) {
    this._onMessage = onMessage
    this._onStatus  = onStatus
    this._onPeer    = onPeer
    this._onLog     = onLog

    // Identity: use existing LAC keypair or generate fresh
    this.crypto = (pubkeyHex && seckeyHex)
      ? MeshCrypto.fromHex(pubkeyHex, seckeyHex)
      : MeshCrypto.generate()

    this._log(`[LacMesh] identity: ${this.crypto.publicKeyHex.slice(0, 16)}…`)

    // Peer registry: deviceId (BLE) ↔ pubkeyHex (LAC)
    this._bleIdToPubkey = new Map()

    this._transport = new BleTransport({
      onPacket:    (json)     => this._router.receive(json),
      onPeerFound: (deviceId) => this._onPeerFound(deviceId),
      onPeerLost:  (deviceId) => this._onPeerLost(deviceId),
      onLog:       (msg)      => this._log(msg),
    })

    this._router = new MeshRouter({
      crypto:     this.crypto,
      dedup,
      onDeliver:  (packet) => this._onDeliver(packet),
      onRelay:    (packet) => this._transmit(packet),
      onPing:     (pubkey) => this._log(`[LacMesh] ping from ${pubkey.slice(0, 16)}…`),
    })

    this._status = MeshStatus.STOPPED
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialize BLE and start mesh.
   * @returns {Promise<MeshStatus>}
   */
  async start() {
    this._setStatus(MeshStatus.STARTING)
    const hasBle = await this._transport.init()

    if (!hasBle && !this._transport.isMock) {
      this._setStatus(MeshStatus.NO_BLUETOOTH)
      return MeshStatus.NO_BLUETOOTH
    }

    await this._transport.start()
    this._router.ping()  // announce ourselves immediately
    this._setStatus(MeshStatus.IDLE)
    this._log('[LacMesh] started')
    return MeshStatus.IDLE
  }

  /** Stop the mesh transport */
  async stop() {
    await this._transport.stop()
    this._setStatus(MeshStatus.STOPPED)
    this._log('[LacMesh] stopped')
  }

  /**
   * Send a message over the mesh.
   *
   * @param {object} opts
   * @param {string}  opts.payload    - base64 encrypted payload (same as LAC WebSocket msg)
   * @param {string}  [opts.to]       - recipient pubkey hex (null = broadcast)
   * @param {number}  [opts.ttl]      - override default TTL
   * @returns {string} msg_id of sent packet
   */
  send({ payload, to = null, ttl } = {}) {
    const packet = this._router.send({ payload, to, ttl })
    this._log(`[LacMesh] sent ${packet.msg_id.slice(0, 8)}… → ${to ? to.slice(0, 8) + '…' : 'broadcast'}`)
    return packet.msg_id
  }

  /**
   * Convenience: send a ping to announce presence to nearby nodes.
   */
  ping() {
    this._router.ping()
  }

  /** This node's public key (hex) */
  get pubkey() {
    return this.crypto.publicKeyHex
  }

  /** Current mesh status */
  get status() {
    return this._status
  }

  /** Number of currently connected BLE peers */
  get peerCount() {
    return this._transport.connectedCount
  }

  /** Export keypair (to persist between sessions) */
  exportIdentity() {
    return this.crypto.toHex()
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _transmit(packet) {
    try {
      this._transport.broadcast(packet.serialize())
    } catch (e) {
      this._log(`[LacMesh] transmit error: ${e.message}`)
    }
  }

  _onDeliver(packet) {
    this._log(`[LacMesh] deliver ${packet.msg_id.slice(0, 8)}… from ${packet.from.slice(0, 8)}…`)
    this._onMessage({
      msg_id:  packet.msg_id,
      from:    packet.from,
      to:      packet.to,
      payload: packet.payload,
      ts:      packet.ts,
      type:    packet.type,
    })
  }

  _onPeerFound(deviceId) {
    this._router.peerConnected(deviceId)
    this._onPeer({ id: deviceId, event: 'join' })
    this._updateStatus()
    // Send a ping so peer learns our pubkey
    this._router.ping()
  }

  _onPeerLost(deviceId) {
    const pubkey = this._bleIdToPubkey.get(deviceId)
    if (pubkey) this._router.peerDisconnected(pubkey)
    this._bleIdToPubkey.delete(deviceId)
    this._onPeer({ id: deviceId, event: 'leave' })
    this._updateStatus()
  }

  _updateStatus() {
    const s = this._transport.connectedCount > 0
      ? MeshStatus.CONNECTED
      : MeshStatus.IDLE
    this._setStatus(s)
  }

  _setStatus(s) {
    this._status = s
    this._onStatus(s, { peers: this.peerCount })
  }

  _log(msg) {
    this._onLog(msg)
  }
}
