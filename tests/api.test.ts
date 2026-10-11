import { afterEach, describe, expect, it } from 'vitest';
import { order, refund, setup } from './helpers.js';
import type { IngestResult } from '../src/types.js';

const databases: ReturnType<typeof setup>['db'][] = [];
function fixture() {
  const result = setup();
  databases.push(result.db);
  return result;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function request(app: ReturnType<typeof setup>['app'], path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('contrato HTTP', () => {
  it('entrega pedido atribuído, replay, estorno parcial e consulta auditável', async () => {
    const { app } = fixture();
    const first = await request(app, '/webhooks/store_a/orders', order());
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ duplicate: false, reason: 'order_created', order: { net_attributed_cents: 15990, attribution: { creator_id: 'crt_lia', reason: 'coupon_precedence' } } });
    const duplicate = await request(app, '/webhooks/store_a/orders', order());
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const partial = await request(app, '/webhooks/store_a/refunds', refund());
    expect(await partial.json()).toMatchObject({ refund: { amount_applied_cents: 4000 }, order: { net_attributed_cents: 11990 } });
    const audit = await app.request('/stores/store_a/orders/ord_1001/attribution');
    expect(audit.status).toBe(200);
    const body = await audit.json() as { history: unknown[]; refunds: unknown[] };
    expect(body.history).toHaveLength(4);
    expect(body.refunds).toHaveLength(1);
  });

  it('consulta pendência mesmo sem pedido e aplica quando ele chega', async () => {
    const { app } = fixture();
    expect(await (await request(app, '/webhooks/store_a/refunds', refund())).json()).toMatchObject({ order: null, refund: { state: 'pending' } });
    const pending = await app.request('/stores/store_a/orders/ord_1001/attribution');
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ order: null, refunds: [{ state: 'pending' }] });
    expect(await (await request(app, '/webhooks/store_a/orders', order())).json()).toMatchObject({ order: { refunded_applied_cents: 4000, net_attributed_cents: 11990 } });
  });

  it('retorna 409 e conserva o estado em conflito do pedido ou evento de refund', async () => {
    const { app } = fixture();
    await request(app, '/webhooks/store_a/orders', order());
    await request(app, '/webhooks/store_a/refunds', refund());
    const orderConflict = await request(app, '/webhooks/store_a/orders', order({ event_id: 'changed', total_cents: 1 }));
    expect(orderConflict.status).toBe(409);
    expect(await orderConflict.json()).toMatchObject({ reason: 'order_identity_conflict', order: { total_cents: 15990, refunded_applied_cents: 4000 } });
    const refundConflict = await request(app, '/webhooks/store_a/refunds', refund({ amount_cents: 1 }));
    expect(refundConflict.status).toBe(409);
    expect(await refundConflict.json()).toMatchObject({ reason: 'event_identity_conflict', refund: { amount_requested_cents: 4000 } });
  });

  it('normaliza chaves JSON em ordem diferente e campos opcionais ausentes', async () => {
    const { app } = fixture();
    const payload = order({ coupon: null, utms: { source: null, campaign: null, content: null } });
    const { coupon: _coupon, utms: _utms, ...required } = payload;
    await request(app, '/webhooks/store_a/orders', required);
    const reversed = Object.fromEntries(Object.entries(payload).reverse());
    const duplicate = await request(app, '/webhooks/store_a/orders', reversed);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as IngestResult).duplicate).toBe(true);
  });

  it.each([
    ['negativo', { total_cents: -1 }], ['fracionário', { total_cents: 1.2 }],
    ['inseguro', { total_cents: Number.MAX_SAFE_INTEGER + 1 }], ['string', { total_cents: '15990' }],
    ['total ausente', { total_cents: undefined }], ['status desconhecido', { status: 'shipped' }],
    ['status array', { status: ['paid'] }], ['ID vazio', { id: '' }],
    ['ID ausente', { id: undefined }], ['evento vazio', { event_id: '' }],
    ['UTM array', { utms: [] }], ['UTM null', { utms: null }],
    ['UTM numérico', { utms: { content: 1 } }], ['UTM desconhecido', { utms: { creator_id: 'crt_lia' } }],
    ['cupom vazio', { coupon: '   ' }], ['cupom numérico', { coupon: 1 }],
    ['campo desconhecido', { currency: 'BRL' }], ['data impossível', { occurred_at: '2026-02-30T00:00:00.000Z' }],
    ['data sem fuso', { occurred_at: '2026-10-01T15:00:00.000' }], ['data ausente', { occurred_at: undefined }],
  ])('rejeita pedido %s sem gravar efeitos', async (_label, override) => {
    const { app, db } = fixture();
    const response = await request(app, '/webhooks/store_a/orders', { ...order(), ...override });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM receipts').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM orders').get()).toMatchObject({ count: 0 });
  });

  it.each([
    { amount_cents: 0 }, { amount_cents: -1 }, { amount_cents: 1.5 },
    { amount_cents: '4000' }, { amount_cents: Number.MAX_SAFE_INTEGER + 1 },
    { refund_id: undefined }, { order_id: undefined }, { event_id: '' }, { occurred_at: 'invalid' },
  ])('rejeita estorno inválido %j sem pendência', async (override) => {
    const { app, service } = fixture();
    const response = await request(app, '/webhooks/store_a/refunds', { ...refund(), ...override });
    expect(response.status).toBe(400);
    expect(service.audit('store_a', 'ord_1001')).toEqual({ order: null, refunds: [], history: [] });
  });

  it('rejeita JSON malformado, scalar e array', async () => {
    const { app } = fixture();
    for (const body of ['{', 'null', '[]', '1']) {
      const response = await app.request('/webhooks/store_a/orders', { method: 'POST', body });
      expect(response.status).toBe(400);
    }
  });

  it('rejeita identificadores inválidos no caminho', async () => {
    const { app } = fixture();
    expect((await request(app, '/webhooks/store%20a/orders', order())).status).toBe(400);
    expect((await app.request('/stores/store_a/orders/ord%20x/attribution')).status).toBe(400);
  });

  it('limita corpo a 64 KiB', async () => {
    const { app } = fixture();
    const response = await request(app, '/webhooks/store_a/orders', { ...order(), coupon: 'x'.repeat(65536) });
    expect(response.status).toBe(413);
  });

  it('404 para pedido inexistente, sem vazar snapshot da outra loja', async () => {
    const { app } = fixture();
    await request(app, '/webhooks/store_a/orders', order());
    expect((await app.request('/stores/store_b/orders/ord_1001/attribution')).status).toBe(404);
    expect((await app.request('/missing')).status).toBe(404);
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok' });
  });

  it('recebimentos concorrentes de mesmo evento não somam e todos são auditáveis', async () => {
    const { app, service } = fixture();
    await Promise.all(Array.from({ length: 10 }, () => request(app, '/webhooks/store_a/orders', order())));
    await Promise.all(Array.from({ length: 10 }, () => request(app, '/webhooks/store_a/refunds', refund())));
    expect(service.getOrder('store_a', 'ord_1001')?.net_attributed_cents).toBe(11990);
    expect(service.audit('store_a', 'ord_1001').history).toHaveLength(21);
  });
});
