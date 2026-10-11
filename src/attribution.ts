import type { Attribution, CreatorCode, OrderWebhook } from './types.js';

// A decisão é congelada no primeiro pedido e não depende do status/estorno.
export function attributeOrder(
  storeId: string,
  order: Pick<OrderWebhook, 'coupon' | 'utms'>,
  codes: readonly CreatorCode[],
): Attribution {
  const find = (type: CreatorCode['code_type'], code: string | null): string | null =>
    codes.find((item) => item.store_id === storeId && item.active && item.code_type === type && item.code === code)
      ?.creator_id ?? null;
  const coupon = find('coupon', order.coupon);
  const utm = order.utms.content?.startsWith('creator:') ? find('utm', order.utms.content) : null;
  if (coupon) {
    return {
      creator_id: coupon,
      source: 'coupon',
      reason: utm ? (utm === coupon ? 'coupon_and_utm_agree' : 'coupon_precedence') : 'coupon_match',
    };
  }
  if (utm) return { creator_id: utm, source: 'utm', reason: 'utm_match' };
  return { creator_id: null, source: null, reason: 'no_matching_creator' };
}
