/**
 * 资源校验与草稿编码的回归测试。
 *
 * 这两个函数是「脏数据进不了线上」的最后一道闸：
 *   · validateResource 漏判 → 缺发货链接或缺封面的商品被放行到闲鱼
 *   · draftCodeFor 生成重复 code → 两个资源抢同一份草稿，互相覆盖
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateResource,
  CATEGORIES,
  categoryOf,
  defaultPriceFor,
  type ResourceEntry,
} from '../packages/xgj-admin/src/resources';
import { draftCodeFor } from '../packages/xgj-admin/src/publish-draft';

function base(over: Partial<ResourceEntry> = {}): ResourceEntry {
  return {
    id: 'gfx-1',
    name: '演示资源',
    display_name: '演示资源3D模型',
    category: '3d-model',
    baidu: { root: '', share_url: 'https://pan.baidu.com/s/abc?pwd=1234', pwd: '1234', folders: [] },
    quark: { root: '', share_url: '', pwd: '', folders: [] },
    cover_images: ['https://xgj.fmkj.top/goods/gfx-1.png'],
    created_at: '',
    updated_at: '',
    ...over,
  };
}

const blockersOf = (r: ResourceEntry) =>
  validateResource(r).filter((i) => i.level === 'blocker').map((i) => i.field);

test('validateResource：正常条目没有阻塞项', () => {
  assert.deepEqual(blockersOf(base()), []);
});

test('validateResource：两侧都没有分享链接 → 阻塞（发货内容就是它）', () => {
  const r = base({
    baidu: { root: '', share_url: '', pwd: '', folders: [] },
    quark: { root: '', share_url: '', pwd: '', folders: [] },
  });
  assert.ok(blockersOf(r).includes('share_url'));
});

test('validateResource：只有夸克链接也算合格（不强制百度）', () => {
  const r = base({
    baidu: { root: '', share_url: '', pwd: '', folders: [] },
    quark: { root: '', share_url: 'https://pan.quark.cn/s/xyz', pwd: 'ab12', folders: [] },
  });
  assert.deepEqual(blockersOf(r), []);
});

test('validateResource：分享链接不是 http/https → 阻塞', () => {
  const r = base({ baidu: { root: '', share_url: 'pan.baidu.com/s/abc', pwd: '1', folders: [] } });
  assert.ok(blockersOf(r).includes('baidu.share_url'));
});

test('validateResource：封面图不是公网 URL → 阻塞', () => {
  const r = base({ cover_images: ['/local/path.png'] });
  assert.ok(blockersOf(r).some((f) => f.startsWith('cover_images')));
});

test('validateResource：缺提取码只警告不阻塞', () => {
  const r = base({ baidu: { root: '', share_url: 'https://pan.baidu.com/s/abc', pwd: '', folders: [] } });
  const issues = validateResource(r);
  assert.deepEqual(issues.filter((i) => i.level === 'blocker'), []);
  assert.ok(issues.some((i) => i.level === 'warn' && i.field === 'baidu.pwd'));
});

test('validateResource：缺展示名 → 阻塞', () => {
  assert.ok(blockersOf(base({ display_name: '   ' })).includes('display_name'));
});

/* ------------------------- 类别与定价 ------------------------- */

test('类别：素材类发素材店、插件软件类发插件店（用户定的分工）', () => {
  assert.equal(categoryOf('3d-model')?.shop, 'xy346883759115');
  assert.equal(categoryOf('blender-asset')?.shop, 'xy346883759115');
  assert.equal(categoryOf('blender-plugin')?.shop, '顺和服饰平价超市');
  assert.equal(categoryOf('design-software')?.shop, '顺和服饰平价超市');
});

test('类别默认价符合既定策略', () => {
  assert.equal(defaultPriceFor('3d-model'), 288);
  assert.equal(defaultPriceFor('blender-plugin'), 188);
  assert.equal(defaultPriceFor('blender-asset'), 188);
  assert.equal(defaultPriceFor('design-software'), 990);
  assert.equal(defaultPriceFor('不存在的类别'), undefined);
});

test('类别 id 唯一', () => {
  const ids = CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ------------------------- 草稿编码 ------------------------- */

test('draftCodeFor：形如 BD-GFX-<ID>，且不同资源不撞车', () => {
  assert.equal(draftCodeFor(base({ id: 'gfx-134632' })), 'BD-GFX-134632');
  assert.notEqual(draftCodeFor(base({ id: 'gfx-1' })), draftCodeFor(base({ id: 'gfx-2' })));
});

test('draftCodeFor：只含安全字符（会被当文件名用）', () => {
  const code = draftCodeFor(base({ id: 'gfx-abc/../..\\x' }));
  assert.match(code, /^[A-Z0-9-]+$/);
  assert.ok(!code.includes('/') && !code.includes('\\') && !code.includes('.'));
});
