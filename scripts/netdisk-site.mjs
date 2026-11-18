#!/usr/bin/env node
/**
 * 由网盘目录树索引生成资源站的数据文件。
 *
 *   输入：out/netdisk-index.json      （npm run tree:netdisk）
 *        netdisk-site/media.json     （npm run media:netdisk，封面/图标映射）
 *        assets/free-software/manifest.json + out/free-software.json（软件的中文说明/版本）
 *   输出：netdisk-site/data.js        （window.__ND__ = {...}）
 *
 * 为什么用独立的 data.js 而不是把数据塞进 HTML：
 *   file:// 下 fetch 本地 json 会被浏览器拦，而 <script src> 不会 ——
 *   这样双击 index.html 就能看，不需要起服务器。
 *
 * 用法：npm run site:netdisk
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'out', 'netdisk-index.json');
const SITE = path.join(ROOT, 'netdisk-site');
const MEDIA = path.join(SITE, 'media.json');

if (!fs.existsSync(SRC)) {
  console.error('❌ 找不到 out/netdisk-index.json —— 先跑 npm run tree:netdisk');
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const media = fs.existsSync(MEDIA)
  ? JSON.parse(fs.readFileSync(MEDIA, 'utf8'))
  : { covers: {}, icons: {} };

// 分享链接台账（npm run share:netdisk 产出）；没有就不显示分享块
const SHARES = path.join(SITE, 'shares.json');
const shares = fs.existsSync(SHARES) ? JSON.parse(fs.readFileSync(SHARES, 'utf8')) : {};

// 软件的中文说明：manifest 按 name 对上网盘目录名，下载结果按 id 给版本号
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'assets', 'free-software', 'manifest.json'), 'utf8'),
);
const metaByName = new Map(manifest.items.map((x) => [x.name, x]));
const verById = new Map();
const RESULT = path.join(ROOT, 'out', 'free-software.json');
if (fs.existsSync(RESULT)) {
  for (const r of JSON.parse(fs.readFileSync(RESULT, 'utf8')).items || []) {
    verById.set(r.id, { version: r.version, bytes: r.bytes, verified: r.verified });
  }
}

const fmtSize = (b) => {
  if (!b) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
};

/* ---------------- 展示层整形（都不动网盘目录） ----------------
   1) 标题去掉来源站的数字 ID 前缀：`100093-Blender多边形切割插件…` → `Blender多边形切割插件…`
      只认「3 位以上数字 + -/_」这种**来源 ID** pattern，避免误伤正常文件名。
   2) 归类：网盘里 3D模型 / Blender建模 是平级的，站点上归到「Blender」大类下两个子类。 */
const DISPLAY_NAME = { '3D模型': 'Blender 模型', 'Blender建模': 'Blender 插件', '00-资源池': '其他资源', 'Adobe 2026 mac': 'Adobe 2026 · Mac' };
/* ============ 展示层布局（只影响站点，网盘目录一个字不动） ============
   站点上的分类跟网盘目录结构不必一致，这里用一份「布局说明」把真实节点重新挂载。

   adopt 的两种语义：
     { at: '软件', children: true }        → 把「软件」的**所有子节点**收养过来（源目录会空掉）
     { at: 'figma/figma - mac版', self: true } → 把该目录**它自己**收养过来（连同它的子树） */
const LAYOUT = [
 {title:'软件',path:'软件',order:3,children:[
  {title:'Mac 软件',path:'软件/Mac软件',adopt:[{at:'软件/Mac软件',children:true},...manifest.items.map(m=>({at:'软件/'+m.name,self:true})),{at:'软件/_macOS软件索引.txt',self:true},{at:'软件/_macOS软件索引(1).txt',self:true},{at:'figma/figma - mac版',self:true}]},
  {title:'Windows 软件',path:'软件/Windows软件',adopt:[{at:'软件/Windows软件',children:true},{at:'figma/figma - win版',self:true}]},
  {title:'浏览器插件',path:'软件/浏览器插件',adopt:[{at:'软件/浏览器插件',children:true},{at:'figma/figma - 浏览器插件',self:true}]},
  {title:'跨平台软件',path:'软件/跨平台软件',adopt:[{at:'软件/跨平台软件',children:true}]},
  {title:'Android 应用',path:'@Android应用',adopt:[{at:'软件/DiPlay',self:true}]},
  {title:'安装包合集',path:'软件/安装包合集',adopt:[{at:'软件/安装包合集',children:true}]},
 ]},
 {title:'Blender',order:0,children:[
  {title:'Blender 模型',adopt:[{at:'3D模型',children:true}]},
  {title:'Blender 插件',adopt:[{at:'Blender建模',children:true}]}]},
];
const TOP_ORDER = {Blender:0, '三维素材':1, '设计素材':2, '软件':3, 'Blender工具':4, '智能家居':5, '游戏资源':6, 'figma':7, '00-资源池':9};
const cleanTitle = (s) => String(s).replace(/^\d{3,}[-_]\s*/, '');

/* 分类图标（netdisk-site/media/cats/ 下，手写 SVG；分类卡片没有封面图时的图形）
   命名按「展示标题」索引 —— 改标题时记得同步这里。 */
const CAT_ICON = {
  Blender: 'blender.svg',
  'Blender 模型': 'blender-model.svg',
  'Blender 插件': 'blender-plugin.svg',
  软件: 'software.svg',
  'Mac 软件': 'software-mac.svg',
  'Windows 软件': 'software-win.svg',
  浏览器插件: 'browser-ext.svg',
  'Mac软件': 'software-mac.svg',
  'Windows软件': 'software-win.svg',
  智能家居: 'smarthome.svg',
  'Android应用': 'android.svg',
};

/* ============ 排除名单（站点只收录「能整理」的内容） ============
   判据＝**文件本身的证据**，不是抽象原则：
     · 文件名自带破解标记：`[安装即破]` / `手动激活` / `crack.zip`
     · 文件名是盗版站标题：`Скачать … » бесплатно » EGround`
     · 付费商业软件（Adobe 全家桶 / Metashape / Cubase / ETS / Quad Remesher / KeenTools）
     · 他人版权 IP 素材（one-piece / animal-crossing）+ Google Drive 下载残留
     · 他人店铺素材（`淘宝店，小新的宝藏屋.webloc`）、游戏换肤包
   这些不进站点、不生成分享链接 —— 整理它们等于把它们编成可上架/可发货的结构。
   名单与证据见 docs/资源站-排除名单.md。要临时全量出站：`node scripts/netdisk-site.mjs --all` */
const EXCLUDE = [
  '00-资源池',              // 淘宝出售类：Adobe / Shopee 素材 / KNX 破解
  '三维素材',                // 他人 IP 模型 + drive-download-* 残留
  '设计素材',                // 含他人淘宝店的 Procreate 笔刷
  '游戏资源',                // 雀魂换肤包
  'Blender工具',             // Quad Remesher / KeenTools（付费插件，文件名来自盗版站）
  '软件/Mac软件',            // 破解 Adobe 2026 + 微信改包
  '软件/跨平台软件',          // Agisoft Metashape / Steinberg Cubase
  '软件/安装包合集',          // 空目录
  '智能家居/工具/KNX6.2',     // 含 ETS 6.2.0 crack.zip
  '智能家居/设计方案',         // 他人店铺的小米设计文档
];
const INCLUDE_ALL = process.argv.includes('--all');

/** 内部目录：不进站点（不是给人浏览的内容，留着只会显示成一片没图的占位卡片）
    例：`软件/calibre/授权说明`（放随包许可说明的内部目录） */
const INTERNAL_RE = /\/(授权说明|SOURCE|随包文件|内部)$/;

/** 按 EXCLUDE 剪枝（整棵子树摘掉） */
function pruneExcluded(nodes) {
  if (INCLUDE_ALL) return nodes;
  const kept = [];
  for (const n of nodes) {
    if (EXCLUDE.includes(n.path) || INTERNAL_RE.test(n.path)) continue;
    if (n.children) n.children = pruneExcluded(n.children);
    kept.push(n);
  }
  return kept;
}

/* ⚠️ 分享链接的**间接泄漏**：分享是按网盘目录建的，而网盘上被排除的目录**仍然躺在原处**。
   例如「软件」这个目录的分享链接，指向的是整个 `软件/`，里面就包含 `软件/Mac软件`（破解 Adobe）。
   所以：凡是**后代里有被排除目录**的路径，它自己的分享链接一律不挂（也不让子节点继承）。 */
const SHARE_UNSAFE = new Set();
for (const p of EXCLUDE) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) SHARE_UNSAFE.add(parts.slice(0, i).join('/'));
}
const shareOk = (p) => !!shares[p] && !SHARE_UNSAFE.has(p) && !EXCLUDE.includes(p);

function buildDisplayTree(raw) {
  // 索引：path → 节点 / 父节点
  const byPath = new Map();
  const parentOf = new Map();
  (function index(nodes, parent) {
    for (const n of nodes) {
      byPath.set(n.path, n);
      parentOf.set(n.path, parent);
      if (n.children) index(n.children, n);
    }
  })(raw, null);

  const touched = new Set();   // 被摘过子节点的目录（空了就该从树上消失）
  const detached = new Set();  // 已被收养走的节点（原位置不再保留）

  const detach = (node) => {
    const p = parentOf.get(node.path);
    detached.add(node.path);
    if (!p) return;
    const i = (p.children || []).indexOf(node);
    if (i >= 0) p.children.splice(i, 1);
    touched.add(p.path);
  };

  const build = (spec) => {
    const kids = [];
    for (const a of spec.adopt || []) {
      const src = byPath.get(a.at);
      if (!src) continue;
      if (a.children) {
        for (const c of [...(src.children || [])]) { detach(c); kids.push(c); }
        touched.add(src.path);
      } else {
        detach(src);
        kids.push(src);
      }
    }
    return {
      name: spec.title,
      title: spec.title,
      dir: true,
      group: true,                                   // 合成节点
      path: spec.path || `@${spec.title}`,           // @ 开头：不与任何网盘路径冲突
      mtime: '',
      order: spec.order ?? 50,
      children: kids,
    };
  };

  const tops = LAYOUT.map((s) => {
    const node = build(s);
    node.children = (s.children || []).map((c) => build(c));
    return node;
  }).filter((n) => n.children.length);

  // 剩下的真实顶层目录：排除被收养走的、以及被摘空的
  const rest = raw.filter((n) => !LAYOUT.some(s=>s.path===n.path) && !detached.has(n.path) && !(touched.has(n.path) && !(n.children || []).length));
  for (const n of rest) n.order = TOP_ORDER[n.name] ?? 50;
  return [...tops, ...rest].sort((a,b)=>(a.order??50)-(b.order??50));
}

/** 递归标注：标题/目录累计体积/文件数 + 封面/图标/软件信息 */
function annotate(n, parents, parentCover) {
  const isDir = !!n.dir;
  if (isDir && n.children) {
    // 子目录的兜底封面 = 自己的封面/图标 || 父目录传下来的（避免内部子目录显示成一片灰色占位卡）
    const inherit = n.cover || n.icon || parentCover;
    n.children = n.children.map((c) => annotate(c, [...parents, n.name], inherit)).filter(c => !c.dir || c.files || d.errors?.some(e=>e.path===c.path));
  }
  if (isDir) {
    let bytes = 0;
    let files = 0;
    for (const c of n.children || []) {
      bytes += c.bytes || 0;
      files += c.dir ? c.files || 0 : 1;
    }
    n.bytes = bytes;
    n.files = files;
    n.sizeText = fmtSize(bytes);
  } else {
    n.bytes = n.size || 0;
    n.files = 1;
    n.sizeText = fmtSize(n.bytes);
  }
  const curated = media.curated?.[n.path];
  if (curated && isDir) Object.assign(n, curated);
  if(n.description)n.description=n.description.replace(/ · \d+ 个文件/, ` · ${n.files} 个文件`);
  n.internal = isDir && parents.at(-1) === n.name;
  n.resource = isDir && !n.group && ((/^三维素材\/[^/]+\/[^/]+$/.test(n.path)) || (/^(3D模型|Blender建模)\/[^/]+$/.test(n.path)) || (n.app) || (/^软件\/Mac软件\/[^/]+$/.test(n.path)));
  if(!isDir && media.previews?.[n.path]) n.cover = media.previews[n.path];
  n.title = n.title || DISPLAY_NAME[n.path] || cleanTitle(n.name);
  // 所属类目（用展示名，弹层副标题用，避免出现「3D模型」这种网盘原名）
  const last = parents.length ? parents[parents.length - 1] : '';
  n.cat = last ? (DISPLAY_NAME[last] || cleanTitle(last)) : '';

  // 分类卡片（大类 / 子类）挂图标
  // ⚠️ 必须**覆盖/清掉 cover** —— media.curated 会给这些路径塞「生成占位封面」，
  //    而卡片是 cover 优先于 icon，不清掉的话官方分类图标会被渐变占位图盖住。
  if (n.group || parents.length === 0) {
    const key = CAT_ICON[n.title] ? n.title : n.title.replace(/\s+/g, '');
    const file = CAT_ICON[n.title] || CAT_ICON[key];
    if (file) { n.icon = `media/cats/${file}`; delete n.cover; }
  }

  // 封面：3D模型 / Blender建模 的产品目录
  if (isDir && media.covers[n.path]) n.cover = media.covers[n.path];

  // 目录没有任何图 → 沿用父目录的封面（只在真的没图时，不覆盖已有的）
  if (isDir && !n.cover && !n.icon && parentCover) n.cover = parentCover;

  // 目录还挂着「生成占位图」→ 若子项已有真图，改用第一个子项的真图（分组目录这样更有信息量）
  if (isDir && String(n.cover || '').startsWith('media/curated/')) {
    const kid = (n.children || []).find((c) => c.cover && !String(c.cover).startsWith('media/curated/'));
    if (kid) n.cover = kid.cover;
  }

  // 分享链接（有就挂上，弹层里显示「复制 链接+提取码」）；含被排除后代的目录不挂，避免间接分发
  if (shareOk(n.path)) n.share = shares[n.path];
  else {
   const parent=Object.keys(shares).filter(p=>shareOk(p) && n.path.startsWith(p+'/')).sort((a,b)=>b.length-a.length)[0];
   if(parent){n.share=shares[parent];n.shareScope=parent;}
  }

  // App 信息：软件类目下的产品目录（目录名与 manifest 的 name 一致）
  if (isDir && parents[0] === '软件') {
    const m = metaByName.get(n.name);
    if (m) {
      n.icon = media.icons[m.id] || null;
      n.app = {
        id: m.id,
        cn: m.cn,
        license: m.license,
        usage: m.usage || [],
        homepage: m.homepage || '',
      };
      const v = verById.get(m.id);
      if (v) { n.version = v.version || ''; n.verified = v.verified === true; }
    }
  }
  n.resource ||= !!n.app;
  delete n.size;
  return n;
}

const out = {
  generated_at: d.generated_at,
  partial: !!d.partial,
  errors: d.errors || [],
  root: '我的应用数据/bdpan',
  owner_uid: d.owner_uid || '',
  counts: {
    covers: Object.keys(media.covers || {}).length + Object.keys(media.curated||{}).length + Object.keys(media.previews||{}).length,
    icons: Object.keys(media.icons || {}).length,
    shares: Object.keys(shares || {}).length,
  },
  tree: buildDisplayTree(pruneExcluded(d.tree || [])).map((n) => annotate(n, [])).filter(n=>n.files),
};

const allNodes=[]; (function walk(ns){for(const n of ns){allNodes.push(n);walk(n.children||[])}})(out.tree);
out.counts.covers=allNodes.filter(n=>n.cover).length;
out.counts.icons=allNodes.filter(n=>n.icon&&!n.cover).length;
fs.mkdirSync(SITE, { recursive: true });
const js = `window.__ND__ = ${JSON.stringify(out)};\n`;
fs.writeFileSync(path.join(SITE, 'data.js'), js, 'utf8');

console.log(`✅ netdisk-site/data.js  ${(js.length / 1024).toFixed(0)} KB　（${d.total_files} 个文件）`);
console.log(`   封面 ${out.counts.covers}　图标 ${out.counts.icons}　分享链接 ${out.counts.shares}${d.partial ? '　⚠️ 未抓完' : ''}`);
console.log(`   打开：${path.relative(ROOT, path.join(SITE, 'index.html'))}`);
