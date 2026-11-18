import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  buildAuthUrl,
  exchangeCode,
  extractCode,
  loadToken,
  tokenStatus,
  uinfo,
} from '../index';
import { APP_ID, REDIRECT_URI } from '../env';

const urlOnly = process.argv.includes('--url');

async function main() {
  console.log('=== 百度网盘 OAuth 授权 ===\n');
  console.log(`应用 AppID : ${APP_ID()}`);
  console.log(`回调地址    : ${REDIRECT_URI()}`);
  console.log(`当前状态    : ${tokenStatus()}\n`);

  const url = buildAuthUrl();
  console.log('第 1 步：在浏览器里打开下面这条链接，用你自己的百度账号登录并点击「授权」：\n');
  console.log(url + '\n');

  if (urlOnly) {
    console.log('（--url 模式，仅输出链接）');
    return;
  }

  console.log('第 2 步：授权后页面会显示一串「授权码」，把它整段复制粘贴到下面。');
  console.log('        如果你配置了回调地址，也可以直接粘贴浏览器地址栏里的完整回调 URL。\n');

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question('粘贴授权码后回车：');
  rl.close();

  const code = extractCode(answer);
  if (!code) {
    console.error('\n未识别到授权码，请重试。');
    process.exit(1);
  }

  console.log('\n正在用授权码换取 access_token ...');
  const t = await exchangeCode(code);
  console.log('换取成功，已写入 .tokens.json');
  console.log(`  access_token  有效期至 ${new Date(t.expires_at).toLocaleString('zh-CN')}`);
  console.log(`  refresh_token ${t.refresh_token ? '已保存（一次性，刷新后自动轮换）' : '未返回'}`);

  console.log('\n正在校验 token 有效性 ...');
  try {
    const info = await uinfo();
    console.log('  校验通过：');
    console.log(`    网盘用户名 : ${info.netdisk_name ?? '-'}`);
    console.log(`    百度账号   : ${info.baidu_name ?? '-'}`);
    console.log(`    VIP 类型   : ${info.vip_type ?? '-'}`);
    console.log(`    uk         : ${info.uk ?? '-'}`);
  } catch (err) {
    console.error('  校验失败：', (err as Error).message);
    console.error('  常见原因：scope 参数未包含 netdisk，需带上 scope=basic,netdisk 重新授权。');
    process.exit(1);
  }

  const prev = loadToken();
  console.log(`\n完成。${prev ? '' : ''}下一步可以执行：npm run whoami / npm run scan`);
}

main().catch((err) => {
  console.error('\n授权失败：', err?.message ?? err);
  process.exit(1);
});
