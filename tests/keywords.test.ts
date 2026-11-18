/**
 * 关键词与标题生成的最小回归测试。
 *
 * 为什么优先测这几个函数：
 *   · 标题权重算错 → 闲鱼直接拒收，而且 155 条批量出错很难一眼发现
 *   · 关键词拼装出「3D模型 3D模型」「BlenderBlender插件」这类重复词 → 白占权重位
 *   · 这几处是近期改动最密集的地方，最容易回归
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  titleWeight,
  clampTitle,
  coreName,
  buildTitle,
  keywordLine,
  detectPlatforms,
} from '../packages/xgj-admin/src/keywords';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------- 权重 ------------------------- */

test('titleWeight：汉字/字母 = 1', () => {
  assert.equal(titleWeight('蝴蝶模型'), 4);
  assert.equal(titleWeight('abc'), 3);
});

test('titleWeight：数字与特殊字符各占 2（含空格）', () => {
  assert.equal(titleWeight('3'), 2);
  assert.equal(titleWeight('D'), 1);
  assert.equal(titleWeight('蝴蝶3D模型'), 7); // 2 + 2 + 1 + 2
  assert.equal(titleWeight('a b'), 4); // 1 + 2 + 1
  assert.equal(titleWeight('—'), 2);
});

test('clampTitle：按权重截断，不超上限', () => {
  assert.equal(clampTitle('蝴蝶3D模型', 7), '蝴蝶3D模型');
  assert.equal(clampTitle('蝴蝶3D模型Blender', 7), '蝴蝶3D模型');
  assert.equal(titleWeight(clampTitle('3D模型素材高精度写实', 10)), 10);
  assert.ok(titleWeight(clampTitle('a'.repeat(100), 30)) <= 30);
});

/* ------------------------- 核心名抽取 ------------------------- */

test('coreName：丢掉来源站与英文产品名，保留中文核心', () => {
  assert.equal(coreName('蝴蝶3D模型 Butterfly Realistic 3D Model Pack'), '蝴蝶3D模型');
});

test('coreName：保留有意义的英文 token（3DS / Blender / ZBrush）', () => {
  assert.equal(coreName('ZBrush生物翅膀模型预设 Artstation – Wings – 33 Wings'), 'ZBrush生物翅膀模型预设');
});

test('coreName：多软件前缀不会吞掉后面的中文核心名', () => {
  // 旧逻辑遇到不认识的英文词就 break，会把整条中文核心名丢掉
  const got = coreName('3DS MAX+Blender+Substance Painter 48组8K石头材质预设');
  assert.ok(got.includes('石头材质预设'), `实际得到：${got}`);
});

test('coreName：开头的 Blender 前缀会去掉（后续用平台词补）', () => {
  assert.equal(coreName('Blender各类人物角色3D模型资产 Kanistra People'), '各类人物角色3D模型资产');
});

/* ------------------------- 标题拼装 ------------------------- */

test('buildTitle：不出现重复的品类词（「3D模型 3D模型」）', () => {
  const t = buildTitle({ display_name: '蝴蝶3D模型 Butterfly Realistic 3D Model Pack', category: '3d-model' });
  assert.ok(!/(3D模型)\s+\1/.test(t), `出现重复品类词：${t}`);
});

test('buildTitle：不出现平台名叠字（「BlenderBlender插件」）', () => {
  const t = buildTitle({
    display_name: 'Blender重新网格化插件 Boundary Aligned Remesh',
    category: 'blender-plugin',
  });
  assert.ok(!/Blender\s*Blender/i.test(t), `出现叠字：${t}`);
  assert.ok(t.includes('Blender插件'), `缺少「Blender插件」这个高频搜索词：${t}`);
});

test('buildTitle：不产生「ZBrush3D模型」这类生造词', () => {
  const t = buildTitle({ display_name: 'ZBrush生物翅膀模型预设 Artstation – Wings', category: '3d-model' });
  assert.ok(!/ZBrush3D/.test(t), `生造词：${t}`);
});

test('buildTitle：权重一律不超过 30', () => {
  const t = buildTitle({ display_name: '中世纪女性靴子3D模型 Artstation – Female Boots Set', category: '3d-model' });
  assert.ok(titleWeight(t) <= 30, `${titleWeight(t)} > 30：${t}`);
});

/* ------------------------- 关键词块 ------------------------- */

test('keywordLine：含「平台×名词」交叉词，且无叠字', () => {
  const l = keywordLine({ display_name: '蝴蝶3D模型 Butterfly', category: '3d-model', platforms: ['Blender'] });
  assert.ok(l.startsWith('■ 相关搜索'), l);
  assert.ok(l.includes('Blender模型'), `缺少交叉词：${l}`);
  assert.ok(!/Blender\s*Blender/.test(l), `叠字：${l}`);
  // 不能是一整坨，必须有分隔
  assert.ok(l.includes('、'), '关键词之间应有分隔符');
});

test('keywordLine：词条数量有上限（避免变成纯堆砌）', () => {
  const l = keywordLine({ display_name: '蝴蝶3D模型', category: '3d-model', platforms: ['Blender', 'UE5'] });
  const words = l.split('\n')[1].split('、');
  assert.ok(words.length <= 16, `词条过多：${words.length}`);
  assert.equal(new Set(words).size, words.length, '存在重复词');
});

/* ------------------------- 软件识别 ------------------------- */

test('detectPlatforms：标题命中优先于正文命中', () => {
  // 正文里只是提了句「兼容 Unreal 贴图」，不能把标题写着的 Marvelous 顶掉
  const r = { display_name: '奇幻女性服装3D模型 MD/Clo3d', detailText: '4k and PNG Texture (Unreal Engine + PBR)' };
  assert.equal(detectPlatforms(r)[0], 'Marvelous');
});

test('detectPlatforms：最多返回 2 个', () => {
  const r = { display_name: 'X', detailText: 'blender 3ds max maya zbrush unreal houdini' };
  assert.ok(detectPlatforms(r).length <= 2);
});

/* ------------------------- 全库回归 ------------------------- */

test('全库回归：所有已出链资源的标题权重都在 30 以内、且不为空', () => {
  const cases = [
    { dir: 'assets/gfxcamp-3dmodel', category: '3d-model' },
    { dir: 'assets/gfxcamp-blender', category: 'blender-plugin' },
  ];
  let checked = 0;
  for (const { dir, category } of cases) {
    const rowsFile = path.join(PROJ, dir, 'resources.json');
    if (!fs.existsSync(rowsFile)) continue; // 采集产物未就位时跳过
    const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8')) as Array<{ id: string; title: string }>;
    for (const r of rows) {
      const t = buildTitle({ display_name: r.title, category });
      assert.ok(t.length > 0, `${r.id} 标题为空`);
      assert.ok(titleWeight(t) <= 30, `${r.id} 权重 ${titleWeight(t)} > 30：${t}`);
      checked++;
    }
  }
  assert.ok(checked > 0, '没有读到任何资源，说明路径不对（测试本身失效了）');
});
