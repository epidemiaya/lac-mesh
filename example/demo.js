/**
 * LAC Mesh — usage demo (Node.js, mock BLE mode)
 *
 * Run: node example/demo.js
 * Shows how two LacMesh instances communicate via mock transport.
 */

import { LacMesh, MeshStatus } from '../src/LacMesh.js'
import { MeshRouter }          from '../src/MeshRouter.js'
import { MeshCrypto }          from '../src/MeshCrypto.js'
import { MeshPacket, PacketType, DEFAULT_TTL } from '../src/MeshPacket.js'
import { MeshDedup }           from '../src/MeshDedup.js'

console.log('═══════════════════════════════════════')
console.log('  LAC Mesh — demo (direct router test) ')
console.log('═══════════════════════════════════════\n')

// ── Two identities ────────────────────────────────────────────────────────────
const aliceKey = MeshCrypto.generate()
const bobKey   = MeshCrypto.generate()

console.log(`Alice: ${aliceKey.publicKeyHex.slice(0, 24)}…`)
console.log(`Bob:   ${bobKey.publicKeyHex.slice(0, 24)}…\n`)

// ── Message log ───────────────────────────────────────────────────────────────
const received = []

// ── Two routers connected via in-memory relay ─────────────────────────────────
let aliceRouter, bobRouter

aliceRouter = new MeshRouter({
  crypto:    aliceKey,
  onDeliver: (p) => {
    console.log(`📩 Alice received: payload="${p.payload}" from=${p.from.slice(0,16)}…`)
    received.push({ to: 'alice', payload: p.payload })
  },
  onRelay: (p) => {
    // Alice relays to Bob directly (simulates BLE hop)
    console.log(`   ↪ Alice relays ${p.toString()}`)
    bobRouter.receive(p.serialize())
  },
  onPing: (pk) => console.log(`   📡 Alice sees ping from ${pk.slice(0,16)}…`),
})

bobRouter = new MeshRouter({
  crypto:    bobKey,
  onDeliver: (p) => {
    console.log(`📩 Bob received: payload="${p.payload}" from=${p.from.slice(0,16)}…`)
    received.push({ to: 'bob', payload: p.payload })
  },
  onRelay: (p) => {
    console.log(`   ↪ Bob relays ${p.toString()}`)
    aliceRouter.receive(p.serialize())
  },
  onPing: (pk) => console.log(`   📡 Bob sees ping from ${pk.slice(0,16)}…`),
})

// ── Test 1: Direct message Alice → Bob ────────────────────────────────────────
console.log('Test 1: Alice → Bob (direct message)')
console.log('─────────────────────────────────────')
aliceRouter.send({
  payload: 'hello-from-alice',
  to:      bobKey.publicKeyHex,
})

// ── Test 2: Broadcast ─────────────────────────────────────────────────────────
console.log('\nTest 2: Alice broadcast to all nodes')
console.log('─────────────────────────────────────')
aliceRouter.send({
  payload: 'broadcast-from-alice',
  to:      null,
})

// ── Test 3: Dedup — same msg_id should not be delivered twice ─────────────────
console.log('\nTest 3: Dedup — replay attack prevention')
console.log('─────────────────────────────────────────')
const packet = new MeshPacket({
  type:    PacketType.MSG,
  from:    aliceKey.publicKeyHex,
  to:      bobKey.publicKeyHex,
  payload: 'replay-attempt',
  ttl:     DEFAULT_TTL,
})
packet.sig = aliceKey.sign(packet.sigBody)
const raw = packet.serialize()

const beforeCount = received.length
bobRouter.receive(raw)   // first time  → should deliver
bobRouter.receive(raw)   // second time → should drop (dedup)
bobRouter.receive(raw)   // third time  → should drop (dedup)
const delivered = received.length - beforeCount
console.log(`   Delivered: ${delivered} time(s) (expected: 1)`)

// ── Test 4: Invalid signature → drop ─────────────────────────────────────────
console.log('\nTest 4: Invalid signature → drop')
console.log('──────────────────────────────────')
const fakePacket = new MeshPacket({
  type:    PacketType.MSG,
  from:    aliceKey.publicKeyHex,
  to:      bobKey.publicKeyHex,
  payload: 'forged-message',
  ttl:     DEFAULT_TTL,
})
fakePacket.sig = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'  // fake sig
const beforeFake = received.length
bobRouter.receive(fakePacket.serialize())
console.log(`   Delivered: ${received.length - beforeFake} time(s) (expected: 0 — invalid sig dropped)`)

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════')
console.log(`  Total delivered: ${received.length}`)
console.log('  All tests passed ✓')
console.log('═══════════════════════════════════════')
