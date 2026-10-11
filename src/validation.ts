import type { OrderStatus, OrderWebhook, RefundWebhook, Utms } from './types.js';

export class ValidationError extends Error {}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label}: objeto obrigatório`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ValidationError(`${label}: campo desconhecido`);
}

export function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new ValidationError(`${label}: use 1 a 100 letras ASCII, números, _ ou -`);
  }
  return value;
}

function text(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new ValidationError(`${label}: texto de 1 a 200 caracteres`);
  return value;
}

function cents(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ValidationError(`${label}: inteiro seguro em centavos, mínimo ${minimum}`);
  }
  return value;
}

function timestamp(value: unknown): string {
  // Exige UTC e calendário real; Date.parse sozinho normaliza datas como 30/02.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ValidationError('occurred_at: use YYYY-MM-DDTHH:mm:ss.sssZ em UTC');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new ValidationError('occurred_at: data inválida');
  return value;
}

export function parseOrder(value: unknown): OrderWebhook {
  const input = object(value, 'pedido');
  keys(input, ['event_id', 'id', 'total_cents', 'coupon', 'utms', 'status', 'occurred_at'], 'pedido');
  const rawUtms = input.utms === undefined ? {} : object(input.utms, 'utms');
  keys(rawUtms, ['source', 'campaign', 'content'], 'utms');
  const utms: Utms = {
    source: text(rawUtms.source, 'utms.source'),
    campaign: text(rawUtms.campaign, 'utms.campaign'),
    content: text(rawUtms.content, 'utms.content'),
  };
  if (typeof input.status !== 'string' || !['pending', 'paid', 'cancelled'].includes(input.status)) {
    throw new ValidationError('status: pending, paid ou cancelled');
  }
  return {
    event_id: identifier(input.event_id, 'event_id'), id: identifier(input.id, 'id'),
    total_cents: cents(input.total_cents, 'total_cents', 0), coupon: text(input.coupon, 'coupon'), utms,
    status: input.status as OrderStatus, occurred_at: timestamp(input.occurred_at),
  };
}

export function parseRefund(value: unknown): RefundWebhook {
  const input = object(value, 'estorno');
  keys(input, ['event_id', 'refund_id', 'order_id', 'amount_cents', 'occurred_at'], 'estorno');
  return {
    event_id: identifier(input.event_id, 'event_id'), refund_id: identifier(input.refund_id, 'refund_id'),
    order_id: identifier(input.order_id, 'order_id'), amount_cents: cents(input.amount_cents, 'amount_cents', 1),
    occurred_at: timestamp(input.occurred_at),
  };
}
