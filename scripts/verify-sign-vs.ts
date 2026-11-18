/**
 * 用官方测试向量校验「虚拟货源」签名实现。
 *
 * 出处：《闲管家虚拟货源标准接口 › 接入说明 › 签名规则说明》
 *   https://s.apifox.cn/cf4d53fd-8bb2-41c5-8da3-371ba9a38956/doc-4985015.md
 *
 * 官方给出的测试数据：
 *   app_id     677859093659717
 *   app_secret wK63PxlOBaY9NoqMksLeZySzGIW25ifA
 *   mch_id     100
 *   mch_secret o9wl81dncmvby3ijpq7eur456zhgtaxs
 *   timestamp  1724414553
 *   body       {"goods_type":1,"goods_no":"12344532"}
 * 期望：bodyMd5 = 9b8030f5097d5ed123405b003dd247c5
 *       sign    = f8677927fd8421a75718e8cfaaf92221
 */
import { md5, genVsSign, explainSign, compactBody } from '../packages/xgj-gateway/src/sign';

const V = {
  appId: '677859093659717',
  appSecret: 'wK63PxlOBaY9NoqMksLeZySzGIW25ifA',
  mchId: '100',
  mchSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
  timestamp: 1724414553,
  body: { goods_type: 1, goods_no: '12344532' },
  expectBodyMd5: '9b8030f5097d5ed123405b003dd247c5',
  expectSign: 'f8677927fd8421a75718e8cfaaf92221',
};

const ok = (a: string, b: string) => (a === b ? '\x1b[32m✅ 一致\x1b[0m' : `\x1b[31m❌ 不一致（实际 ${a}）\x1b[0m`);

const bodyString = compactBody(V.body);
const e = explainSign({ ...V, bodyString });

console.log('');
console.log('\x1b[1m=== 虚拟货源签名 · 官方测试向量校验 ===\x1b[0m');
console.log(`  body        : ${bodyString}`);
console.log(`  bodyMd5     : ${e.bodyMd5}`);
console.log(`  期望        : ${V.expectBodyMd5}   ${ok(e.bodyMd5, V.expectBodyMd5)}`);
console.log('');
console.log(`  签名原料     : ${e.signSource}`);
console.log(`  sign        : ${e.sign}`);
console.log(`  期望        : ${V.expectSign}   ${ok(e.sign, V.expectSign)}`);

console.log('');
console.log('\x1b[1m=== 边界用例 ===\x1b[0m');
const emptyBrace = md5(compactBody({}));
const empty = md5('');
console.log(`  md5("{}")   : ${emptyBrace}  ${emptyBrace === '99914b932bd37a50b983c5e7c90ae93b' ? '✅' : '❌'}  ← 无 body 时签名字符串`);
console.log(`  md5("")     : ${empty}  ${empty === 'd41d8cd98f00b204e9800998ecf8427e' ? '✅' : '❌'}  ← 官方说两者都可用`);
console.log(`  compactBody(空) : ${JSON.stringify(compactBody(undefined))} / ${JSON.stringify(compactBody(null))} / ${JSON.stringify(compactBody(''))}`);

console.log('');
console.log('\x1b[1m=== 反例：证明参数顺序不可换 ===\x1b[0m');
const wrong1 = md5([V.appId, V.mchSecret, e.bodyMd5, V.timestamp, V.mchId, V.appSecret].join(','));
const wrong2 = md5([V.appId, V.appSecret, e.bodyMd5, V.mchId, V.timestamp, V.mchSecret].join(','));
const wrong3 = md5([V.appId, V.appSecret, e.bodyMd5, V.timestamp, V.mchId, V.mchSecret].join(',')); // 正确
console.log(`  调换两个 secret   : ${wrong1}  ${wrong1 === V.expectSign ? '⚠️ 也命中（说明能区分）' : '✅ 不等于期望，顺序确认'}`);
console.log(`  调换 timestamp/mch : ${wrong2}  ${wrong2 === V.expectSign ? '⚠️ 也命中' : '✅ 不等于期望，顺序确认'}`);
console.log(`  正确顺序          : ${wrong3}  ${wrong3 === V.expectSign ? '✅' : '❌'}`);

console.log('');
console.log('\x1b[1m=== 与开放平台签名的区别（防止混用）===\x1b[0m');
const openSign = md5([V.appId, md5(bodyString), V.timestamp, V.appSecret].join(','));
console.log(`  开放平台 sign = md5(appKey + "," + md5(body) + "," + timestamp + "," + appSecret)`);
console.log(`  本文档 sign   = md5(appId + "," + appSecret + "," + md5(body) + "," + timestamp + "," + mchId + "," + mchSecret)`);
console.log(`  同一组数据用开放平台规则算 = ${openSign}`);
console.log(`  两者${openSign === V.expectSign ? '相同（不可能）' : '不同'} → 两套签名互不通用，切勿复制粘贴`);

const pass = e.bodyMd5 === V.expectBodyMd5 && e.sign === V.expectSign;
console.log('');
console.log(pass ? '\x1b[32m结论：虚拟货源签名实现与官方测试向量完全一致。\x1b[0m' : '\x1b[31m结论：签名实现有误，需排查拼接格式。\x1b[0m');
console.log('');
process.exit(pass ? 0 : 1);
