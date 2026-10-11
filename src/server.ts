import { serve } from '@hono/node-server';
import { openDatabase } from './database.js';
import { SalesService } from './service.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválida');
const db = openDatabase(process.env.DB_PATH ?? './data/sales.sqlite');
const app = createApp(new SalesService(db));
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`API em http://127.0.0.1:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { db.close(); process.exit(0); }));
}
