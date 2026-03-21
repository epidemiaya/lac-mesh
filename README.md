# lac-mesh

```
╔═══════════════════════════════════════════════════════════╗
║  no internet. no servers. no compromise.                  ║
║                                                           ║
║  [phone A] ──BLE──▶ [phone B] ──BLE──▶ [phone C]         ║
║       Ed25519 signed · TTL-routed · store-and-forward     ║
╚═══════════════════════════════════════════════════════════╝
```

**Offline BLE mesh transport layer for [LightAnonChain](https://github.com/epidemiaya/LightAnonChain-).**

Drop-in replacement for WebSocket when the internet is gone. Every packet is Ed25519-signed — the vulnerability that killed Bitchat does not exist here.

[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![part of LAC](https://img.shields.io/badge/part_of-LightAnonChain-purple.svg)](https://github.com/epidemiaya/LightAnonChain-)
[![platform Android](https://img.shields.io/badge/platform-Android-green.svg)]()

---

## Why this exists

When governments cut the internet, your messages stop. Signal goes dark. Telegram goes dark. Everything that relies on a central server goes dark.

LAC Mesh doesn't.

Messages travel device-to-device over Bluetooth Low Energy, hopping through anyone running the app until they reach their destination — or get stored on nearby nodes until the recipient comes back online.

No towers. No routers. No cloud. No accounts. Just physics.

---

## How it compares

|                        | Bitchat | Briar | **lac-mesh**         |
|------------------------|---------|-------|----------------------|
| Transport              | BLE     | BLE   | **BLE + WiFi Direct*** |
| Signature scheme       | ❌ broken | Ed25519 | **Ed25519**      |
| Post-quantum ready     | ❌       | ❌     | **Kyber-768 compatible** |
| Store-and-forward      | ✅      | ✅    | **✅**               |
| Blockchain integration | ❌       | ❌     | **✅ LAC UTXO**      |
| Open source            | ✅      | ✅    | **✅**               |
| iOS support            | partial | partial | Android-first      |

*WiFi Direct coming in v0.2*

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    LacMesh (API)                     │
├──────────────────────┬──────────────────────────────┤
│    MeshRouter        │       MeshCrypto              │
│  flood routing       │  Ed25519 sign/verify          │
│  store-and-forward   │  key import from LAC node     │
│  TTL management      │  Kyber-768 compatible         │
├──────────────────────┴──────────────────────────────┤
│                  MeshDedup                           │
│         seen{} · loop prevention · 10min TTL        │
├─────────────────────────────────────────────────────┤
│                  BleTransport                        │
│    Capacitor BLE · scan · advertise · GATT notify   │
│    mock fallback for browser/dev                     │
└─────────────────────────────────────────────────────┘
```

### Packet format

```json
{
  "msg_id":  "550e8400-e29b-41d4-a716-446655440000",
  "type":    "MSG",
  "from":    "a1b2c3d4...",
  "to":      "e5f6a7b8...",
  "payload": "<base64 encrypted>",
  "ttl":     5,
  "ts":      1720000000000,
  "sig":     "<Ed25519 base64>"
}
```

Max size: **512 bytes** (BLE MTU safe). Payload is whatever LAC encrypts — `lac-mesh` is transport-only and never touches plaintext.

### Routing

Managed flood routing with TTL (default 5 hops, max 7):

```
A sends MSG(ttl=5) → B receives, delivers if for B, relays MSG(ttl=4)
                   → C receives, delivers if for C, relays MSG(ttl=3)
                   → D receives (ttl=2), relays further...
```

Deduplication by `msg_id` — each node remembers seen IDs for 10 minutes. No relay loops.

### Store-and-forward

If the recipient is known but offline, the packet is queued locally for up to **12 hours**. When the recipient reconnects to the mesh, queued packets flush automatically.

---

## Installation

```bash
# In your LAC mobile project:
npm install lac-mesh

# Capacitor dependencies (for native Android BLE):
npm install @capacitor/core @capacitor-community/bluetooth-le
npx cap sync android
```

### Android permissions

Add to `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- BLE scanning -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />

<!-- Required for Android 9 and below -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

---

## Usage

### Basic — 3 lines in App.jsx

```js
import { LacMesh } from 'lac-mesh'

const mesh = new LacMesh({
  onMessage: (msg) => handleIncoming(msg),
  onStatus:  (status, { peers }) => updateStatusBar(status, peers),

  // Reuse existing LAC keypair (no second identity):
  pubkeyHex: lacNode.publicKey,
  seckeyHex: lacNode.secretKey,
})

await mesh.start()
```

### Hybrid transport (WebSocket + Mesh fallback)

```js
// In your sendMessage() function — zero changes to lac_node.py:

function sendMessage(msg) {
  const payload = encryptPayload(msg)  // your existing LAC encryption

  if (wsConnected) {
    ws.send(JSON.stringify({ to: msg.to, payload }))
  } else {
    // Internet gone — fall back to mesh:
    mesh.send({ to: msg.to, payload })
  }
}
```

### Full options

```js
const mesh = new LacMesh({
  // Required:
  onMessage: ({ msg_id, from, to, payload, ts, type }) => { /* ... */ },

  // Optional:
  onStatus:  (status, meta) => console.log(status, meta.peers),
  onPeer:    ({ id, event }) => console.log(`peer ${event}: ${id}`),
  onLog:     (msg) => console.debug(msg),

  // Identity — reuse LAC keypair or leave empty to generate:
  pubkeyHex: '...',
  seckeyHex: '...',

  // Dedup tuning:
  dedup: {
    ttl_ms:   10 * 60 * 1000,  // remember msg IDs for 10 min
    max_size:  2000,            // max tracked IDs
  },
})
```

### Status values

```js
import { MeshStatus } from 'lac-mesh'

MeshStatus.STOPPED       // not started
MeshStatus.STARTING      // initializing BLE
MeshStatus.IDLE          // running, no peers nearby
MeshStatus.CONNECTED     // running, ≥1 peer in range
MeshStatus.NO_BLUETOOTH  // BLE unavailable on this device
```

---

## Run the demo

```bash
git clone https://github.com/epidemiaya/lac-mesh
cd lac-mesh
npm install
node example/demo.js
```

Expected output:
```
═══════════════════════════════════════
  LAC Mesh — demo (direct router test)
═══════════════════════════════════════

Alice: a1b2c3d4e5f6a7b8c9d0e1f2...
Bob:   f0e1d2c3b4a5968778695a4b...

Test 1: Alice → Bob (direct message)
─────────────────────────────────────
📩 Bob received: payload="hello-from-alice"

Test 2: Alice broadcast to all nodes
─────────────────────────────────────
📩 Bob received: payload="broadcast-from-alice"
📩 Alice received: payload="broadcast-from-alice"

Test 3: Dedup — replay attack prevention
─────────────────────────────────────────
   Delivered: 1 time(s) (expected: 1)

Test 4: Invalid signature → drop
──────────────────────────────────
   Delivered: 0 time(s) (expected: 0 — invalid sig dropped)

═══════════════════════════════════════
  Total delivered: 4
  All tests passed ✓
═══════════════════════════════════════
```

---

## BLE Service UUIDs

LAC Mesh uses globally unique 128-bit UUIDs:

```
Service:         4c414300-0000-1000-8000-00805f9b34fb
TX (write):      4c414301-0000-1000-8000-00805f9b34fb
RX (notify):     4c414302-0000-1000-8000-00805f9b34fb
```

`4c4143` = `LAC` in ASCII. Unique per project — no collision with Bitchat or any other app.

---

## Roadmap

- [x] v0.1 — BLE transport + flood routing + store-and-forward
- [ ] v0.2 — WiFi Direct support (10× range, 300× speed)
- [ ] v0.3 — Kyber-768 post-quantum handshake for session keys
- [ ] v0.4 — Cover traffic (decoy messages to mask real activity)
- [ ] v0.5 — USB relay bridge (device acts as mesh extender via USB)

---

## Part of the LAC ecosystem

```
epidemiaya/LightAnonChain-    ← core blockchain node
epidemiaya/lac-mesh           ← this module
epidemiaya/nagini-protocol    ← geographic secret distribution
```

---

## License

MIT — use it, fork it, build on it.

---

*"The network is the people."*
