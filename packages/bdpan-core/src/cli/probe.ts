/**
 * 探测脚本：自动找出本应用的专属目录名。
 *
 * 背景：文件类接口只允许访问 /apps/{appname}，但「应用名」在建应用时确定，
 * 控制台上不一定好找。这里探性地列一下根目录和 /apps，把候选目录打出来。
 *
 * 注意：/xpan/file?method=list 不在官方的目录限制名单内，因此有机会列出根目录；
 * 若接口拒绝，则说明本应用确实被限制在应用目录内，需要人工到控制台确认应用名。
 */
import { panGet } from '../http';
import { getAccessToken, tokenStatus } from '../token';
import { APP_NAME } from '../env';

function human(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return n + ' B';
}

async function tryList(dir: string) {
  const access_token = await getAccessToken();
  try {
    const json = await panGet('/rest/2.0/xpan/file', {
      method: 'list',
      access_token,
      dir,
      order: 'name',
      limit: 200,
      folder: 0,
    });
    return { ok: true as const, list: (json.list ?? []) as any[] };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
}

async function main() {
  console.log('=== 应用目录探测 ===\n');
  console.log(`令牌状态 : ${tokenStatus()}`);
  console.log(`已配置应用名 : ${APP_NAME() || '（未配置）'}\n`);

  for (const dir of ['/', '/apps']) {
    console.log(`--- 尝试列出 ${dir} ---`);
    const r = await tryList(dir);
    if (!r.ok) {
      console.log(`  被拒绝：${r.error}\n`);
      continue;
    }
    const dirs = r.list.filter((e) => e.isdir === 1);
    const files = r.list.filter((e) => e.isdir === 0);
    console.log(`  可列出，共 ${r.list.length} 条（目录 ${dirs.length} / 文件 ${files.length}）`);
    for (const d of dirs) console.log(`    DIR  ${d.path}`);
    for (const f of files.slice(0, 10)) console.log(`    FILE ${human(f.size)}  ${f.path}`);
    if (files.length > 10) console.log(`    ... 另外 ${files.length - 10} 个文件`);
    console.log('');
  }

  console.log('如果上面列出了 /apps 下的子目录，那个目录名就是「应用名」，');
  console.log('把它填入 .env 的 BDPAN_APP_NAME 即可。');
}

main().catch((err) => {
  console.error('\n探测失败：', err?.message ?? err);
  process.exit(1);
});
