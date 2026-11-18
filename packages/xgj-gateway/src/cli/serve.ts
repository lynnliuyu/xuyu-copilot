/**
 * 启动虚拟货源网关。
 *
 *   npm run serve                 # 默认端口 8787
 *   XGJ_PORT=9000 npm run serve
 *   docker compose up -d          # 见同目录 docker-compose.yml
 *
 * 启动后把「对外可访问的地址」填到闲管家 → 我的应用 → 货源授权信息 → 接口网关。
 */
import { createServer, configSummary } from '../server';
import { createHandlers } from '../handlers';
import { getStore, seedCheckout } from '../store';
import { loadConfig, configProblems } from '../config';

const cfg = loadConfig();
const problems = configProblems(cfg);

if (problems.length) {
  console.error('\n\x1b[31m❌ 配置不完整，网关未启动\x1b[0m');
  for (const p of problems) console.error(`   · ${p}`);
  console.error('');
  console.error('  ⚠️ 两组值来源不同，别搞混：');
  console.error('     XGJ_MCH_ID / XGJ_MCH_SECRET         ← 由**你自定义**，再填进闲管家「货源授权信息」');
  console.error('     GOOFISH_APP_KEY / GOOFISH_APP_SECRET ← 闲管家「应用概况」给出的，用于验签');
  console.error('');
  console.error('  参考同目录 .env.example。\n');
  process.exit(2);
}

const store = getStore();
const seeded = seedCheckout(store);
const s = configSummary(cfg, store);

console.log('');
console.log('\x1b[1m=== 闲管家虚拟货源网关 ===\x1b[0m');
console.log(`  监听端口      : ${s.port}`);
console.log(`  商户号 mch_id : \x1b[1m${s.mchId}\x1b[0m`);
console.log(`  对接密钥      : ${s.mchSecretMasked}`);
console.log(`  管家 app_id   : ${s.appId}  → 查询平台信息将回传整数 ${Number(s.appId)}`);
console.log(`  IP 白名单     : ${s.ipWhitelist ? '开启（只放行闲管家 IP 段）' : '关闭'}`);
console.log(`  数据目录      : ${s.dataDir}${seeded.created ? ' \x1b[33m(已生成样例数据)\x1b[0m' : ''}`);
console.log('');
console.log('  已挂货源商品：');
for (const g of s.goods) console.log(`    · ${g.goods_no}  ${g.name}  可售 ${g.stock}`);
console.log('');
console.log('  对外接口（闲管家 POST 这些路径）：');
for (const p of Object.keys(createHandlers(store, { appId: cfg.appId }).routes)) {
  console.log(`    ${p}`);
}
console.log('');
console.log('  健康检查（无需签名）：GET /__health');
console.log('');

const server = createServer({ config: cfg, store });
server.listen(cfg.port, '0.0.0.0', () => {
  console.log(`\x1b[32m✅ 网关已启动：http://0.0.0.0:${cfg.port}\x1b[0m`);
  console.log('   填到闲管家「货源授权信息 › 接口网关」的应当是**公网可达**的地址，');
  console.log('   例如 http://<公网IP>:' + cfg.port + ' 或 https://<你的域名>');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，关闭网关…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
