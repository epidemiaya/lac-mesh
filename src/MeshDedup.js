/**
 * MeshDedup — seen-message deduplication engine
 *
 * Prevents relay loops and duplicate delivery in flood routing.
 * Uses a time-bounded Set: entries expire after `ttl_ms` (default 10 min).
 * Memory-safe: auto-purges expired entries on every check.
 */

export class MeshDedup {
  /**
   * @param {object} opts
   * @param {number} opts.ttl_ms     - How long to remember a msg_id (default: 10 min)
   * @param {number} opts.max_size   - Max entries before forced purge (default: 2000)
   */
  constructor({ ttl_ms = 10 * 60 * 1000, max_size = 2000 } = {}) {
    this.ttl_ms   = ttl_ms
    this.max_size = max_size
    // Map<msg_id, expiry_timestamp>
    this._seen = new Map()
  }

  /**
   * Check if a message was already seen, and mark it as seen.
   * @param {string} msg_id
   * @returns {boolean} true if ALREADY seen (should drop), false if new (should relay)
   */
  seen(msg_id) {
    this._purge()

    if (this._seen.has(msg_id)) return true

    // Force purge if over max size
    if (this._seen.size >= this.max_size) this._purgeAll()

    this._seen.set(msg_id, Date.now() + this.ttl_ms)
    return false
  }

  /**
   * Explicitly mark a msg_id without the seen check.
   * Useful for messages we originated ourselves.
   */
  mark(msg_id) {
    this._seen.set(msg_id, Date.now() + this.ttl_ms)
  }

  /** Remove a specific msg_id (e.g. on confirmed delivery) */
  forget(msg_id) {
    this._seen.delete(msg_id)
  }

  /** Current number of tracked message IDs */
  get size() {
    return this._seen.size
  }

  /** Purge expired entries */
  _purge() {
    const now = Date.now()
    for (const [id, exp] of this._seen) {
      if (exp < now) this._seen.delete(id)
    }
  }

  /** Nuclear purge — clear everything */
  _purgeAll() {
    this._seen.clear()
  }
}
