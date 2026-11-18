/**
 * 商品主图渲染 —— **用代码画，不用 AI 生图**。
 *
 * 为什么不用 AI 生图（这是实测出来的结论）：
 *   · 官方图标画不准（会画成「长得像 Figma 的形状」）
 *   · 中文几乎必乱码，商品图上全是错字
 *   · 会带 AI 生成角标，去不干净
 *   · 每张还要消耗生图额度
 * 用 HTML + 系统已装的 Chrome 无头截图，以上问题全部消失，而且**同类商品可复用同一模板**。
 *
 * 产物默认 1080×1080（闲鱼主图标准 1:1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureLocalDir } from './media';

const exec = promisify(execFile);

const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export type PlatformKind = 'win' | 'mac' | 'web' | 'android' | 'ios';
export type LogoKind = 'figma' | 'ps' | 'brush' | 'plugin' | 'generic';

/** 平台图标 + 默认文案 */
export const PLATFORMS: Record<PlatformKind, { label: string; svg: string; tint: string }> = {
  win: {
    label: 'Windows 版',
    tint: '#4CC2FF',
    svg: '<path d="M0 3.449 9.75 2.1v9.451H0V3.449zm10.949-1.5L24 0v11.4H10.949V1.949zM0 12.6h9.75v9.451L0 20.699V12.6zm10.949 0H24V24l-12.9-1.801V12.6z"/>',
  },
  mac: {
    label: 'macOS 版',
    tint: '#F2F2F2',
    svg: '<path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>',
  },
  ios: {
    label: 'iOS 版',
    tint: '#F2F2F2',
    svg: '<path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>',
  },
  web: {
    label: '浏览器插件',
    tint: '#7FE3FF',
    svg: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3.4a15.6 15.6 0 0 0-1.5-3.5A8 8 0 0 1 18.9 8zM12 4c.9 1.2 1.6 2.5 2 4h-4c.4-1.5 1.1-2.8 2-4zM4.3 14a8 8 0 0 1 0-4h3.9a17 17 0 0 0 0 4H4.3zm.8 2h3.4c.4 1.3.9 2.5 1.5 3.5A8 8 0 0 1 5.1 16zm3.4-8H5.1a8 8 0 0 1 4.9-3.5A15.6 15.6 0 0 0 8.5 8zM12 20a13.7 13.7 0 0 1-2-4h4a13.7 13.7 0 0 1-2 4zm2.4-6H9.6a15 15 0 0 1 0-4h4.8a15 15 0 0 1 0 4zm1.5 5.5c.6-1 1.1-2.2 1.5-3.5h3.4a8 8 0 0 1-4.9 3.5zm1.9-5.5a17 17 0 0 0 0-4h3.9a8 8 0 0 1 0 4h-3.9z"/>',
  },
  android: {
    label: 'Android 版',
    tint: '#8BE28B',
    svg: '<path d="M6 9h12v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9zm-3 .5a1.5 1.5 0 0 1 3 0v6a1.5 1.5 0 0 1-3 0v-6zm18 0a1.5 1.5 0 0 1 3 0v6a1.5 1.5 0 0 1-3 0v-6zM7.5 8a5 5 0 0 1 9 0h-9zm1.3-3.2-.9-1.6a.4.4 0 0 1 .7-.4l.9 1.6a6.6 6.6 0 0 1 5 0l.9-1.6a.4.4 0 0 1 .7.4l-.9 1.6A5.7 5.7 0 0 0 12 5.5c-1.2 0-2.4.3-3.2.8zM8 16h8v3H8v-3z"/>',
  },
};

/** 主图标 */
export const LOGOS: Record<LogoKind, { svg: string; ratio: number; glow: string }> = {
  figma: {
    // Figma 官方 logo：5 个形状，比例 38:57
    ratio: 38 / 57,
    glow: 'rgba(162,89,255,.5)',
    svg: `<path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"/>
      <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"/>
      <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"/>
      <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"/>
      <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"/>`,
  },
  ps: {
    // Photoshop 官方图标：深蓝底 + 浅蓝描边 + 「Ps」字样
    ratio: 1,
    glow: 'rgba(49,168,255,.55)',
    svg: `<rect x="2" y="2" width="44" height="44" rx="9" fill="#001E36" stroke="#31A8FF" stroke-width="3"/>
      <text x="24" y="33.5" text-anchor="middle" font-family="Helvetica Neue,Helvetica,Arial,sans-serif"
            font-size="23" font-weight="700" letter-spacing="-0.5" fill="#31A8FF">Ps</text>`,
  },
  brush: {
    ratio: 1,
    glow: 'rgba(255,122,24,.45)',
    svg: `<path fill="#FF7A18" d="M28 6c6 0 10 4 10 9 0 4-2 7-6 9l-3 2v5c0 2-2 4-4 4h-6c-2 0-4-2-4-4v-5c0-2 1-4 2-5-4-2-7-6-7-11 0-5 4-9 10-9z"/>
      <path fill="#FFD08A" d="M14 30h12v6c0 1-1 2-2 2h-8c-1 0-2-1-2-2v-6z"/>`,
  },
  plugin: {
    ratio: 1,
    glow: 'rgba(26,188,254,.42)',
    svg: `<path fill="#1ABCFE" d="M18 8a5 5 0 0 1 10 0v3h4a2 2 0 0 1 2 2v4h-3a5 5 0 0 0 0 10h3v4a2 2 0 0 1-2 2h-4v-3a5 5 0 0 0-10 0v3h-4a2 2 0 0 1-2-2v-4h3a5 5 0 0 0 0-10h-3v-4a2 2 0 0 1 2-2h4V8z"/>`,
  },
  generic: {
    ratio: 1,
    glow: 'rgba(120,140,255,.42)',
    svg: `<rect x="4" y="4" width="18" height="18" rx="5" fill="#7C8CFF"/>
      <rect x="10" y="10" width="6" height="6" rx="1.6" fill="#0B1220"/>`,
  },
};

export interface CardSpec {
  /** 主标题（会做字数自适应缩小） */
  title: string;
  /** 标题里用品牌渐变色显示的前缀，如 'Figma' */
  brandHighlight?: string;
  subtitle?: string;
  /** 左上角徽章，默认「自动发货」 */
  badge?: string;
  platforms?: PlatformKind[];
  logo?: LogoKind;
  /**
   * 用软件**官方图标**代替内置 SVG 主图标（本地文件路径或 file:// URL）。
   *
   * 为什么要支持这个：内置 LOGOS 只有 figma / ps / brush / plugin / generic 五个，
   * 遇到不在清单里的软件只能落到「generic」那块蓝方块 —— 而软件自己的图标辨识度
   * 高得多，也让封面不至于互相长得一样。放 `assets/<资源id>/icon.png` 即自动启用。
   */
  logoImage?: string;
  footnote?: string;
  /** 背景渐变的两个端点色 */
  bgFrom?: string;
  bgTo?: string;
  size?: number;
}

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** 生成商品图 HTML。纯字符串模板，方便以后加字段。 */
export function renderCardHtml(spec: CardSpec): string {
  const size = spec.size ?? 1080;
  const logo = LOGOS[spec.logo ?? 'generic'];
  const badge = spec.badge ?? '自动发货';
  const plats = (spec.platforms ?? ['win', 'mac']).map((k) => PLATFORMS[k]).filter(Boolean);
  const bgFrom = spec.bgFrom ?? '#0B1220';
  const bgTo = spec.bgTo ?? '#241046';

  // 标题过长时自动缩字号，避免溢出
  const titleLen = [...spec.title].length;
  const titleSize = titleLen <= 10 ? 96 : titleLen <= 14 ? 80 : titleLen <= 18 ? 66 : 54;

  // 有官方图标就用图片，否则用内置 SVG。
  // 图标本身多为圆角带透明通道，这里统一按 240 渲染并加圆角兜底，避免方形图顶在深色底上太生硬。
  const logoHtml = spec.logoImage
    ? `<img class="logo" src="${esc(spec.logoImage)}" width="240" height="240" alt="">`
    : `<svg class="logo" viewBox="${spec.logo === 'figma' ? '0 0 38 57' : '0 0 48 48'}"
         style="height:240px;width:${Math.round(240 * (logo.ratio || 1))}px">
      ${logo.svg}
    </svg>`;

  const titleHtml = spec.brandHighlight && spec.title.startsWith(spec.brandHighlight)
    ? `<span class="hl">${esc(spec.brandHighlight)}</span>${esc(spec.title.slice(spec.brandHighlight.length))}`
    : esc(spec.title);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${size}px;height:${size}px;overflow:hidden}
  body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;position:relative;
    background:radial-gradient(1200px 700px at 78% -8%, rgba(162,89,255,.40), transparent 62%),
               radial-gradient(900px 620px at 8% 104%, rgba(26,188,254,.24), transparent 60%),
               linear-gradient(158deg, ${bgFrom} 0%, ${bgTo} 100%);
    color:#fff}
  .deco{position:absolute;border-radius:999px;opacity:.15}
  .d1{width:300px;height:300px;background:#F24E1E;top:-90px;left:-70px}
  .d2{width:210px;height:210px;background:#1ABCFE;bottom:120px;right:-70px;opacity:.12}
  .d3{width:130px;height:130px;background:#0ACF83;top:250px;right:90px;opacity:.11;border-radius:34px}
  .d4{width:90px;height:90px;background:#FF7262;bottom:300px;left:78px;opacity:.13;border-radius:26px}
  .card{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:96px 80px 0;text-align:center}
  .badge{position:absolute;top:74px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;
    padding:17px 42px;border-radius:999px;background:linear-gradient(96deg,#FF7A18,#FF3D6E);
    box-shadow:0 16px 44px rgba(255,77,72,.42);font-size:40px;font-weight:800;letter-spacing:4px;white-space:nowrap}
  .badge svg{width:40px;height:40px}
  .logo{margin-bottom:48px;filter:drop-shadow(0 22px 54px ${logo.glow})}
  img.logo{border-radius:54px;object-fit:contain}
  .title{font-size:${titleSize}px;font-weight:800;letter-spacing:2px;line-height:1.1}
  .title .hl{background:linear-gradient(94deg,#1ABCFE,#A259FF 55%,#FF7262);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{margin-top:22px;font-size:34px;font-weight:500;color:rgba(255,255,255,.72);letter-spacing:1px}
  .plats{display:flex;gap:20px;margin-top:58px;flex-wrap:wrap;justify-content:center}
  .plat{display:flex;align-items:center;gap:14px;padding:18px 32px;border-radius:20px;
    background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.17);
    font-size:31px;font-weight:600;letter-spacing:.5px}
  .plat svg{width:38px;height:38px}
  .foot{position:absolute;bottom:62px;left:0;right:0;font-size:25px;letter-spacing:1.6px;color:rgba(255,255,255,.42)}
</style></head><body>
  <div class="deco d1"></div><div class="deco d2"></div><div class="deco d3"></div><div class="deco d4"></div>
  <div class="card">
    ${badge ? `<div class="badge"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/></svg>${esc(badge)}</div>` : ''}
    ${logoHtml}
    <div class="title">${titleHtml}</div>
    ${spec.subtitle ? `<div class="sub">${esc(spec.subtitle)}</div>` : ''}
    ${plats.length ? `<div class="plats">${plats.map((p) => `<div class="plat"><svg viewBox="0 0 24 24"><g fill="${p.tint}">${p.svg}</g></svg>${esc(p.label)}</div>`).join('')}</div>` : ''}
    ${spec.footnote ? `<div class="foot">${esc(spec.footnote)}</div>` : ''}
  </div>
</body></html>`;
}

export interface RenderResult {
  path: string;
  htmlPath: string;
  bytes: number;
  size: number;
}

/**
 * 渲染商品图：写临时 HTML → Chrome 无头截图 → 输出 PNG。
 *
 * 用系统已装的 Chrome 是刻意的选择 —— 本机没有 rsvg / ImageMagick / sharp，
 * 装一套 SVG 渲染链要费不少事，而 Chrome 本来就在，截图质量还更好（字体渲染一致）。
 */
export async function renderCard(spec: CardSpec, outFile?: string): Promise<RenderResult> {
  const dir = ensureLocalDir();
  const size = spec.size ?? 1080;
  const base = (outFile ? path.basename(outFile).replace(/\.(png|jpg|jpeg)$/i, '') : `card-${Date.now()}`) || 'card';
  const htmlPath = path.join(dir, `${base}.html`);
  const pngPath = outFile ? (path.isAbsolute(outFile) ? outFile : path.join(dir, outFile)) : path.join(dir, `${base}.png`);

  if (!fs.existsSync(CHROME)) throw new Error(`没找到 Chrome：${CHROME}（可用 CHROME_PATH 指定）`);

  fs.writeFileSync(htmlPath, renderCardHtml({ ...spec, size }), 'utf8');

  await exec(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${size},${size}`,
      `--screenshot=${pngPath}`,
      `file://${encodeURI(htmlPath)}`,
    ],
    { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
  );

  if (!fs.existsSync(pngPath)) throw new Error('Chrome 未产出截图文件');
  return { path: pngPath, htmlPath, bytes: fs.statSync(pngPath).size, size };
}
