export type OrderStatus = 'pending' | 'paid' | 'cancelled';
export type Utms = { source: string | null; campaign: string | null; content: string | null };

export interface OrderWebhook {
  event_id: string;
  id: string;
  total_cents: number;
  coupon: string | null;
  utms: Utms;
  status: OrderStatus;
  occurred_at: string;
}

export interface RefundWebhook {
  event_id: string;
  refund_id: string;
  order_id: string;
  amount_cents: number;
  occurred_at: string;
}

export interface CreatorCode {
  store_id: string;
  code_type: 'coupon' | 'utm';
  code: string;
  creator_id: string;
  active: boolean;
}

export interface Attribution {
  creator_id: string | null;
  source: 'coupon' | 'utm' | null;
  reason: 'coupon_precedence' | 'coupon_and_utm_agree' | 'coupon_match' | 'utm_match' | 'no_matching_creator';
}

export interface OrderSnapshot {
  store_id: string;
  order_id: string;
  total_cents: number;
  status: OrderStatus;
  coupon: string | null;
  utms: Utms;
  attribution: Attribution;
  attribution_state: 'unattributed' | 'not_countable' | 'active' | 'partially_refunded' | 'reverted';
  attributed_gross_cents: number;
  refunded_applied_cents: number;
  net_attributed_cents: number;
  first_received_at: string;
  last_received_at: string;
  status_occurred_at: string;
}

export interface RefundSnapshot {
  store_id: string;
  refund_id: string;
  order_id: string;
  amount_requested_cents: number;
  amount_applied_cents: number;
  state: 'pending' | 'applied' | 'capped';
  reason: 'order_not_received' | 'applied' | 'capped_to_remaining';
  received_at: string;
  applied_at: string | null;
  occurred_at: string;
}

export interface Decision {
  http_status: 200 | 409;
  duplicate: boolean;
  reason: string;
}

export interface Receipt {
  sequence: number;
  store_id: string;
  order_id: string;
  event_type: 'order' | 'refund' | 'refund_applied';
  event_id: string;
  payload: unknown;
  received_at: string;
  decision: Record<string, unknown>;
}

export interface IngestResult extends Decision {
  receipt_id: number;
  order: OrderSnapshot | null;
  refund: RefundSnapshot | null;
}
