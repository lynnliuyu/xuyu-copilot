/**
 * 管理端保障逻辑的测试。
 *
 * 重点测「不卡住」：这个 helper 会在每个流水线脚本启动时被调用，
 * 如果它在端口不通时死等，所有脚本都会一起挂住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdminUp } from '../scripts/lib/admin.mjs';

test('isAdminUp：端口不通时快速返回 false，不死等', async () => {
  const t0 = Date.now();
  const up = await isAdminUp(1200);
  const cost = Date.now() - t0;
  if (up) return; // 本机恰好有管理端在跑，说明返回 true 也正常，跳过断言
  assert.ok(cost < 5000, `耗时 ${cost}ms，超时保护失效`);
});

test('isAdminUp：返回布尔值而不是抛异常', async () => {
  const r = await isAdminUp(600);
  assert.equal(typeof r, 'boolean');
});
