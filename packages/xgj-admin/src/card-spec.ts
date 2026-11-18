/**
 * 商品图规格推断 —— 从「资源条目」推出一张图该长什么样。
 *
 * 抽成独立模块是因为 CLI（scripts/make-card.ts）和后台服务端都要用它：
 * 出口只有一处，避免两边规则漂移（这正是「网页生成的图和命令行生成的不一样」的常见来源）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceEntry } from './resources';
import type { CardSpec, LogoKind, PlatformKind } from './card-render';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * 找该资源的**官方图标**：`assets/<资源id>/icon.png`（也接受 .webp / .jpg）。
 *
 * 约定成「按资源 id 命名」而不是写进资源条目，是为了少一个要手填的字段：
 * 想把封面主图标换成软件真图标，把图丢进对应目录就行。
 */
function officialIcon(id: string): string | undefined {
  for (const ext of ['png', 'webp', 'jpg', 'jpeg']) {
    const p = path.join(ROOT, 'assets', id, `icon.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** 从资源条目推断配图规格 */
export function specFor(r: ResourceEntry): CardSpec {
  const folders = (r.baidu?.folders?.length ? r.baidu.folders : r.quark?.folders) ?? [];
  const joined = folders.join(' ').toLowerCase();

  const platforms: PlatformKind[] = [];
  if (/mac|m1|m2|intel|dmg/.test(joined)) platforms.push('mac');
  if (/win|x64|windows/.test(joined)) platforms.push('win');
  if (/插件|chrome|edge|browser|plugin/.test(joined)) platforms.push('web');
  if (/安卓|android|apk/.test(joined)) platforms.push('android');
  if (!platforms.length) platforms.push('win', 'mac');

  const name = r.display_name || r.name;
  const probe = `${r.id} ${name}`.toLowerCase();
  const logo: LogoKind = /figma/.test(probe)
    ? 'figma'
    : /photoshop|\bps\b|ps 20/.test(probe)
      ? 'ps'
      : /笔刷|brush|procreate/.test(probe)
        ? 'brush'
        : /插件|plugin|扩展/.test(probe)
          ? 'plugin'
          : 'generic';

  // 标题开头的英文品牌名，用品牌色渐变显示
  const m = name.match(/^([A-Za-z][A-Za-z0-9.+]{1,12})/);
  const brandHighlight = m ? m[1] : undefined;

  // 副标题：优先用手填的 card_subtitle；否则把「figma - mac版」这类目录名压成「mac版 · win版」
  const verTags = folders
    .map((f) => f.replace(/^.*?[-–—]\s*/, '').trim())
    .filter((v) => v && v.length <= 8 && v !== r.name);
  const inferred = verTags.length ? [...new Set(verTags)].join(' · ') : undefined;
  const subtitle = r.card_subtitle?.trim() || inferred;

  return {
    title: name,
    brandHighlight,
    subtitle,
    platforms,
    logo,
    logoImage: officialIcon(r.id),
    badge: '自动发货',
    footnote: '拍下后自动发货 · 请及时转存到自己的网盘',
  };
}
