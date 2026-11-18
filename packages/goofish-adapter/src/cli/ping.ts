/**
 * 闲管家连通性探针。
 *
 * 用法：
 *   npm run gf:ping            用 .env 里的真实凭证
 *   npm run gf:ping -- --demo  用官方文档里的示例凭证（公共的，谁都拿不到数据，
 *                              但能证明「我们的请求格式被服务端接受」）
 *
 * 它按顺序确认 4 件事，任何一步失败都能定位到具体环节：
 *   1. 网络能否到达 open.goofish.pro
 *   2. 请求格式（method / path / Content-Type / body）对不对
 *   3. 签名算法会不会被判为 401
 *   4. 应用是否上线、IP 是否在白名单
 */
import { GoofishClient, GOOFISH_ERRORS, SETUP_ERRORS, GoofishError } from '../client';
import { EP, ITEM_BIZ_TYPE, SP_BIZ_TYPE } from '../endpoints';
import { GOOFISH_APP_KEY, GOOFISH_APP_SECRET, GOOFISH_SELLER_ID } from '../config';

/** 官方《代码示例》里公开的示例凭证，仅用于验证传输层 */
const DEMO = {
  appKey: '203413189371893',
  appSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
};

const line = (s = '') => process.stdout.write(s + '\n');
const ok = (s: string) => line(`  \x1b[32m✅\x1b[0m ${s}`);
const bad = (s: string) => line(`  \x1b[31m❌\x1b[0m ${s}`);
const info = (s: string) => line(`  \x1b[36m·\x1b[0m ${s}`);

async function main() {
  const useDemo = process.argv.includes('--demo');

  const cfg = useDemo
    ? { appKey: DEMO.appKey, appSecret: DEMO.appSecret, qps: 5 }
    : { appKey: GOOFISH_APP_KEY(), appSecret: GOOFISH_APP_SECRET(), sellerId: GOOFISH_SELLER_ID() || undefined, qps: 5 };

  line('');
  line('\x1b[1m=== 闲管家开放平台 连通性探针 ===\x1b[0m');
  line(`  模式      : ${useDemo ? '\x1b[33mDEMO（官方示例凭证）\x1b[0m' : '真实凭证（来自 .env）'}`);
  line(`  appKey    : ${cfg.appKey || '（未配置）'}`);
  line(`  appSecret : ${cfg.appSecret ? cfg.appSecret.slice(0, 6) + '…' + cfg.appSecret.slice(-4) : '（未配置）'}`);
  if (cfg.sellerId) line(`  seller_id : ${cfg.sellerId}（商务对接模式）`);
  line('');

  if (!cfg.appKey || !cfg.appSecret) {
    line('\x1b[33m⚠️  .env 中尚未配置 GOOFISH_APP_KEY / GOOFISH_APP_SECRET。\x1b[0m');
    line('    可先用 `--demo` 验证传输层是否正常。');
    line('');
    process.exit(2);
  }

  const client = new GoofishClient(cfg);

  // ---------- 步骤 1：网络可达性 + 路由正确性 ----------
  line('\x1b[1m[1/5] 网络可达性 & 接口路由\x1b[0m');
  try {
    const t0 = Date.now();
    const real = await fetch(`${client.domain}${EP.shopList}?appid=${cfg.appKey}&timestamp=1&sign=x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
    });
    const ms = Date.now() - t0;
    const body = await real.text();
    if (real.status === 200 && body.trim().startsWith('{')) {
      ok(`${client.domain} 可达（${ms}ms），路径 \x1b[1m${EP.shopList}\x1b[0m 是已注册的真实接口`);
      info(`服务端应答：${body.slice(0, 110)}`);
    } else {
      bad(`路径未正确路由（HTTP ${real.status}）：${body.slice(0, 80)}`);
      info('若返回 404 page not found，说明接口路径写错了，请对照 endpoints.ts。');
    }
    // 对照：故意写错路径，确认 404 的形态（用于区分「路径错」与「业务错」）
    const bogus = await fetch(`${client.domain}/api/open/__definitely_not_real__`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    info(`对照（错误路径）：HTTP ${bogus.status} ${(await bogus.text()).slice(0, 40)}`);
  } catch (e: any) {
    bad(`无法连接 ${client.domain}：${e.message}`);
    info('检查本机代理 / 出口网络。若开了全局代理，确认 goofish.pro 未被异常分流。');
    process.exit(1);
  }

  // ---------- 步骤 2：请求组装（dry-run 打印） ----------
  line('');
  line('\x1b[1m[2/5] 请求组装（dry-run，不发送）\x1b[0m');
  const built = client.buildRequest(EP.shopList, {});
  info(`URL     : ${built.url.replace(cfg.appKey, cfg.appKey.slice(0, 6) + '…')}`);
  info(`Method  : ${built.method}`);
  info(`Headers : ${JSON.stringify(built.headers)}`);
  info(`Body    : ${built.body}`);
  info(`bodyMd5 : ${built.debug.bodyMd5}`);
  info(`签名原文: ${built.debug.signSource}`);
  ok('请求已组装（method=POST，鉴权在 query，body 为压缩 JSON）');

  // ---------- 步骤 3：签名算法自检（离线，对官方向量） ----------
  line('');
  line('\x1b[1m[3/5] 签名算法自检（对官方测试向量，离线）\x1b[0m');
  {
    const { md5, genSign, compactBody } = await import('../sign');
    const vec = {
      appKey: '203413189371893',
      appSecret: 'o9wl81dncmvby3ijpq7eur456zhgtaxs',
      timestamp: 1636087298,
      bodyString: compactBody({ product_id: '219530767978565' }),
    };
    const got = genSign(vec);
    const expect = 'c26c8a48809141f3dd80bd9b9ddb41ea';
    if (got === expect) {
      ok(`genSign() 与官方《接入说明》测试向量一致（${got}）`);
      info(`bodyMd5 中间值也一致：${md5(vec.bodyString)}`);
    } else {
      bad(`签名与官方向量不一致：得到 ${got}，期望 ${expect}`);
    }
  }

  // ---------- 步骤 4：真实调用 ----------
  line('');
  line('\x1b[1m[4/5] 真实调用（查询闲鱼店铺）\x1b[0m');
  try {
    const resp = await client.call<{ list?: any[] }>(EP.shopList, {});
    ok(`服务端返回 code=0 —— 签名被接受、应用已上线、IP 在白名单`);
    const shops = resp.data?.list ?? [];
    line(`     msg: ${resp.msg}`);
    line(`     店铺数: ${shops.length}`);
    for (const s of shops) {
      const exp = s.authorize_expires
        ? new Date(Number(s.authorize_expires) * 1000).toISOString().slice(0, 10)
        : '未知';
      line(`       - ${s.user_name ?? s.nick ?? '(无名)'}  授权到期 ${exp}  user_id=${s.user_id ?? '-'}`);
    }
    if (!shops.length) {
      line('');
      line('\x1b[33m     ⚠️ 店铺列表为空。检查：该闲鱼店铺是否订购了 ERP 专业版/铂金版并完成授权。\x1b[0m');
    }
  } catch (e: any) {
    if (e instanceof GoofishError) {
      bad(`服务端返回 code=${e.code} ${(e.raw as any)?.msg ?? ''}`);
      const hint = GOOFISH_ERRORS[e.code];
      if (hint) line(`     → ${hint}`);
      line('');
      if (e.code === 401) {
        line('\x1b[1m  401 签名错误 排查清单：\x1b[0m');
        line('    1) appid 与 appKey 是否用的是同一个值（官方代码里 url 的 appid 就是 appKey）');
        line('    2) appSecret 是否复制完整（含末尾字符、无空格）');
        line('    3) body 是否为**压缩 JSON**（不能有缩进空格）');
        line('    4) 本机时间是否准确（时间戳 5 分钟有效）');
        line('    5) 是否误把 seller_id 加进签名（仅商务对接模式才加）');
      } else if (e.code === 403) {
        line('\x1b[1m  403 IP 不在白名单 排查清单：\x1b[0m');
        line('    1) 去闲管家「我的应用」填写**当前出口公网 IP**');
        line('    2) 本机若走代理，出口 IP 是代理服务器的，不是宽带的');
        line('    3) 家宽 IP 会变动，需定期维护或改用固定 IP 的服务器');
        line('');
        const ip = await fetch('https://api.ipify.org')
          .then((r) => r.text())
          .catch(() => null);
        if (ip) line(`    当前出口 IP（直连探测）：\x1b[1m${ip}\x1b[0m  ← 把这个填进白名单`);
      } else if (e.code === 408) {
        line('  → 本机系统时间与标准时间偏差过大，请校准 NTP。');
      } else {
        line('  → 若提示「应用不存在或已下线」：应用必须是**进销存类型**且**已上线**。');
      }
    } else {
      bad(`${e.message}`);
    }
    line('');
    line('\x1b[33m  ⚠️ 诚实说明：服务端的校验顺序是「先查 AppID，再验签名」。\x1b[0m');
    line('     所以「应用不存在或已下线」只能证明【请求格式与接口路径正确】，');
    line('     \x1b[1m不能证明签名被接受\x1b[0m —— 应用不存在时服务端拿不到 appSecret，无从验签。');
    line('     签名的可靠性由 [3/5] 的官方向量自检保证；真实验签要等填上你的 appKey 才能确认。');
  }

  // ---------- 收尾提示 ----------
  line('');
  line('\x1b[1m[5/5] 下一步\x1b[0m');
  line('  探针通过后，可依次执行：');
  line('    npm run gf:draft   生成商品草稿并预览真实请求');
  line('    npm run gf:publish 创建 + 上架（需 GOOFISH_LIVE=true）');
  line('');
}

main().catch((e) => {
  line(`\n\x1b[31m探针异常终止：${e?.stack ?? e}\x1b[0m`);
  process.exit(1);
});
