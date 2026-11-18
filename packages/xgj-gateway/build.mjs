/**
 * 把网关打包成**单个 JS 文件**（dist/server.mjs）。
 *
 * 为什么打包：网关是零运行时依赖的（只用 node: 内置模块），
 * 打包后镜像里既不需要 node_modules，也不需要 tsx，
 * 于是可以直接跑在 node:22-alpine 上：镜像小、启动快、没有依赖漂移。
 *
 * esbuild 的解析顺序：
 *   1. 本目录能 resolve 到的 esbuild（monorepo 里就是仓库根的）
 *   2. 仓库根 node_modules
 *   3. 退回 `npx --yes esbuild@<钉住的版本>` —— 这样**把本包单独拷到别的项目里也能打包**
 *
 * ⚠️ 本文件是**纯 JS**（.mjs），不要写 TS 语法。
 */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINNED_ESBUILD = '0.28.2';
const ENTRY = 'src/cli/serve.ts';
const OUTFILE = 'dist/server.mjs';
const BANNER = '// 闲管家虚拟货源网关 —— 由 build.mjs 打包，请勿直接编辑。';

/** 打包参数只写一处，两条路径（API / CLI）必须完全一致 */
const BUILD_OPTIONS = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
};

const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

async function loadEsbuild() {
  const candidates = ['esbuild', path.join(HERE, '..', '..', 'node_modules', 'esbuild', 'lib', 'main.js')];
  for (const c of candidates) {
    try {
      const mod = await import(c.startsWith('/') ? `file://${c}` : c);
      return mod.default ?? mod;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true });
const esbuild = await loadEsbuild();
let how = '';

if (esbuild) {
  const result = await esbuild.build({
    entryPoints: [path.join(HERE, ENTRY)],
    outfile: path.join(HERE, OUTFILE),
    ...BUILD_OPTIONS,
    banner: { js: BANNER },
    metafile: true,
  });
  how = '本地 esbuild';
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    console.log(`   入口 ${file}，含 ${Object.keys(info.inputs).length} 个源文件`);
  }
} else {
  // 兜底：没有本地 esbuild 时用 npx 拉一个，版本钉死避免打包结果漂移
  console.log(`ℹ️ 未找到本地 esbuild，改用 npx esbuild@${PINNED_ESBUILD}`);
  const args = ['--yes', `esbuild@${PINNED_ESBUILD}`, ENTRY];
  for (const [k, v] of Object.entries(BUILD_OPTIONS)) {
    if (typeof v === 'boolean') {
      if (v) args.push(`--${kebab(k)}`);
    } else {
      args.push(`--${kebab(k)}=${v}`);
    }
  }
  // banner 是对象，CLI 需要单独传
  args.push(`--banner:js=${BANNER}`, `--outfile=${OUTFILE}`);
  const r = spawnSync('npx', args, { cwd: HERE, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('❌ 打包失败。请先 `npm i -D esbuild`，或确保能访问 npm registry。');
    process.exit(r.status ?? 1);
  }
  how = 'npx esbuild';
}

const out = path.join(HERE, OUTFILE);
const bytes = fs.statSync(out).size;
console.log(`✅ 已打包 ${OUTFILE}  ${(bytes / 1024).toFixed(1)} KB（${how}）`);
