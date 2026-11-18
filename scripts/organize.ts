/**
 * 网盘整理执行器。
 *
 * 设计原则：
 *  1. **只移动，不删除**（删除单独走 --purge-delete，需显式二次确认）
 *  2. 先 dry-run 预览，加 --apply 才真正执行
 *  3. 移动是元数据操作，瞬时完成且可逆（反向 move 即可还原）
 *  4. 两台设备备份目录（来自：iPhone / 来自：iPad）**不动** —— 那是网盘 App 自动备份的落地目录，
 *     改路径可能影响手机备份任务
 */
import { list, mkdir, filemanager } from '../packages/bdpan-core/src/files';

const APPLY = process.argv.includes('--apply');

/** 目标顶层目录 */
const DIRS = ['/00-资源池', '/01-工具与教程', '/09-归档', '/99-侵权待复核'];

/** [源, 目标父目录] */
const MOVES: Array<[string, string]> = [
  // 潜在可售资源集中管理
  ['/淘宝出售类', '/00-资源池'],
  ['/我的资源', '/00-资源池'],
  ['/材质系列', '/00-资源池'],
  ['/立面系列', '/00-资源池'],
  ['/平面系列', '/00-资源池'],
  ['/室内设计专用Procreate笔刷', '/00-资源池'],
  ['/小米智能家居设计方案智家装全屋灯光设备点位布局清单网开关系统', '/00-资源池'],
  // 工具与教程
  ['/blender软件', '/01-工具与教程'],
  ['/新版chatGPT安装', '/01-工具与教程'],
  ['/HA自媒体分享', '/01-工具与教程'],
  // 归档
  ['/来自：AI笔记', '/09-归档'],
  ['/云一朵知识问答', '/09-归档'],
  ['/qq空间恢复', '/09-归档'],
  ['/来自：本地电脑', '/09-归档'],
];

const human = (n: number) =>
  n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';

async function main() {
  console.log(`=== 网盘整理 ${APPLY ? '【正式执行】' : '【dry-run 预览】'} ===\n`);

  const root = await list({ dir: '/', limit: 500 });
  const names = new Set(root.map((e) => e.server_filename));

  console.log(`根目录当前 ${root.length} 项\n`);

  console.log('--- 第 1 步：创建目标目录 ---');
  for (const d of DIRS) {
    const name = d.slice(1);
    if (names.has(name)) {
      console.log(`  跳过（已存在）  ${d}`);
      continue;
    }
    if (!APPLY) {
      console.log(`  [预览] 创建      ${d}`);
      continue;
    }
    try {
      const r = await mkdir(d);
      console.log(`  已创建          ${r.path ?? d}`);
    } catch (e: any) {
      console.log(`  失败            ${d}  ${String(e.message).split('\n')[0]}`);
    }
  }

  console.log('\n--- 第 2 步：移动目录 ---');
  const results: Array<{ src: string; ok: boolean }> = [];
  for (const [src, dest] of MOVES) {
    const name = src.slice(1);
    if (!names.has(name)) {
      console.log(`  跳过（不存在）  ${src}`);
      continue;
    }
    if (!APPLY) {
      console.log(`  [预览] ${src}  →  ${dest}/${name}`);
      continue;
    }
    try {
      const r = await filemanager('move', [{ path: src, dest }]);
      const ok = r.info?.[0]?.errno === 0;
      console.log(`  ${ok ? '已移动' : '失败  '}          ${src}  →  ${dest}/${name}`);
      results.push({ src, ok });
    } catch (e: any) {
      console.log(`  失败            ${src}  ${String(e.message).split('\n')[0]}`);
      results.push({ src, ok: false });
    }
  }

  console.log(`\n--- 第 3 步：结果核对 ---`);
  const after = await list({ dir: '/', limit: 500 });
  const shown = after.filter((e) => /^0\d-|^99-|^来自：|^淘宝|^我的资源|^材质|^立面|^平面|^blender|^新版|^HA|^小米|^云一朵|^qq/.test(e.server_filename));
  console.log(`  根目录剩余 ${after.length} 项，其中：`);
  for (const e of after) {
    console.log(`    ${e.isdir === 1 ? 'DIR ' : 'FILE'}  ${e.server_filename}`);
  }

  if (APPLY) {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n  成功 ${results.length - failed.length} / ${results.length}` + (failed.length ? `，失败：${failed.map((f) => f.src).join(', ')}` : ''));
  } else {
    console.log('\n  以上为预览。加 --apply 参数正式执行。');
  }

  // 保持导出，避免未使用告警
  void human;
}

main().catch((e) => {
  console.error('执行失败：', e?.message ?? e);
  process.exit(1);
});
