/**
 * BleTransport — Bluetooth Low Energy transport for LAC Mesh
 *
 * Uses @capacitor-community/bluetooth-le for Android (via Capacitor).
 * Falls back to a mock transport in browser/dev environments.
 *
 * Protocol:
 *   Service UUID:       LAC_SERVICE_UUID  (custom 128-bit)
 *   TX Characteristic:  LAC_TX_UUID       (write without response)
 *   RX Characteristic:  LAC_RX_UUID       (notify)
 *
 * Flow:
 *   1. startAdvertising() — broadcast our presence with LAC service UUID
 *   2. startScanning()    — discover peers advertising LAC service UUID
 *   3. On peer found      → connect → subscribe RX → flush pending packets
 *   4. On packet ready    → write to TX characteristic of all connected peers
 *   5. On notify          → decode packet → pass to MeshRouter
 *
 * BLE MTU is typically 20-512 bytes. We fragment at 512 bytes (MeshPacket.MAX_BYTES).
 * For larger future payloads, chunking support can be added here.
 */

// LAC Mesh BLE identifiers — globally unique
export const LAC_SERVICE_UUID = '4c414300-0000-1000-8000-00805f9b34fb'  // "LAC\0..."
export const LAC_TX_UUID      = '4c414301-0000-1000-8000-00805f9b34fb'
export const LAC_RX_UUID      = '4c414302-0000-1000-8000-00805f9b34fb'

const SCAN_TIMEOUT_MS    = 10_000   // re-scan every 10s
const CONNECT_TIMEOUT_MS =  5_000
const MAX_CONNECTIONS    =     10   // simultaneous BLE connections

export class BleTransport {
  /**
   * @param {object} opts
   * @param {Function} opts.onPacket     - callback(rawJson: string) when packet received
   * @param {Function} opts.onPeerFound  - callback(deviceId: string)
   * @param {Function} opts.onPeerLost   - callback(deviceId: string)
   * @param {Function} [opts.onLog]      - debug logger
   */
  constructor({ onPacket, onPeerFound, onPeerLost, onLog }) {
    this.onPacket    = onPacket
    this.onPeerFound = onPeerFound
    this.onPeerLost  = onPeerLost
    this.onLog       = onLog || (() => {})

    this._ble         = null   // BleClient instance
    this._connected   = new Map()  // deviceId → true
    this._scanTimer   = null
    this._running     = false
    this._isMock      = false
  }

  /**
   * Initialize BLE. Detects Capacitor or falls back to mock.
   * @returns {Promise<boolean>} true if real BLE available
   */
  async init() {
    try {
      const { BleClient } = await import('@capacitor-community/bluetooth-le')
      await BleClient.initialize({ androidNeverForLocation: true })
      this._ble    = BleClient
      this._isMock = false
      this.onLog('[BLE] initialized — real hardware')
      return true
    } catch {
      this._ble    = createMockBle(this.onLog)
      this._isMock = true
      this.onLog('[BLE] initialized — mock mode (browser/dev)')
      return false
    }
  }

  /** Start advertising + scanning */
  async start() {
    if (this._running) return
    this._running = true

    await this._startAdvertising()
    await this._startScan()
    this.onLog('[BLE] transport started')
  }

  /** Stop all BLE activity */
  async stop() {
    this._running = false
    clearTimeout(this._scanTimer)

    try { await this._ble.stopLEScan() } catch {}
    try { await this._ble.stopAdvertising() } catch {}

    for (const deviceId of this._connected.keys()) {
      try { await this._ble.disconnect(deviceId) } catch {}
    }
    this._connected.clear()
    this.onLog('[BLE] transport stopped')
  }

  /**
   * Send a raw JSON packet to all connected peers.
   * @param {string} rawJson
   */
  async broadcast(rawJson) {
    if (!this._connected.size) {
      this.onLog('[BLE] broadcast — no peers connected')
      return
    }

    const data = textToDataView(rawJson)

    for (const deviceId of this._connected.keys()) {
      try {
        await this._ble.writeWithoutResponse(deviceId, LAC_SERVICE_UUID, LAC_TX_UUID, data)
        this.onLog(`[BLE] → ${deviceId.slice(0, 8)} (${rawJson.length}b)`)
      } catch (e) {
        this.onLog(`[BLE] write failed to ${deviceId.slice(0, 8)}: ${e.message}`)
        this._disconnect(deviceId)
      }
    }
  }

  /** Currently connected peer count */
  get connectedCount() {
    return this._connected.size
  }

  /** Is running in mock/browser mode? */
  get isMock() {
    return this._isMock
  }

  // ── private ───────────────────────────────────────────────────────────────

  async _startAdvertising() {
    try {
      await this._ble.startAdvertising({
        services:     [LAC_SERVICE_UUID],
        localName:    'LAC-mesh',
        connectable:  true,
      })
      this.onLog('[BLE] advertising started')
    } catch (e) {
      this.onLog(`[BLE] advertising failed: ${e.message}`)
    }
  }

  async _startScan() {
    if (!this._running) return

    try {
      await this._ble.requestLEScan(
        { services: [LAC_SERVICE_UUID], allowDuplicates: false },
        (result) => this._onScanResult(result)
      )
      this.onLog('[BLE] scanning...')
    } catch (e) {
      this.onLog(`[BLE] scan failed: ${e.message}`)
    }

    // Re-scan after timeout (BLE scan has system time limits)
    this._scanTimer = setTimeout(async () => {
      try { await this._ble.stopLEScan() } catch {}
      this._startScan()
    }, SCAN_TIMEOUT_MS)
  }

  async _onScanResult(result) {
    const deviceId = result.device.deviceId
    if (this._connected.has(deviceId)) return
    if (this._connected.size >= MAX_CONNECTIONS) return

    this.onLog(`[BLE] found peer: ${deviceId.slice(0, 8)}`)
    await this._connect(deviceId)
  }

  async _connect(deviceId) {
    try {
      await this._ble.connect(deviceId, () => this._disconnect(deviceId), {
        timeout: CONNECT_TIMEOUT_MS,
      })

      // Subscribe to RX notifications
      await this._ble.startNotifications(
        deviceId,
        LAC_SERVICE_UUID,
        LAC_RX_UUID,
        (data) => {
          const json = dataViewToText(data)
          this.onLog(`[BLE] ← ${deviceId.slice(0, 8)} (${json.length}b)`)
          this.onPacket(json)
        }
      )

      this._connected.set(deviceId, true)
      this.onPeerFound(deviceId)
      this.onLog(`[BLE] connected: ${deviceId.slice(0, 8)} (total: ${this._connected.size})`)

    } catch (e) {
      this.onLog(`[BLE] connect failed ${deviceId.slice(0, 8)}: ${e.message}`)
    }
  }

  _disconnect(deviceId) {
    this._connected.delete(deviceId)
    this.onPeerLost(deviceId)
    this.onLog(`[BLE] disconnected: ${deviceId.slice(0, 8)}`)
    try { this._ble.disconnect(deviceId) } catch {}
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function textToDataView(text) {
  const bytes = new TextEncoder().encode(text)
  return new DataView(bytes.buffer)
}

function dataViewToText(dataView) {
  return new TextDecoder().decode(dataView.buffer)
}

/**
 * Mock BLE for browser/dev — emits no events, logs everything.
 * Replace with a local UDP socket mock for integration testing.
 */
function createMockBle(log) {
  return {
    initialize:         async () => {},
    startAdvertising:   async () => { log('[MOCK-BLE] advertising') },
    stopAdvertising:    async () => {},
    requestLEScan:      async () => { log('[MOCK-BLE] scanning (no real hardware)') },
    stopLEScan:         async () => {},
    connect:            async () => {},
    disconnect:         async () => {},
    startNotifications: async () => {},
    writeWithoutResponse: async () => { log('[MOCK-BLE] write (noop)') },
  }
}
