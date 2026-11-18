/**
 * 闲管家「虚拟货源」签名回归测试。
 *
 * 用官方给出的测试向量锁定算法。签名是整条链路的门锁：
 * 算错了管家一律拒绝，而且**报错很含糊**（常见 `code=100001` 通用兜底码），
 * 排查一次要很久，所以必须有用例把它钉死。
 *
 * 测试向量出处见 sign.ts 头部注释（官方文档 doc-4985015）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genVsSign, explainSign, compactBody, md5, safeEqual } from '../packages/xgj-gateway/src/sign';

/** 官方文档里的测试向量 */
const OFFICIAL = {
  appId: '677859093659717',
  appSecret: 'wK63PxlOBaY9NoqMksLeZySzGIW25ifA',
  mchId: '100',
  mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
  timestamp: '1724414553',
  bodyString: '{"goods_type":1,"goods_no":"12344532"}',
};

test('genVsSign：与官方测试向量一致', () => {
  assert.equal(md5(OFFICIAL.bodyString), '9b8030f5097d5ed123405b003dd247c5');
  assert.equal(genVsSign(OFFICIAL), 'f8677927fd8421a75718e8cfaaf92221');
});

test('genVsSign：timestamp 传数字与传字符串结果相同', () => {
  assert.equal(genVsSign({ ...OFFICIAL, timestamp: 1724414553 }), genVsSign(OFFICIAL));
});

test('genVsSign：参数顺序敏感（换位必须得出不同结果）', () => {
  const swapped = genVsSign({ ...OFFICIAL, mchId: OFFICIAL.mchSecret, mchSecret: OFFICIAL.mchId });
  assert.notEqual(swapped, genVsSign(OFFICIAL));
});

test('genVsSign：body 任何一个字节变化都会改变签名', () => {
  assert.notEqual(genVsSign({ ...OFFICIAL, bodyString: '{"goods_type":1,"goods_no":"12344533"}' }), genVsSign(OFFICIAL));
});

test('compactBody：归一为压缩 JSON', () => {
  assert.equal(compactBody(undefined), '{}');
  assert.equal(compactBody(null), '{}');
  assert.equal(compactBody(''), '{}');
  // 已经是字符串时原样透传（验签方拿到的是原始字节）
  assert.equal(compactBody('{"a":1}'), '{"a":1}');
  // 对象必须压成无空格形式
  assert.equal(compactBody({ a: 1, b: [2] }), '{"a":1,"b":[2]}');
  assert.ok(!/\s/.test(compactBody({ a: 1, b: { c: 2 } })), '压缩 JSON 里不该有空白');
});

test('explainSign：返回可用于排查的中间值', () => {
  const e = explainSign(OFFICIAL);
  assert.equal(e.bodyMd5, '9b8030f5097d5ed123405b003dd247c5');
  assert.equal(e.sign, genVsSign(OFFICIAL));
  assert.equal(e.signSource.split(',').length, 6);
});

test('safeEqual：长度不同直接 false，相等值返回 true', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
