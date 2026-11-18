import { list } from '../packages/bdpan-core/src/files';
const dir = process.argv[2];
const rows = await list({ dir, limit: 1000, order: 'size', desc: 1 });
const f = rows.filter(r => r.isdir === 0);
const d = rows.filter(r => r.isdir === 1);
const human = (n: number) => n >= 1024**3 ? (n/1024**3).toFixed(2)+' GB' : n >= 1024**2 ? (n/1024**2).toFixed(1)+' MB' : (n/1024).toFixed(0)+' KB';
console.log(`\n${dir}  ——  文件 ${f.length} / 子目录 ${d.length}\n`);
for (const r of f) console.log(`  ${human(r.size).padStart(10)}  ${r.server_filename}`);
if (d.length) { console.log('\n  [子目录]'); for (const r of d) console.log(`  ${''.padStart(10)}  ${r.server_filename}/`); }
