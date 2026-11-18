/**
 * 递归盘点给定目录：文件数、总大小、扩展名分布、最深几层的文件名。
 *
 * 用法：npm run inspect -- "<目录1>" "<目录2>" ...
 *
 * 用途：上架前搞清楚「一个目录到底有多少东西、多大、都是什么格式」，
 * 用来写商品文案和判断该用卡密池还是共享链接模式。
 */
import { list } from '../packages/bdpan-core/src/files';

const human = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB'
  : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + ' KB'
  : n + ' B';

interface Stat {
  files: number;
  dirs: number;
  bytes: number;
  ext: Map<string, { n: number; bytes: number }>;
  samples: string[];
  maxDepth: number;
}

async function walk(dir: string, depth: number, st: Stat, label: string) {
  let rows: Awaited<ReturnType<typeof list>> = [];
  try {
    rows = await list({ dir, limit: 2000 });
  } catch (e: any) {
    console.log(`  ⚠️ 读不到 ${dir}：${e?.message ?? e}`);
    return;
  }
  st.maxDepth = Math.max(st.maxDepth, depth);

  for (const r of rows) {
    if (r.isdir === 1) {
      st.dirs++;
      await walk(`${dir}/${r.server_filename}`, depth + 1, st, label);
    } else {
      st.files++;
      st.bytes += r.size ?? 0;
      const m = /\.([A-Za-z0-9]+)$/.exec(r.server_filename);
      const ext = (m ? m[1] : '(无扩展名)').toLowerCase();
      const cur = st.ext.get(ext) ?? { n: 0, bytes: 0 };
      cur.n++;
      cur.bytes += r.size ?? 0;
      st.ext.set(ext, cur);
      if (st.samples.length < 25) st.samples.push(`${'  '.repeat(depth)}${r.server_filename}  (${human(r.size ?? 0)})`);
    }
  }
}

for (const dir of process.argv.slice(2)) {
  const st: Stat = { files: 0, dirs: 0, bytes: 0, ext: new Map(), samples: [], maxDepth: 0 };
  await walk(dir, 1, st, dir);

  console.log('');
  console.log('═'.repeat(74));
  console.log(dir);
  console.log('═'.repeat(74));
  console.log(`  文件 ${st.files} 个 / 子目录 ${st.dirs} 个 / 合计 ${human(st.bytes)} / 最深 ${st.maxDepth} 层`);
  console.log('');
  console.log('  格式分布：');
  const sorted = [...st.ext.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  for (const [ext, v] of sorted.slice(0, 12)) {
    console.log(`    ${ext.padEnd(14)} ${String(v.n).padStart(4)} 个   ${human(v.bytes)}`);
  }
  console.log('');
  console.log('  文件示例（最多 25 条）：');
  for (const s of st.samples) console.log(`    ${s}`);
}
console.log('');
