import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { order, refund, setup, time, later } from './helpers.js';

const databases: ReturnType<typeof setup>['db'][] = [];
function fixture(path?: string) {
  const result = setup(path);
  databases.push(result.db);
  return result;
}
afterEach(() => { for (const db of databases.splice(0)) { if (db.isOpen) db.close(); } });

describe('pedidos e ledger de estornos', () => {
  it('replay do evento e do pedido com novo event_id não somam novamente', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    expect(service.ingestOrder('store_a', order()).duplicate).toBe(true);
    expect(service.ingestOrder('store_a', order({ event_id: 'retry_with_new_id' })).duplicate).toBe(true);
    const audit = service.audit('store_a', 'ord_1001');
    expect(audit.order?.net_attributed_cents).toBe(15990);
    expect(audit.history).toHaveLength(3);
    expect(audit.history.map((event) => event.decision.duplicate)).toEqual([false, true, true]);
  });

  it('parciais distintos acumulam, replay de refund com novo event_id não reaplica', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    service.ingestRefund('store_a', refund({ refund_id: 'ref_2', event_id: 'evt_ref_2', amount_cents: 3000 }));
    expect(service.ingestRefund('store_a', refund()).duplicate).toBe(true);
    expect(service.ingestRefund('store_a', refund({ event_id: 'evt_ref_retry' })).duplicate).toBe(true);
    expect(service.getOrder('store_a', 'ord_1001')).toMatchObject({
      refunded_applied_cents: 7000, net_attributed_cents: 8990, attribution_state: 'partially_refunded',
    });
    expect(service.audit('store_a', 'ord_1001').refunds).toHaveLength(2);
  });

  it('estorno integral reverte mantendo criador, decisão original e histórico', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund({ amount_cents: 15990 }));
    const audit = service.audit('store_a', 'ord_1001');
    expect(audit.order).toMatchObject({ net_attributed_cents: 0, refunded_applied_cents: 15990, attribution_state: 'reverted' });
    expect(audit.order?.attribution.creator_id).toBe('crt_lia');
    expect(audit.history[0]?.decision.order).toMatchObject({ net_attributed_cents: 15990 });
    expect(audit.history.some((event) => event.event_type === 'refund_applied')).toBe(true);
  });

  it('limita ao restante e preserva solicitado, inclusive quando já não há saldo', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    const capped = service.ingestRefund('store_a', refund({ event_id: 'evt_2', refund_id: 'ref_2', amount_cents: 20000 }));
    expect(capped.refund).toMatchObject({ amount_requested_cents: 20000, amount_applied_cents: 11990, state: 'capped', reason: 'capped_to_remaining' });
    const empty = service.ingestRefund('store_a', refund({ event_id: 'evt_3', refund_id: 'ref_3', amount_cents: 1 }));
    expect(empty.refund).toMatchObject({ amount_requested_cents: 1, amount_applied_cents: 0, state: 'capped' });
    expect(empty.order?.refunded_applied_cents).toBe(15990);
    expect(service.ingestOrder('store_a', order()).order?.net_attributed_cents).toBe(0);
  });

  it('estorno antes do pedido permanece consultável e depois é aplicado', () => {
    const { service } = fixture();
    const pending = service.ingestRefund('store_a', refund());
    expect(pending.order).toBeNull();
    expect(pending.refund).toMatchObject({ state: 'pending', amount_applied_cents: 0, applied_at: null });
    expect(service.ingestRefund('store_a', refund()).duplicate).toBe(true);
    expect(service.audit('store_a', 'ord_1001').refunds).toHaveLength(1);
    expect(service.ingestOrder('store_a', order()).order?.net_attributed_cents).toBe(11990);
    expect(service.getRefund('store_a', 'ref_1')?.state).toBe('applied');
    const history = service.audit('store_a', 'ord_1001').history;
    expect(history[0]?.decision.refund).toMatchObject({ state: 'pending' });
    expect(history.at(-1)?.event_type).toBe('refund_applied');
  });

  it('pendências sobrevivem a reabertura, com ordem estável quando received_at empata', () => {
    const root = resolve('data');
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, 'persistence-test-'));
    try {
      const { service, db } = fixture(join(directory, 'sales.sqlite'));
      service.ingestRefund('store_a', refund({ amount_cents: 10000, occurred_at: later }));
      service.ingestRefund('store_a', refund({ event_id: 'evt_2', refund_id: 'ref_2', amount_cents: 10000, occurred_at: time }));
      db.close();
      const reopened = fixture(join(directory, 'sales.sqlite'));
      const result = reopened.service.ingestOrder('store_a', order());
      expect(result.order?.net_attributed_cents).toBe(0);
      expect(reopened.service.getRefund('store_a', 'ref_1')?.amount_applied_cents).toBe(10000);
      expect(reopened.service.getRefund('store_a', 'ref_2')?.amount_applied_cents).toBe(5990);
      reopened.db.close();
      const again = fixture(join(directory, 'sales.sqlite'));
      expect(again.service.ingestRefund('store_a', refund({ amount_cents: 10000, occurred_at: later })).duplicate).toBe(true);
      expect(again.service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(15990);
      again.db.close();
    } finally {
      if (dirname(resolve(directory)) !== root) throw new Error('Diretório de teste fora de data');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('isola order_id, refund_id e event_id por loja', () => {
    const { service } = fixture();
    for (const store of ['store_a', 'store_b']) {
      service.ingestOrder(store, order());
      service.ingestRefund(store, refund());
    }
    expect(service.getOrder('store_a', 'ord_1001')?.attribution.creator_id).toBe('crt_lia');
    expect(service.getOrder('store_b', 'ord_1001')?.attribution.creator_id).toBe('crt_ana');
    expect(service.getOrder('store_b', 'ord_1001')?.net_attributed_cents).toBe(11990);
    expect(service.audit('store_a', 'ord_1001').history.every((receipt) => receipt.store_id === 'store_a')).toBe(true);
  });

  it('mesmo event_id com payload diferente vira conflito auditável sem efeito', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    const result = service.ingestOrder('store_a', order({ total_cents: 1 }));
    expect(result).toMatchObject({ http_status: 409, reason: 'event_identity_conflict' });
    expect(result.order?.total_cents).toBe(15990);
    expect(service.audit('store_a', 'ord_1001').history.at(-1)?.payload).toMatchObject({ total_cents: 1 });
  });

  it.each([
    { total_cents: 100 }, { coupon: 'BIA20' },
    { utms: { source: null, campaign: null, content: 'creator:crt_lia' } },
  ])('mesmo pedido com dados imutáveis diferentes não muda valor nem criador: %j', (change) => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    const input = order({ ...change, event_id: 'changed' });
    expect(service.ingestOrder('store_a', input)).toMatchObject({ http_status: 409, reason: 'order_identity_conflict' });
    expect(service.ingestOrder('store_a', input)).toMatchObject({ http_status: 409, duplicate: true });
    expect(service.getOrder('store_a', 'ord_1001')).toMatchObject({ total_cents: 15990, refunded_applied_cents: 4000, net_attributed_cents: 11990 });
  });

  it('refund_id com valor, pedido ou horário conflitante não reaplica', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    for (const change of [{ amount_cents: 8000 }, { order_id: 'different' }, { occurred_at: time }]) {
      const result = service.ingestRefund('store_a', refund({ ...change, event_id: `conflict_${Object.keys(change)[0]}` }));
      expect(result).toMatchObject({ http_status: 409, reason: 'refund_identity_conflict' });
    }
    expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(4000);
    expect(service.audit('store_a', 'different').refunds).toHaveLength(0);
  });

  it('event_id de refund usado para outro refund não consome saldo', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    expect(service.ingestRefund('store_a', refund({ refund_id: 'other' })).reason).toBe('event_identity_conflict');
    expect(service.getRefund('store_a', 'other')).toBeNull();
    expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(4000);
  });

  it('pending não contabiliza; paid posterior contabiliza líquido preservando o estorno', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ status: 'pending' }));
    expect(service.ingestRefund('store_a', refund()).order).toMatchObject({ net_attributed_cents: 0, refunded_applied_cents: 4000 });
    const paid = service.ingestOrder('store_a', order({ status: 'paid', event_id: 'paid', occurred_at: later }));
    expect(paid.order).toMatchObject({ net_attributed_cents: 11990, attributed_gross_cents: 15990 });
    const replay = service.ingestOrder('store_a', order({ status: 'pending' }));
    expect(replay.order?.status).toBe('paid');
    expect(replay.order?.refunded_applied_cents).toBe(4000);
  });

  it('status antigo é ignorado e status em mesmo instante com novo evento dá conflito', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ occurred_at: later }));
    expect(service.ingestOrder('store_a', order({ event_id: 'old', status: 'pending' })).reason).toBe('stale_status_ignored');
    expect(service.ingestOrder('store_a', order({ event_id: 'tie', status: 'cancelled', occurred_at: later })).reason).toBe('status_timestamp_conflict');
    expect(service.getOrder('store_a', 'ord_1001')?.status).toBe('paid');
  });

  it('cancelled zera contabilização e não reabre; histórico mantém valor aprovado e estornos', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.ingestRefund('store_a', refund());
    const cancelled = service.ingestOrder('store_a', order({ event_id: 'cancel', status: 'cancelled', occurred_at: later }));
    expect(cancelled.order).toMatchObject({ attributed_gross_cents: 0, net_attributed_cents: 0, refunded_applied_cents: 4000, attribution_state: 'not_countable' });
    expect(service.ingestOrder('store_a', order({ event_id: 'reopen', occurred_at: '2026-10-04T00:00:00.000Z' })).reason).toBe('invalid_status_transition');
    expect(service.ingestOrder('store_a', order()).order?.status).toBe('cancelled');
  });

  it('pending pode transicionar diretamente para cancelled sem contabilizar receita', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ status: 'pending' }));
    const result = service.ingestOrder('store_a', order({ event_id: 'cancel', status: 'cancelled', occurred_at: later }));
    expect(result).toMatchObject({ http_status: 200, reason: 'status_updated', order: { status: 'cancelled', net_attributed_cents: 0, attributed_gross_cents: 0 } });
    expect(service.audit('store_a', 'ord_1001').history).toHaveLength(2);
  });

  it('refund recebido depois de cancelled é aplicado ao saldo sem contabilizar receita', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ status: 'cancelled' }));
    expect(service.ingestRefund('store_a', refund())).toMatchObject({
      refund: { state: 'applied', amount_applied_cents: 4000 },
      order: { status: 'cancelled', refunded_applied_cents: 4000, attributed_gross_cents: 0, net_attributed_cents: 0 },
    });
    const excess = service.ingestRefund('store_a', refund({ event_id: 'excess', refund_id: 'excess', amount_cents: 20000 }));
    expect(excess.refund?.amount_applied_cents).toBe(11990);
    expect(excess.order?.refunded_applied_cents).toBe(15990);
  });

  it('paid não volta a pending por um evento mais recente', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    expect(service.ingestOrder('store_a', order({ event_id: 'regression', status: 'pending', occurred_at: later })))
      .toMatchObject({ http_status: 409, reason: 'invalid_status_transition', order: { status: 'paid', net_attributed_cents: 15990 } });
  });

  it('sem criador mantém venda e estorno auditáveis com líquido atribuído zero', () => {
    const { service } = fixture();
    service.ingestOrder('unconfigured', order());
    const result = service.ingestRefund('unconfigured', refund());
    expect(result.order).toMatchObject({ total_cents: 15990, attributed_gross_cents: 0, net_attributed_cents: 0, refunded_applied_cents: 4000, attribution_state: 'unattributed' });
    expect(result.order?.attribution.reason).toBe('no_matching_creator');
  });

  it('reconfigurar código não transfere uma venda já atribuída', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order());
    service.putCreatorCode({ store_id: 'store_a', code_type: 'coupon', code: 'LIA20', creator_id: 'new_creator', active: true });
    expect(service.ingestOrder('store_a', order({ event_id: 'retry' })).order?.attribution.creator_id).toBe('crt_lia');
  });

  it('pedido zero aceita refund solicitado, aplica zero e não fica negativo', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ total_cents: 0 }));
    expect(service.getOrder('store_a', 'ord_1001')?.attribution_state).toBe('active');
    expect(service.ingestRefund('store_a', refund()).refund).toMatchObject({ state: 'capped', amount_applied_cents: 0 });
    expect(service.getOrder('store_a', 'ord_1001')?.net_attributed_cents).toBe(0);
    expect(service.getOrder('store_a', 'ord_1001')?.attribution_state).toBe('active');
  });

  it('opera no maior inteiro seguro sem perder centavos', () => {
    const { service } = fixture();
    service.ingestOrder('store_a', order({ total_cents: Number.MAX_SAFE_INTEGER }));
    service.ingestRefund('store_a', refund({ amount_cents: Number.MAX_SAFE_INTEGER - 1 }));
    expect(service.getOrder('store_a', 'ord_1001')?.net_attributed_cents).toBe(1);
    service.ingestRefund('store_a', refund({ event_id: 'extra', refund_id: 'extra', amount_cents: 2 }));
    expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('todas as permutações de pedido e três estornos preservam teto, total e identidades', () => {
    function permutations<T>(items: T[]): T[][] {
      if (items.length === 0) return [[]];
      return items.flatMap((item, i) => permutations(items.filter((_, index) => index !== i)).map((rest) => [item, ...rest]));
    }
    for (const events of permutations(['order', 'ref1', 'ref2', 'ref3'])) {
      const { service } = fixture();
      for (const event of events) {
        if (event === 'order') service.ingestOrder('store_a', order());
        else service.ingestRefund('store_a', refund({ event_id: event, refund_id: event, amount_cents: 10000 }));
        const snapshot = service.getOrder('store_a', 'ord_1001');
        if (snapshot) {
          expect(snapshot.refunded_applied_cents).toBeLessThanOrEqual(snapshot.total_cents);
          expect(snapshot.net_attributed_cents).toBeGreaterThanOrEqual(0);
        }
      }
      expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(15990);
      expect(service.audit('store_a', 'ord_1001').refunds).toHaveLength(3);
    }
  });

  it('erro no banco reverte recebimento, chave e efeito; retry pode aplicar uma única vez', () => {
    const { service, db } = fixture();
    service.ingestOrder('store_a', order());
    db.exec(`CREATE TRIGGER simulate_failure BEFORE INSERT ON refunds
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    expect(() => service.ingestRefund('store_a', refund())).toThrow('simulated storage failure');
    expect(service.audit('store_a', 'ord_1001').history).toHaveLength(1);
    expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(0);
    db.exec('DROP TRIGGER simulate_failure');
    expect(service.ingestRefund('store_a', refund()).duplicate).toBe(false);
    expect(service.ingestRefund('store_a', refund()).duplicate).toBe(true);
    expect(service.getOrder('store_a', 'ord_1001')?.refunded_applied_cents).toBe(4000);
  });
});
