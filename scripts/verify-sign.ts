/**
 * 用官方文档给出的测试向量校验签名实现。
 * 出处：《接入说明》签名规则示例
 *   appKey    = 203413189371893
 *   appSecret = o9wl81dncmvby3ijpq7eur456zhgtaxs
 *   timestamp = 1636087298
 *   body      = {"product_id":"219530767978565"}
 * 期望：bodyMd5 = 2608f2139cca8755cabf25209251e549
 *       sign    = c26c8a48809141f3dd80bd9b9ddb41ea
 */
import { md5, genSign, compactBody } from '../packages/goofish-adapter/src/sign';

const V = {
  appKey: '203413189371893',
  appSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
  timestamp: 1636087298,
  expectBodyMd5: '2608f2139cca8755cabf25209251e549',
  expectSign: 'c26c8a48809141f3dd80bd9b9ddb41ea',
};

const body = { product_id: '219530767978565' };
const bodyString = compactBody(body);
const bodyMd5 = md5(bodyString);
const sign = genSign({ ...V, bodyString });

const ok = (a: string, b: string) => (a === b ? '\x1b[32m✅ 一致\x1b[0m' : `\x1b[31m❌ 不一致（实际 ${a}）\x1b[0m`);

console.log('=== 官方测试向量校验 ===');
console.log(`  body        : ${bodyString}`);
console.log(`  bodyMd5     : ${bodyMd5}`);
console.log(`  期望        : ${V.expectBodyMd5}   ${ok(bodyMd5, V.expectBodyMd5)}`);
console.log('');
console.log(`  sign        : ${sign}`);
console.log(`  期望        : ${V.expectSign}   ${ok(sign, V.expectSign)}`);
console.log('');
console.log('=== 边界用例 ===');
console.log(`  空 body 的 md5      : ${md5(compactBody({}))}  ${ok(md5(compactBody({})), '99914b932bd37a50b983c5e7c90ae93b') ? '(md5("{}") 应为 99914b93...)' : ''}`);
console.log(`  空 body 的字符串    : ${JSON.stringify(compactBody({}))}`);
console.log('');
console.log('=== 商务对接模式（含 sellerId）===')
console.log(`  含 sellerId 的 sign : ${genSign({ ...V, bodyString, sellerId: '10086' })}`);
console.log('  （无官方向量，仅确认拼接顺序不带逗号错位）');
console.log('');
const pass = bodyMd5 === V.expectBodyMd5 && sign === V.expectSign;
console.log(pass ? '\x1b[32m结论：签名实现与官方测试向量完全一致。\x1b[0m' : '\x1b[31m结论：签名实现有误，需排查拼接格式。\x1b[0m');
process.exit(pass ? 0 : 1);
