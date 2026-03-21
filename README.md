# lac-mesh

```
╔═══════════════════════════════════════════════════════════════╗
║  no internet. no servers. no compromise.                      ║
║                                                               ║
║  [phone A — AP] ──WiFi Direct──▶ [phone B — AP+STA]          ║
║                                        ──WiFi Direct──▶ [C]  ║
║       Ed25519 signed · TTL-routed · store-and-forward         ║
╚═══════════════════════════════════════════════════════════════╝
```

**Offline WiFi Direct mesh transport layer for [LightAnonChain](https://github.com/epidemiaya/LightAnonChain-).**

Drop-in replacement for WebSocket when the internet is gone. Messages travel device-to-device over WiFi Direct — no towers, no routers, no cloud.

[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![part of LAC](https://img.shields.io/badge/part_of-LightAnonChain-purple.svg)](https://github.com/epidemiaya/LightAnonChain-)
[![platform Android](https://img.shields.io/badge/platform-Android%209+-green.svg)]()

---

## Why WiFi Direct, not Bluetooth

| | BLE (Bitchat) | **WiFi Direct (LAC Mesh)** |
|---|---|---|
| Range | 30–100m | **100–300m** |
| Speed | ~1 Mbps | **300 Mbps+** |
| iOS support | partial | Android-first |
| Message size | 20–512 bytes | **unlimited** |
| Simultaneous AP+STA | ❌ | **✅ Android 9+** |

WiFi Direct allows a phone to be **both** an Access Point and a Station simultaneously. Phone B connects to Phone A (as client) while also hosting a hotspot for Phone C. This creates a real multi-hop mesh — no router needed.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    LacMesh (API)                         │
├──────────────────────┬──────────────────────────────────┤
│    MeshRouter        │       MeshCrypto                  │
│  flood routing       │  Ed25519 sign/verify              │
│  store-and-forward   │  compatible with lac_crypto.py    │
│  TTL management      │  Kyber-768 ready                  │
├──────────────────────┴──────────────────────────────────┤
│                  MeshDedup                               │
│         seen{} · loop prevention · 10min TTL            │
├─────────────────────────────────────────────────────────┤
│              WifiDirectTransport                         │
│  WiFi Direct AP+STA · TCP sockets · mDNS discovery      │
│  LAN UDP fallback (same WiFi) · Mock for dev/test        │
└─────────────────────────────────────────────────────────┘
```

### Transport modes (auto-detected)

```
1. WIFI_DIRECT  — native Capacitor plugin, full offline mesh
2. LAN_UDP      — same WiFi fallback, works in PWA
3. MOCK         — dev/test, no hardware needed
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

Every packet is **Ed25519-signed**. Unsigned or tampered packets are dropped silently. This is the vulnerability that broke Bitchat — it does not exist here.

---

## How it works

```
Phone A (AP)                Phone B (AP+STA)              Phone C (STA)
192.168.49.1                192.168.49.1                  client
    │                            │                             │
    │◄──── WiFi Direct ─────────►│◄──── WiFi Direct ──────────►│
    │      TCP :47731             │      TCP :47731              │
    │                            │                             │
    └── MSG(ttl=5) ─────────────►└── MSG(ttl=4) ──────────────►└ deliver
                                  also relay to other peers
```

**Store-and-forward**: if recipient is offline, nearby nodes cache the message for up to 12 hours and deliver when they reconnect.

---

## Installation

```bash
npm install lac-mesh
```

For native WiFi Direct (Android APK via Capacitor):
```bash
npm install @capacitor/core @capacitor/android
npx cap sync android
```

---

## Usage

### 3 lines in App.jsx

```js
import { LacMesh } from 'lac-mesh'

const mesh = new LacMesh({
  onMessage: (msg) => handleIncoming(msg),
  onStatus:  (status, { peers, mode }) => updateUI(status, peers),

  // Reuse existing LAC keypair — no second identity:
  pubkeyHex: lacNode.publicKey,
  seckeyHex: lacNode.secretKey,
})

await mesh.start()
```

### Hybrid transport (WebSocket + Mesh fallback)

```js
// sendMessage() — zero changes to lac_node.py:
function sendMessage(msg) {
  const payload = encryptPayload(msg)

  if (wsConnected) {
    ws.send(JSON.stringify({ to: msg.to, payload }))
  } else {
    // Internet gone — mesh takes over:
    mesh.send({ to: msg.to, payload })
  }
}
```

### Connect by IP (LAN fallback)

```js
// When both phones on same WiFi — connect directly by IP:
// Phone A shows QR with its local IP → Phone B scans → connect
mesh.connectByIp('192.168.1.42')
```

---

## Run the demo

```bash
git clone https://github.com/epidemiaya/lac-mesh
cd lac-mesh
npm install
node example/demo.js
```

```
═══════════════════════════════════════
  LAC Mesh — demo (direct router test)
═══════════════════════════════════════

Alice: ebd118bbef513c10…
Bob:   a382eca7367254b5…

Test 1: Alice → Bob (direct)     ✓
Test 2: Broadcast                ✓
Test 3: Dedup (replay blocked)   ✓  delivered 1/3 attempts
Test 4: Invalid signature        ✓  dropped

All tests passed ✓
═══════════════════════════════════════
```

---

## Roadmap

- [x] v0.1 — Core: MeshRouter, MeshCrypto, MeshDedup, MeshPacket
- [x] v0.1 — WifiDirectTransport (AP+STA architecture)
- [x] v0.1 — LAN UDP fallback mode
- [ ] v0.2 — Native Capacitor plugin: `LacWifiDirect.java`
- [ ] v0.2 — mDNS peer discovery
- [ ] v0.3 — QR code peer handshake
- [ ] v0.4 — Kyber-768 post-quantum session keys
- [ ] v0.5 — Cover traffic (decoy messages)

---

## Part of the LAC ecosystem

```
epidemiaya/LightAnonChain-    ← core blockchain + messenger
epidemiaya/lac-mesh           ← this module (offline transport)
epidemiaya/nagini-protocol    ← geographic secret distribution
```

---

## License

MIT

---

*"The network is the people."*
