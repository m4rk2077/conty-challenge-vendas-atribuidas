import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('API HTTP real sobrevive ao reinício do processo e executa os exemplos', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['examples/demo.mjs'], { windowsHide: true, timeout: 20000 });
  expect(JSON.parse(stdout)).toMatchObject({
    runtime: process.version,
    attribution: { creator_id: 'crt_lia', reason: 'coupon_precedence' },
    partial_net_cents: 11990, repeated_refund_net_cents: 8990,
    cap: { requested: 20000, applied: 8990, net: 0 },
    conflict_status: 409, restarted_pending_refund_applied_cents: 4000,
    other_store_creator: 'crt_ana', audit_receipts: 11,
  });
}, 30000);
