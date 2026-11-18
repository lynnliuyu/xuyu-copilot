import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOrderAction } from '../packages/goofish-adapter/src/push';

/**
 * 用户口径（2026-10-20）：退款就同意退款，**不作废已发出的分享链接**。
 * 我们的卡密是共享网盘链接，退款后链接照旧有效——这是刻意的，不是遗漏。
 */
test('refund is approved directly and never invalidates the shared link', () => {
  const action = decideOrderAction({ order_type: 7, order_status: 21, refund_status: 1 } as any);
  assert.equal(action.shouldRefund, true);
  assert.equal(action.shouldShip, false);
  assert.doesNotMatch(action.reason, /作废/);
  assert.match(action.reason, /同意退款/);
});

test('refund handling does not depend on order status', () => {
  for (const order_status of [12, 21, 22, 24]) {
    const action = decideOrderAction({ order_type: 7, order_status, refund_status: 2 } as any);
    assert.equal(action.shouldRefund, true, `status=${order_status}`);
    assert.equal(action.shouldShip, false, `status=${order_status}`);
  }
});

test('normal paid order still ships; no refund branch', () => {
  const action = decideOrderAction({ order_type: 7, order_status: 12, refund_status: 0 } as any);
  assert.equal(action.shouldRefund, false);
  assert.equal(action.shouldShip, true);
});

test('shipping decision uses the measured status code: 12 pending, 21 shipped', () => {
  assert.equal(decideOrderAction({ order_type: 7, order_status: 12, refund_status: 0 } as any).shouldShip, true);
  for (const shipped of [21, 22, 23, 24]) {
    const action = decideOrderAction({ order_type: 7, order_status: shipped, refund_status: 0 } as any);
    assert.equal(action.shouldShip, false, `status=${shipped} 不应再判待发货`);
  }
});
