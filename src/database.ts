import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS creator_codes (
      store_id TEXT NOT NULL, code_type TEXT NOT NULL CHECK(code_type IN ('coupon', 'utm')),
      code TEXT NOT NULL, creator_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0, 1)),
      PRIMARY KEY(store_id, code_type, code)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orders (
      store_id TEXT NOT NULL, order_id TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 0 AND 9007199254740991),
      status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'cancelled')),
      immutable_json TEXT NOT NULL, attribution_json TEXT NOT NULL,
      first_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL, status_occurred_at TEXT NOT NULL,
      PRIMARY KEY(store_id, order_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id TEXT NOT NULL, order_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('order', 'refund', 'refund_applied')),
      event_id TEXT NOT NULL, payload_json TEXT NOT NULL, received_at TEXT NOT NULL,
      decision_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS receipts_order ON receipts(store_id, order_id, sequence);

    CREATE TABLE IF NOT EXISTS webhook_keys (
      store_id TEXT NOT NULL, event_type TEXT NOT NULL, event_id TEXT NOT NULL,
      payload_json TEXT NOT NULL, decision_json TEXT NOT NULL,
      PRIMARY KEY(store_id, event_type, event_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS refunds (
      store_id TEXT NOT NULL, refund_id TEXT NOT NULL, order_id TEXT NOT NULL,
      amount_requested_cents INTEGER NOT NULL CHECK(amount_requested_cents BETWEEN 1 AND 9007199254740991),
      amount_applied_cents INTEGER NOT NULL CHECK(amount_applied_cents BETWEEN 0 AND amount_requested_cents),
      state TEXT NOT NULL CHECK(state IN ('pending', 'applied', 'capped')),
      reason TEXT NOT NULL, identity_json TEXT NOT NULL,
      arrival_sequence INTEGER NOT NULL REFERENCES receipts(sequence),
      received_at TEXT NOT NULL, applied_at TEXT, occurred_at TEXT NOT NULL,
      PRIMARY KEY(store_id, refund_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS refunds_order ON refunds(store_id, order_id, arrival_sequence);
  `);
  return db;
}
