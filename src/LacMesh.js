/**
 * LacMesh — main entry point for the LAC offline mesh transport
 *
 * Orchestrates WifiDirectTransport + MeshRouter + MeshCrypto into a single
 * easy-to-use API. Designed to drop into any LAC client with minimal
 * changes — just 3 lines in App.jsx.
 *
 * Transport priority:
 *   1. WiFi Direct AP+STA  — full offline mesh, 100-300m, 300Mbps
 *   2. LAN UDP broadcast   — same WiFi fallback, works in PWA
 *   3. Mock                — dev/test mode
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
 *   // In App.jsx sendMessage():
 *   if (wsConnected) sendWS(msg)
 *   else mesh.send({ to: recipientPubkey, payload: base64payload })
 */

import { MeshCrypto }          from './MeshCrypto.js'
import { MeshRouter }          from './MeshRouter.js'
import { WifiDirectTransport, TRANSPORT_MODE } from './WifiDirectTransport.js'
import { PacketType }          from './MeshPacket.js'

export { MeshCrypto, MeshRouter, WifiDirectTransport, PacketType, TRANSPORT_MODE }

export const MeshStatus = Object.freeze({
  STOPPED:      'STOPPED',
  STARTING:     'STARTING',
  IDLE:         'IDLE',        // running, no peers
  CONNECTED:    'CONNECTED',   // running, ≥1 peer
  NO_WIFI:      'NO_WIFI',
})

export class LacMesh {
  /**
   * @param {object} opts
   * @param {Function}  opts.onMessage   - callback({ from, to, payload, ts, msg_id })
   * @param {Function}  [opts.onStatus]  - callback(MeshStatus, { peers, mode })
   * @param {Function}  [opts.onPeer]    - callback({ id, event: 'join'|'leave' })
   * @param {Function}  [opts.onLog]     - debug log callback(string)
   * @param {string}    [opts.pubkeyHex] - existing LAC pubkey (reuse identity)
   * @param {string}    [opts.seckeyHex] - existing LAC seckey (reuse identity)
   * @param {object}    [opts.dedup]     - MeshDedup options
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

    // Identity: reuse existing LAC keypair or generate fresh
    this.crypto = (pubkeyHex && seckeyHex)
      ? MeshCrypto.fromHex(pubkeyHex, seckeyHex)
      : MeshCrypto.generate()

    this._log(`[LacMesh] identity: ${this.crypto.publicKeyHex.slice(0, 16)}…`)

    this._transport = new WifiDirectTransport({
      onPacket:    (json)     => this._router.receive(json),
      onPeerFound: (id)       => this._onPeerFound(id),
      onPeerLost:  (id)       => this._onPeerLost(id),
      onLog:       (msg)      => this._log(msg),
    })

    this._router = new MeshRouter({
      crypto:    this.crypto,
      dedup,
      onDeliver: (packet) => this._onDeliver(packet),
      onRelay:   (packet) => this._transmit(packet),
      onPing:    (pubkey) => this._log(`[LacMesh] ping from ${pubkey.slice(0, 16)}…`),
    })

    this._status = MeshStatus.STOPPED
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Initialize and start mesh transport */
  async start() {
    this._setStatus(MeshStatus.STARTING)
    const mode = await this._transport.init()
    this._log(`[LacMesh] transport mode: ${mode}`)

    await this._transport.start()
    this._router.ping()
    this._setStatus(MeshStatus.IDLE)
    this._log('[LacMesh] started')
    return mode
  }

  /** Stop mesh transport */
  async stop() {
    await this._transport.stop()
    this._setStatus(MeshStatus.STOPPED)
  }

  /**
   * Send a message over the mesh.
   * @param {object} opts
   * @param {string}  opts.payload  - base64 encrypted payload
   * @param {string}  [opts.to]     - recipient pubkey hex (null = broadcast)
   * @param {number}  [opts.ttl]    - override default TTL
   * @returns {string} msg_id
   */
  send({ payload, to = null, ttl } = {}) {
    const packet = this._router.send({ payload, to, ttl })
    this._log(`[LacMesh] sent ${packet.msg_id.slice(0, 8)}…`)
    return packet.msg_id
  }

  /** Announce presence to nearby nodes */
  ping() { this._router.ping() }

  /**
   * Connect to peer by local IP (LAN fallback mode).
   * Use when both devices on same WiFi — e.g. after QR scan.
   * @param {string} ip
   */
  connectByIp(ip) { this._transport.connectByIp?.(ip) }

  /** This node's public key (hex) */
  get pubkey()     { return this.crypto.publicKeyHex }

  /** Current mesh status */
  get status()     { return this._status }

  /** Number of connected peers */
  get peerCount()  { return this._transport.connectedCount }

  /** Current transport mode */
  get mode()       { return this._transport.mode }

  /** Export keypair for persistent storage */
  exportIdentity() { return this.crypto.toHex() }

  // ── Private ────────────────────────────────────────────────────────────────

  _transmit(packet) {
    try { this._transport.broadcast(packet.serialize()) }
    catch (e) { this._log(`[LacMesh] transmit error: ${e.message}`) }
  }

  _onDeliver(packet) {
    this._onMessage({
      msg_id:  packet.msg_id,
      from:    packet.from,
      to:      packet.to,
      payload: packet.payload,
      ts:      packet.ts,
      type:    packet.type,
    })
  }

  _onPeerFound(id) {
    this._router.peerConnected(id)
    this._onPeer({ id, event: 'join' })
    this._updateStatus()
    this._router.ping()
  }

  _onPeerLost(id) {
    this._router.peerDisconnected(id)
    this._onPeer({ id, event: 'leave' })
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
    this._onStatus(s, { peers: this.peerCount, mode: this._transport.mode })
  }

  _log(msg) { this._onLog(msg) }
}
