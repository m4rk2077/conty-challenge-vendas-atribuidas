import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SalesService } from './service.js';
import { identifier, parseOrder, parseRefund, ValidationError } from './validation.js';

export function createApp(service: SalesService): Hono {
  const app = new Hono();
  app.use('/webhooks/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));
  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.post('/webhooks/:storeId/orders', async (c) => {
    const store = identifier(c.req.param('storeId'), 'storeId');
    const payload = parseOrder(await c.req.json<unknown>().catch(() => { throw new ValidationError('JSON inválido'); }));
    const { http_status, ...body } = service.ingestOrder(store, payload);
    return c.json(body, http_status);
  });
  app.post('/webhooks/:storeId/refunds', async (c) => {
    const store = identifier(c.req.param('storeId'), 'storeId');
    const payload = parseRefund(await c.req.json<unknown>().catch(() => { throw new ValidationError('JSON inválido'); }));
    const { http_status, ...body } = service.ingestRefund(store, payload);
    return c.json(body, http_status);
  });
  app.get('/stores/:storeId/orders/:orderId/attribution', (c) => {
    const store = identifier(c.req.param('storeId'), 'storeId');
    const id = identifier(c.req.param('orderId'), 'orderId');
    const audit = service.audit(store, id);
    if (!audit.order && audit.history.length === 0) return c.json({ error: 'order_not_found' }, 404);
    return c.json(audit);
  });
  app.notFound((c) => c.json({ error: 'route_not_found' }, 404));
  app.onError((error, c) => {
    if (error instanceof ValidationError) return c.json({ error: 'invalid_payload', message: error.message }, 400);
    console.error(error);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
