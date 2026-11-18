#!/usr/bin/env node
/**
 * 图床工具（原 scripts/make-card.ts 里保留下来的实用命令）。
 *
 *   npm run media -- --ping            检查图床（SSH 连通 + 远端目录可写）
 *   npm run media -- <png路径> --push   上传一张已有的图片
 *
 * 为什么只剩这两条命令：
 *   之前这里还带一个「渲染商品图」的分支，用的是 `card-render.ts` 里那套**旧模板**，
 *   与流水线实际在用的 C2 模板（assets/_shared/card-c2.mjs）不是同一个 ——
 *   两边各出一版图，迟早会有人用错。出图请统一用：
 *       npx tsx scripts/render-covers.mjs --collector <dir> --noun <词> [--pending | <id...>]
 */
import path from 'node:path';
import fs from 'node:fs';
import { uploadImage, pingMedia, mediaReady, mediaConfig } from '../packages/xgj-admin/src/media';

const line = (s = '') => process.stdout.write(s + '\n');
const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const arg = argv.find((a) => !a.startsWith('--'));

  line('');
  line(b('══════ 图床工具 ══════'));
  line('');

  /* ---------- 检查图床 ---------- */
  if (flags.has('--ping')) {
    const cfg = mediaConfig();
    const ready = mediaReady();
    line(`  目标    : ${cfg.target || red('未配置')}`);
    line(`  私钥    : ${cfg.key || red('未配置')}`);
    line(`  远端目录: ${cfg.remoteDir}`);
    line(`  公网前缀: ${cfg.publicBase || red('未配置')}`);
    line('');
    if (!ready.ready) {
      line(red(`  ✗ 配置不全：${ready.missing.join('、')}`));
      line(dim('    在 .env 里补上 MEDIA_SSH_TARGET / MEDIA_SSH_KEY / MEDIA_PUBLIC_BASE'));
      line('');
      process.exit(1);
    }
    const r = await pingMedia();
    line(r.ok ? green(`  ✅ ${r.message}`) : red(`  ✗ ${r.message}`));
    if (r.detail) line(dim(`     ${r.detail}`));
    line('');
    return;
  }

  /* ---------- 上传已有图片 ---------- */
  if (flags.has('--push') && arg) {
    const p = path.resolve(arg);
    if (!fs.existsSync(p)) {
      line(red(`  ✗ 文件不存在：${p}`));
      process.exit(1);
    }
    const r = await uploadImage(p);
    line(green(`  ✅ 已上传 ${(r.bytes / 1024).toFixed(0)} KB`));
    line(`     公网地址：${b(r.url)}`);
    line('');
    return;
  }

  line('  用法：');
  line('    npm run media -- --ping             检查图床连通性');
  line('    npm run media -- <png路径> --push    上传一张图片');
  line('');
  line(dim('  要批量出商品图请用：npx tsx scripts/render-covers.mjs --collector <dir> --noun <词> --pending'));
  line('');
  process.exit(2);
}

main().catch((e) => {
  line('');
  line(red(`  ✗ ${e?.message ?? e}`));
  line('');
  process.exit(1);
});
