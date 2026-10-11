import { describe, expect, it } from 'vitest';
import { attributeOrder } from '../src/attribution.js';
import type { CreatorCode } from '../src/types.js';
import { order } from './helpers.js';

const codes: CreatorCode[] = [
  { store_id: 'store_a', code_type: 'coupon', code: 'LIA20', creator_id: 'crt_lia', active: true },
  { store_id: 'store_a', code_type: 'utm', code: 'creator:crt_bia', creator_id: 'crt_bia', active: true },
  { store_id: 'store_a', code_type: 'utm', code: 'creator:crt_lia', creator_id: 'crt_lia', active: true },
  { store_id: 'store_b', code_type: 'coupon', code: 'LIA20', creator_id: 'crt_ana', active: true },
  { store_id: 'store_a', code_type: 'coupon', code: 'INACTIVE', creator_id: 'crt_inactive', active: false },
  { store_id: 'store_a', code_type: 'utm', code: 'instagram', creator_id: 'crt_wrong', active: true },
];

describe('regra única de atribuição', () => {
  it('cupom vence UTM de outro criador', () => {
    expect(attributeOrder('store_a', order(), codes)).toEqual({ creator_id: 'crt_lia', source: 'coupon', reason: 'coupon_precedence' });
  });
  it('registra quando cupom e UTM concordam', () => {
    const payload = order({ utms: { source: null, campaign: null, content: 'creator:crt_lia' } });
    expect(attributeOrder('store_a', payload, codes).reason).toBe('coupon_and_utm_agree');
  });
  it('usa UTM quando cupom não resolve', () => {
    expect(attributeOrder('store_a', order({ coupon: 'UNKNOWN' }), codes)).toEqual({ creator_id: 'crt_bia', source: 'utm', reason: 'utm_match' });
  });
  it('cupom sem UTM resolve e respeita loja', () => {
    expect(attributeOrder('store_b', order(), codes)).toEqual({ creator_id: 'crt_ana', source: 'coupon', reason: 'coupon_match' });
  });
  it('código inativo não vence UTM', () => {
    expect(attributeOrder('store_a', order({ coupon: 'INACTIVE' }), codes).creator_id).toBe('crt_bia');
  });
  it('texto livre, source e campaign não são identificadores de criador', () => {
    const payload = order({ coupon: null, utms: { source: 'creator:crt_bia', campaign: 'creator:crt_lia', content: 'instagram' } });
    expect(attributeOrder('store_a', payload, codes)).toEqual({ creator_id: null, source: null, reason: 'no_matching_creator' });
  });
  it('não resolve código de outra loja e não muda os argumentos', () => {
    const payload = order();
    const before = JSON.stringify({ payload, codes });
    expect(attributeOrder('unconfigured', payload, codes).creator_id).toBeNull();
    expect(JSON.stringify({ payload, codes })).toBe(before);
  });
});
