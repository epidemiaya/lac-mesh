/**
 * WifiDirectTransport — WiFi Direct AP+STA transport for LAC Mesh
 *
 * Uses native LacWifiDirect Capacitor plugin (LacWifiDirectPlugin.java).
 * Falls back to LAN WebSocket when native plugin unavailable.
 *
 * Transport modes (auto-detected):
 *   WIFI_DIRECT — native AP+STA, full offline, 100-300m
 *   LAN_WS      — same WiFi WebSocket fallback
 *   MOCK        — dev/test
 */

export const TRANSPORT_MODE = Object.freeze({
  WIFI_DIRECT: 'WIFI_DIRECT',
  LAN_WS:      'LAN_WS',
  MOCK:        'MOCK',
})

const MESH_PORT       = 47731
const RECONNECT_MS    = 5000
const MAX_PEERS       = 10

export class WifiDirectTransport {
  constructor({ onPacket, onPeerFound, onPeerLost, onLog }) {
    this.onPacket    = onPacket
    this.onPeerFound = onPeerFound
    this.onPeerLost  = onPeerLost
    this.onLog       = onLog || (() => {})

    this._mode       = TRANSPORT_MODE.MOCK
    this._plugin     = null
    this._peers      = new Map()
    this._running    = false
  }

  /** Auto-detect best transport and initialize */
  async init() {
    // 1. Try native WiFi Direct plugin
    try {
      const plugin = window.Capacitor?.Plugins?.LacWifiDirect
      if (plugin) {
        this._plugin = plugin
        this._mode   = TRANSPORT_MODE.WIFI_DIRECT
        this.onLog('[Transport] WiFi Direct native plugin found')
        return TRANSPORT_MODE.WIFI_DIRECT
      }
    } catch (e) {
      this.onLog('[Transport] native plugin unavailable: ' + e.message)
    }

    // 2. Fallback: LAN WebSocket (same WiFi)
    this._mode = TRANSPORT_MODE.LAN_WS
    this.onLog('[Transport] fallback — LAN WebSocket mode')
    return TRANSPORT_MODE.LAN_WS
  }

  /** Start transport */
  async start() {
    if (this._running) return
    this._running = true

    if (this._mode === TRANSPORT_MODE.WIFI_DIRECT) {
      await this._startNative()
    } else {
      this.onLog('[Transport] LAN mode — use connectByIp(ip) to connect to peer')
    }
  }

  /** Stop transport */
  async stop() {
    this._running = false
    if (this._plugin) {
      try { await this._plugin.stop() } catch {}
    }
    for (const peer of this._peers.values()) {
      try { peer.ws?.close() } catch {}
    }
    this._peers.clear()
    this.onLog('[Transport] stopped')
  }

  /** Broadcast to all connected peers */
  async broadcast(rawJson) {
    if (this._mode === TRANSPORT_MODE.WIFI_DIRECT) {
      try {
        await this._plugin.broadcast({ data: rawJson })
      } catch (e) {
        this.onLog('[Transport] broadcast error: ' + e.message)
      }
      return
    }

    // LAN WebSocket mode
    for (const [id, peer] of this._peers) {
      try {
        if (peer.ws?.readyState === WebSocket.OPEN) {
          peer.ws.send(rawJson)
        }
      } catch (e) {
        this._removePeer(id)
      }
    }
  }

  /**
   * Connect to peer by local IP (LAN fallback).
   * Use after QR scan showing peer's local IP.
   * @param {string} ip
   */
  connectByIp(ip) {
    const id = 'lan_' + ip
    if (this._peers.has(id)) return

    const ws = new WebSocket(`ws://${ip}:${MESH_PORT}`)
    ws.onopen    = () => {
      this._peers.set(id, { ws, ip })
      this.onPeerFound(id)
      this.onLog('[Transport] connected to ' + ip)
    }
    ws.onmessage = (e) => this.onPacket(e.data)
    ws.onclose   = ()  => this._removePeer(id)
    ws.onerror   = ()  => this.onLog('[Transport] ws error connecting to ' + ip)
  }

  get connectedCount() { return this._peers.size }
  get mode()           { return this._mode }
  get isMock()         { return this._mode === TRANSPORT_MODE.MOCK }

  // ── Native WiFi Direct ────────────────────────────────────────────────────

  async _startNative() {
    // Start plugin — requests permissions + starts discovery + TCP server
    await this._plugin.start()
    this.onLog('[Transport] WiFi Direct started')

    // Listen for events from Java
    this._plugin.addListener('peerFound', (data) => {
      const id = data.address
      if (!this._peers.has(id)) {
        this._peers.set(id, { address: id, name: data.name })
        this.onPeerFound(id)
        this.onLog('[Transport] peer found: ' + data.name + ' @ ' + id)
      }
    })

    this._plugin.addListener('peerLost', (data) => {
      this._removePeer(data.address)
    })

    this._plugin.addListener('packet', (data) => {
      this.onPacket(data.data)
    })

    this._plugin.addListener('connected', (data) => {
      this.onLog('[Transport] group formed — owner=' + data.groupOwnerIp +
                 ' isOwner=' + data.isGroupOwner)
    })

    this._plugin.addListener('disconnected', () => {
      this.onLog('[Transport] WiFi P2P disconnected')
    })

    this._plugin.addListener('log', (data) => {
      this.onLog('[Java] ' + data.message)
    })
  }

  _removePeer(id) {
    const peer = this._peers.get(id)
    if (peer) {
      try { peer.ws?.close() } catch {}
      this._peers.delete(id)
      this.onPeerLost(id)
      this.onLog('[Transport] peer left: ' + id)
    }
  }
}
