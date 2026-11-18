import { quota, tokenStatus, uinfo } from '../index';
import { APP_NAME, APP_ID } from '../env';
import { appRoot } from '../paths';

function gb(n: number): string {
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

async function main() {
  console.log('=== 账号与令牌状态 ===\n');
  console.log(`AppID      : ${APP_ID()}`);
  console.log(`应用名     : ${APP_NAME() || '（未配置 BDPAN_APP_NAME）'}`);
  console.log(`本地令牌   : ${tokenStatus()}`);
  try {
    console.log(`应用根目录 : ${appRoot()}`);
  } catch (err) {
    console.log(`应用根目录 : 无法确定 — ${(err as Error).message}`);
  }

  console.log('\n=== 用户信息 (nas/uinfo) ===');
  const info = await uinfo();
  console.log(`网盘用户名 : ${info.netdisk_name ?? '-'}`);
  console.log(`百度账号   : ${info.baidu_name ?? '-'}`);
  console.log(`VIP 类型   : ${info.vip_type ?? '-'}`);

  console.log('\n=== 容量 (/api/quota) ===');
  const q = await quota();
  console.log(`总容量 : ${gb(q.total)}`);
  console.log(`已使用 : ${gb(q.used)}`);
  console.log(`剩余   : ${gb(q.free)}`);
}

main().catch((err) => {
  console.error('\n失败：', err?.message ?? err);
  process.exit(1);
});
