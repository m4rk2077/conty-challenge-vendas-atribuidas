import { openDatabase } from '../src/database.js';
import { SalesService } from '../src/service.js';
import { seedDemo } from '../src/seed.js';
import { createApp } from '../src/app.js';
import type { OrderWebhook, RefundWebhook } from '../src/types.js';

export const time = '2026-10-01T15:00:00.000Z';
export const later = '2026-10-03T15:00:00.000Z';

export const order = (overrides: Partial<OrderWebhook> = {}): OrderWebhook => ({
  event_id: 'evt_order_001', id: 'ord_1001', total_cents: 15990, coupon: 'LIA20',
  utms: { source: 'instagram', campaign: 'summer', content: 'creator:crt_bia' },
  status: 'paid', occurred_at: time, ...overrides,
});
export const refund = (overrides: Partial<RefundWebhook> = {}): RefundWebhook => ({
  event_id: 'evt_refund_001', refund_id: 'ref_1', order_id: 'ord_1001', amount_cents: 4000,
  occurred_at: later, ...overrides,
});

export function setup(path = ':memory:') {
  const db = openDatabase(path);
  const service = new SalesService(db, () => new Date('2026-10-11T12:00:00.000Z'));
  seedDemo(service);
  return { db, service, app: createApp(service) };
}
