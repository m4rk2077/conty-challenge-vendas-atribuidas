import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(project, 'data');
mkdirSync(data, { recursive: true });
const directory = mkdtempSync(join(data, 'http-demo-'));
const env = { ...process.env, DB_PATH: join(directory, 'demo.sqlite'), PORT: '0' };
let server;

async function start() {
  server = spawn(process.execPath, ['dist/server.js'], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolveUrl, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error(`API não iniciou: ${errors}`)), 10000);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`API saiu antes de iniciar (${code}): ${errors}`)); });
    server.stderr.on('data', (chunk) => { errors += chunk; });
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/API em (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    });
  });
}

async function stop() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const ended = once(server, 'exit');
    server.kill('SIGTERM');
    await ended;
  }
  server = undefined;
}

try {
  execFileSync(process.execPath, ['dist/seed.js'], { cwd: project, env, windowsHide: true, stdio: 'pipe' });
  let base = await start();
  const post = async (route, body, expectedStatus = 200) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, expectedStatus);
    return await response.json();
  };
  const order = {
    event_id: 'evt_order_001', id: 'ord_1001', total_cents: 15990, coupon: 'LIA20',
    utms: { source: 'instagram', campaign: 'summer', content: 'creator:crt_bia' },
    status: 'paid', occurred_at: '2026-10-01T15:00:00.000Z',
  };
  const refund = {
    event_id: 'evt_refund_001', refund_id: 'ref_1', order_id: 'ord_1001', amount_cents: 4000,
    occurred_at: '2026-10-03T10:00:00.000Z',
  };
  const created = await post('/webhooks/store_a/orders', order);
  assert.equal(created.order.attribution.creator_id, 'crt_lia');
  assert.equal(created.order.attribution.reason, 'coupon_precedence');
  const duplicatedOrder = await post('/webhooks/store_a/orders', order);
  assert.equal(duplicatedOrder.duplicate, true);
  const partial = await post('/webhooks/store_a/refunds', refund);
  assert.equal(partial.order.net_attributed_cents, 11990);
  await post('/webhooks/store_a/refunds', { ...refund, event_id: 'evt_2', refund_id: 'ref_2', amount_cents: 3000 });
  const repeated = await post('/webhooks/store_a/refunds', refund);
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.order.net_attributed_cents, 8990);
  const replay = await post('/webhooks/store_a/orders', order);
  assert.equal(replay.order.net_attributed_cents, 8990);
  const capped = await post('/webhooks/store_a/refunds', { ...refund, event_id: 'evt_cap', refund_id: 'ref_cap', amount_cents: 20000 });
  assert.equal(capped.refund.amount_requested_cents, 20000);
  assert.equal(capped.refund.amount_applied_cents, 8990);
  assert.equal(capped.order.net_attributed_cents, 0);
  const conflicting = await post('/webhooks/store_a/orders', { ...order, event_id: 'evt_conflict', total_cents: 1 }, 409);
  assert.equal(conflicting.order.refunded_applied_cents, 15990);

  const early = { ...refund, event_id: 'evt_early', refund_id: 'ref_early', order_id: 'ord_early' };
  const pending = await post('/webhooks/store_a/refunds', early);
  assert.equal(pending.refund.state, 'pending');
  await stop();
  base = await start();
  const pendingResponse = await fetch(`${base}/stores/store_a/orders/ord_early/attribution`);
  assert.equal(pendingResponse.status, 200);
  assert.equal((await pendingResponse.json()).refunds[0].state, 'pending');
  const afterRestart = await post('/webhooks/store_a/orders', { ...order, id: 'ord_early', event_id: 'evt_early_order' });
  assert.equal(afterRestart.order.net_attributed_cents, 11990);
  const replayAfterRestart = await post('/webhooks/store_a/refunds', early);
  assert.equal(replayAfterRestart.duplicate, true);
  assert.equal(replayAfterRestart.refund.amount_applied_cents, 4000);

  const otherStore = await post('/webhooks/store_b/orders', order);
  assert.equal(otherStore.order.attribution.creator_id, 'crt_ana');
  const audit = await (await fetch(`${base}/stores/store_a/orders/ord_1001/attribution`)).json();
  assert.equal(audit.refunds.length, 3);
  assert.equal(audit.order.refunded_applied_cents, 15990);

  console.log(JSON.stringify({
    runtime: process.version,
    attribution: created.order.attribution,
    partial_net_cents: partial.order.net_attributed_cents,
    repeated_refund_net_cents: repeated.order.net_attributed_cents,
    cap: { requested: capped.refund.amount_requested_cents, applied: capped.refund.amount_applied_cents, net: capped.order.net_attributed_cents },
    conflict_status: 409,
    restarted_pending_refund_applied_cents: replayAfterRestart.refund.amount_applied_cents,
    other_store_creator: otherStore.order.attribution.creator_id,
    audit_receipts: audit.history.length,
  }, null, 2));
} finally {
  await stop();
  if (dirname(resolve(directory)) !== data) throw new Error('Diretório de demonstração fora de data');
  rmSync(directory, { recursive: true, force: true });
}
