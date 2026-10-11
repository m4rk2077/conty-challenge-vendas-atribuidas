import type { DatabaseSync } from 'node:sqlite';
import { attributeOrder } from './attribution.js';
import type {
  Attribution, CreatorCode, Decision, IngestResult, OrderSnapshot, OrderStatus,
  OrderWebhook, Receipt, RefundSnapshot, RefundWebhook, Utms,
} from './types.js';

type OrderRow = {
  store_id: string; order_id: string; total_cents: number; status: OrderStatus;
  immutable_json: string; attribution_json: string;
  first_received_at: string; last_received_at: string; status_occurred_at: string;
};
type RefundRow = RefundSnapshot & { identity_json: string; arrival_sequence: number };
type KeyRow = { payload_json: string; decision_json: string };

const immutableOrder = (order: OrderWebhook): string => JSON.stringify({
  total_cents: order.total_cents, coupon: order.coupon, utms: order.utms,
});
const refundIdentity = (refund: RefundWebhook): string => JSON.stringify({
  order_id: refund.order_id, amount_cents: refund.amount_cents, occurred_at: refund.occurred_at,
});
const ok = (reason: string, duplicate = false): Decision => ({ http_status: 200, duplicate, reason });
const conflict = (reason: string): Decision => ({ http_status: 409, duplicate: false, reason });

export class SalesService {
  constructor(private readonly db: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  // Configuração local, sem endpoint administrativo público.
  putCreatorCode(code: CreatorCode): void {
    this.db.prepare(`INSERT INTO creator_codes VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(store_id, code_type, code) DO UPDATE SET creator_id=excluded.creator_id, active=excluded.active`)
      .run(code.store_id, code.code_type, code.code, code.creator_id, Number(code.active));
  }

  getOrder(storeId: string, orderId: string): OrderSnapshot | null {
    const row = this.orderRow(storeId, orderId);
    if (!row) return null;
    const sum = this.db.prepare(`SELECT COALESCE(SUM(amount_applied_cents), 0) AS total
      FROM refunds WHERE store_id=? AND order_id=?`).get(storeId, orderId) as { total: number };
    const attribution = JSON.parse(row.attribution_json) as Attribution;
    const fields = JSON.parse(row.immutable_json) as { coupon: string | null; utms: Utms };
    const gross = row.status === 'paid' && attribution.creator_id !== null ? row.total_cents : 0;
    const net = gross === 0 ? 0 : gross - sum.total;
    const state = attribution.creator_id === null ? 'unattributed'
      : row.status !== 'paid' ? 'not_countable'
      : net === 0 && sum.total > 0 ? 'reverted' : sum.total > 0 ? 'partially_refunded' : 'active';
    return {
      store_id: storeId, order_id: orderId, total_cents: row.total_cents, status: row.status,
      coupon: fields.coupon, utms: fields.utms, attribution, attribution_state: state,
      attributed_gross_cents: gross, refunded_applied_cents: sum.total, net_attributed_cents: net,
      first_received_at: row.first_received_at, last_received_at: row.last_received_at,
      status_occurred_at: row.status_occurred_at,
    };
  }

  getRefund(storeId: string, refundId: string): RefundSnapshot | null {
    const row = this.refundRow(storeId, refundId);
    if (!row) return null;
    const { identity_json: _identity, arrival_sequence: _sequence, ...snapshot } = row;
    return snapshot;
  }

  audit(storeId: string, orderId: string): { order: OrderSnapshot | null; refunds: RefundSnapshot[]; history: Receipt[] } {
    // A mesma transação de leitura cobre snapshot, estornos e histórico (inclusive entre processos).
    this.db.exec('BEGIN');
    try {
      const order = this.getOrder(storeId, orderId);
      const refunds = (this.db.prepare(`SELECT refund_id FROM refunds WHERE store_id=? AND order_id=?
        ORDER BY arrival_sequence`).all(storeId, orderId) as { refund_id: string }[])
        .map((row) => this.getRefund(storeId, row.refund_id)!);
      const history = (this.db.prepare(`SELECT * FROM receipts WHERE store_id=? AND order_id=? ORDER BY sequence`)
        .all(storeId, orderId) as {
          sequence: number; store_id: string; order_id: string; event_type: Receipt['event_type'];
          event_id: string; payload_json: string; received_at: string; decision_json: string;
        }[]).map(({ payload_json, decision_json, ...row }) => ({
          ...row, payload: JSON.parse(payload_json) as unknown,
          decision: JSON.parse(decision_json) as Receipt['decision'],
        }));
      this.db.exec('COMMIT');
      return { order, refunds, history };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ingestOrder(storeId: string, payload: OrderWebhook): IngestResult {
    return this.ingest(storeId, 'order', payload, () => {
      const row = this.orderRow(storeId, payload.id);
      if (row) {
        if (row.immutable_json !== immutableOrder(payload)) return conflict('order_identity_conflict');
        if (row.status === payload.status) return ok('order_duplicate', true);
        if (payload.occurred_at < row.status_occurred_at) return ok('stale_status_ignored');
        if (payload.occurred_at === row.status_occurred_at) return conflict('status_timestamp_conflict');
        const allowed = row.status === 'pending' || (row.status === 'paid' && payload.status === 'cancelled');
        if (!allowed) return conflict('invalid_status_transition');
        this.db.prepare(`UPDATE orders SET status=?, status_occurred_at=?, last_received_at=?
          WHERE store_id=? AND order_id=?`)
          .run(payload.status, payload.occurred_at, this.receivedAt, storeId, payload.id);
        return ok('status_updated');
      }
      const codes = this.db.prepare(`SELECT store_id, code_type, code, creator_id, active FROM creator_codes
        WHERE store_id=?`).all(storeId) as unknown as (Omit<CreatorCode, 'active'> & { active: number })[];
      const attribution = attributeOrder(storeId, payload, codes.map((code) => ({ ...code, active: Boolean(code.active) })));
      this.db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        storeId, payload.id, payload.total_cents, payload.status, immutableOrder(payload), JSON.stringify(attribution),
        this.receivedAt, this.receivedAt, payload.occurred_at,
      );
      const pending = this.db.prepare(`SELECT refund_id FROM refunds WHERE store_id=? AND order_id=?
        AND state='pending' ORDER BY arrival_sequence`).all(storeId, payload.id) as { refund_id: string }[];
      for (const refund of pending) this.applyRefund(storeId, refund.refund_id);
      return ok('order_created');
    });
  }

  ingestRefund(storeId: string, payload: RefundWebhook): IngestResult {
    return this.ingest(storeId, 'refund', payload, (receiptId) => {
      const row = this.refundRow(storeId, payload.refund_id);
      if (row) return row.identity_json === refundIdentity(payload)
        ? ok('refund_duplicate', true) : conflict('refund_identity_conflict');
      this.db.prepare(`INSERT INTO refunds VALUES (?, ?, ?, ?, 0, 'pending', 'order_not_received', ?, ?, ?, NULL, ?)`)
        .run(storeId, payload.refund_id, payload.order_id, payload.amount_cents, refundIdentity(payload),
          receiptId, this.receivedAt, payload.occurred_at);
      if (this.orderRow(storeId, payload.order_id)) {
        this.applyRefund(storeId, payload.refund_id);
        return ok(this.getRefund(storeId, payload.refund_id)!.reason);
      }
      return ok('order_not_received');
    });
  }

  private receivedAt = '';

  private ingest(
    storeId: string, type: 'order' | 'refund', payload: OrderWebhook | RefundWebhook,
    process: (receiptId: number) => Decision,
  ): IngestResult {
    const orderId = 'id' in payload ? payload.id : payload.order_id;
    const payloadJson = JSON.stringify(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.receivedAt = this.now().toISOString();
      const receiptId = this.addReceipt(storeId, orderId, type, payload.event_id, payloadJson, {});
      const previous = this.db.prepare('SELECT * FROM webhook_keys WHERE store_id=? AND event_type=? AND event_id=?')
        .get(storeId, type, payload.event_id) as KeyRow | undefined;
      let decision: Decision;
      if (previous) {
        decision = previous.payload_json === payloadJson
          ? { ...(JSON.parse(previous.decision_json) as Decision), duplicate: true }
          : conflict('event_identity_conflict');
      } else {
        decision = process(receiptId);
        this.db.prepare('INSERT INTO webhook_keys VALUES (?, ?, ?, ?, ?)')
          .run(storeId, type, payload.event_id, payloadJson, JSON.stringify(decision));
      }
      const order = this.getOrder(storeId, orderId);
      const refund = 'refund_id' in payload ? this.getRefund(storeId, payload.refund_id) : null;
      this.db.prepare('UPDATE receipts SET decision_json=? WHERE sequence=?')
        .run(JSON.stringify({ ...decision, order, refund }), receiptId);
      this.db.exec('COMMIT');
      return { ...decision, receipt_id: receiptId, order, refund };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private applyRefund(storeId: string, refundId: string): void {
    const refund = this.refundRow(storeId, refundId)!;
    const order = this.getOrder(storeId, refund.order_id)!;
    const applied = Math.min(refund.amount_requested_cents, order.total_cents - order.refunded_applied_cents);
    const capped = applied < refund.amount_requested_cents;
    this.db.prepare(`UPDATE refunds SET amount_applied_cents=?, state=?, reason=?, applied_at=?
      WHERE store_id=? AND refund_id=? AND state='pending'`)
      .run(applied, capped ? 'capped' : 'applied', capped ? 'capped_to_remaining' : 'applied',
        this.receivedAt, storeId, refundId);
    this.addReceipt(storeId, refund.order_id, 'refund_applied', refundId, JSON.stringify({ refund_id: refundId }), {
      reason: capped ? 'capped_to_remaining' : 'applied',
      amount_requested_cents: refund.amount_requested_cents, amount_applied_cents: applied,
      refund: this.getRefund(storeId, refundId), order: this.getOrder(storeId, refund.order_id),
    });
  }

  private addReceipt(
    storeId: string, orderId: string, type: Receipt['event_type'], eventId: string,
    payloadJson: string, decision: Record<string, unknown>,
  ): number {
    const row = this.db.prepare(`INSERT INTO receipts(store_id, order_id, event_type, event_id,
      payload_json, received_at, decision_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(storeId, orderId, type, eventId, payloadJson, this.receivedAt, JSON.stringify(decision));
    return Number(row.lastInsertRowid);
  }

  private orderRow(storeId: string, orderId: string): OrderRow | undefined {
    return this.db.prepare('SELECT * FROM orders WHERE store_id=? AND order_id=?').get(storeId, orderId) as OrderRow | undefined;
  }

  private refundRow(storeId: string, refundId: string): RefundRow | undefined {
    return this.db.prepare('SELECT * FROM refunds WHERE store_id=? AND refund_id=?').get(storeId, refundId) as RefundRow | undefined;
  }
}
