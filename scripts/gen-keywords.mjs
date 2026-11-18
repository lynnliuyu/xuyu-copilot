#!/usr/bin/env node
/**
 * 公众号「关键词自动回复」配置表生成器。
 *
 * 背景：运营方案第 7.2 节定了规矩 —— **网盘链接不进正文**，统一走「后台关键词自动回复」。
 * 好处有三：链接失效只改一处、不易被判营销导流、读者不用记复杂暗号。
 * 本脚本把「哪个项目 → 哪个关键词 → 哪个网盘目录 → 哪个链接占位符」一次性定下来，
 * 并**机器校验关键词唯一性**（人工排 50 多个关键词一定会撞车）。
 *
 * ── 输入（全部本地，不联网）
 *   assets/free-software/manifest.json    条目
 *   out/gh-audit.json                     版本 / 分级
 *   out/soft-dirs-plan.json               网盘目录与「可不可给链接」的判定（由 gen-soft-dirs 产出）
 *
 * ── 输出
 *   docs/开源软件公众号-关键词自动回复配置表.md   给人看 + 直接照着后台填
 *   out/keywords-table.json                      结构化（给自动化用；含链接占位符映射）
 *
 * ── 用法
 *   node scripts/gen-keywords.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'free-software', 'manifest.json');
const AUDIT = path.join(ROOT, 'out', 'gh-audit.json');
const PLAN = path.join(ROOT, 'out', 'soft-dirs-plan.json');
const ARTICLES = path.join(ROOT, 'articles');
const OUT_MD = path.join(ROOT, 'docs', '开源软件公众号-关键词自动回复配置表.md');
const OUT_JSON = path.join(ROOT, 'out', 'keywords-table.json');

/** 总入口关键词：读者记不住项目名时用这个 */
const ENTRY_KEYWORD = '开源软件';

/**
 * 人工指定关键词 —— 只在「自动推导不好看 / 易撞车」时使用。
 * 推导规则：名字过长（>12 字符）取首个词；去掉空格与点号。
 */
const KEYWORD_OVERRIDE = {
  'obs-studio': 'OBS',
  'drawio-desktop': 'drawio',
  'mediainfo-gui': 'MediaInfoGUI',
  'lossless-switcher': 'LosslessSwitcher',
  'lossless-cut': 'LosslessCut',
  'cherry-studio': 'Cherry',
  'tiny-rdm': 'TinyRDM',
  cura: 'Cura',
  rssguard: 'RSSGuard',
  openinterminal: 'OpenInTerminal',
  cachix: 'Cachix',
};

/** 备用关键词（读者可能输入的写法）—— 只保留短、好打、不易误触的候选 */
function aliasesOf(id, name, primary) {
  const cand = [];
  cand.push(id);
  cand.push(name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')); // 去空格/点号/符号
  cand.push(primary.replace(/[^A-Za-z0-9]/g, '').toLowerCase());        // 主关键词去符号（Xournal++ → xournal）
  // 常见简写
  if (primary === 'OBS') cand.push('obsstudio', '录屏');
  if (id === 'mediainfo') cand.push('mediainfo-cli');
  if (id === 'mediainfo-gui') cand.push('mediainfo界面版');

  const prim = primary.toLowerCase();
  const out = [];
  for (const a of cand) {
    const s = String(a).trim();
    if (!s || s.toLowerCase() === prim) continue;
    if (s.length > 16) continue;                 // 太长的没人会打
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) continue;
    out.push(s);
  }
  return out.slice(0, 2);
}

function deriveKeyword(id, name) {
  if (KEYWORD_OVERRIDE[id]) return KEYWORD_OVERRIDE[id];
  const raw = String(name);
  const base = raw.length > 12 ? raw.split(/\s+/)[0] : raw;
  return base.replace(/\s+/g, '').replace(/\./g, '');
}

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

function statusOf(plan, id) {
  if (plan.verdict === 'skip') return { key: 'intro-only', cn: '只介绍 · 不给链接' };
  if (plan.redistributable === 'conditional') return { key: 'conditional', cn: '有条件 · 前提有效才给链接' };
  if (plan.verdict === 'hold') return { key: 'hold', cn: '暂缓 · 资源/授权待核' };
  return { key: 'ok', cn: '可给链接' };
}

function main() {
  const manifest = readJson(MANIFEST, { items: [] });
  const audit = readJson(AUDIT, { items: [] });
  const plan = readJson(PLAN, { items: [] });
  const auditMap = new Map((audit.items || []).map((x) => [x.id, x]));
  const planMap = new Map((plan.items || []).map((x) => [x.id, x]));
  const finalized = new Set(
    fs.existsSync(ARTICLES)
      ? fs.readdirSync(ARTICLES).filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => f.replace(/\.md$/, ''))
      : [],
  );

  const rows = [];
  const used = new Map(); // keyword(lower) -> id
  for (const m of manifest.items || []) {
    const au = auditMap.get(m.id) || {};
    const pl = planMap.get(m.id) || {};
    let kw = deriveKeyword(m.id, m.name);
    // 唯一性兜底：撞车就加 id 尾段
    const key = kw.toLowerCase();
    if (used.has(key)) {
      kw = `${kw}-${String(m.id).split('-').pop()}`;
    }
    used.set(kw.toLowerCase(), m.id);

    const st = statusOf(pl, m.id);
    const linkAllowed = st.key === 'ok';
    rows.push({
      id: m.id,
      name: m.name,
      cn: m.cn || null,
      keyword: kw,
      aliases: aliasesOf(m.id, m.name, kw),
      version: au.latestTag || null,
      tier: au.tier || null,
      license: m.license || null,
      redistributable: m.redistributable || 'yes',
      dirName: pl.dirName || m.name,
      netdiskPath: pl.dirName ? `软件/${pl.dirName}/` : null,
      linkPlaceholder: linkAllowed ? `{{NETDISK_LINK_${m.id}}}` : null,
      linkAllowed,
      status: st.key,
      statusCn: st.cn,
      finalized: finalized.has(m.id),
      note: pl.reason || '',
    });
  }

  const counts = {
    total: rows.length,
    linkAllowed: rows.filter((r) => r.linkAllowed).length,
    conditional: rows.filter((r) => r.status === 'conditional').length,
    introOnly: rows.filter((r) => r.status === 'intro-only').length,
    hold: rows.filter((r) => r.status === 'hold').length,
    finalized: rows.filter((r) => r.finalized).length,
    keywordCollisions: rows.length - new Set(rows.map((r) => r.keyword.toLowerCase())).size,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    tool: 'gen-keywords',
    entryKeyword: ENTRY_KEYWORD,
    counts,
    rows,
  }, null, 2));

  fs.writeFileSync(OUT_MD, renderMd(rows, counts, audit.generatedAt));

  console.log('');
  console.log('══════ 公众号关键词配置表 ══════');
  console.log(`  条目 ${counts.total}　可给链接 ${counts.linkAllowed}　有条件 ${counts.conditional}　只介绍 ${counts.introOnly}　暂缓 ${counts.hold}`);
  console.log(`  关键词冲突 ${counts.keywordCollisions === 0 ? '✅ 0' : '⚠️ ' + counts.keywordCollisions}`);
  console.log(`  → docs/开源软件公众号-关键词自动回复配置表.md`);
  console.log(`  → out/keywords-table.json`);
  console.log('');
  if (counts.keywordCollisions) process.exitCode = 1;
}

function renderMd(rows, counts, auditAt) {
  const L = [];
  const finalized = rows.filter((r) => r.finalized);
  const ok = rows.filter((r) => r.status === 'ok');
  const cond = rows.filter((r) => r.status === 'conditional');
  const hold = rows.filter((r) => r.status === 'hold');
  const intro = rows.filter((r) => r.status === 'intro-only');

  L.push('# 公众号「关键词自动回复」配置表');
  L.push('');
  L.push(`> 生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} · 依据 \`out/gh-audit.json\`（${auditAt ? String(auditAt).slice(0, 19) : '—'}）+ \`out/soft-dirs-plan.json\``);
  L.push('> 用法：把这几个关键词填进公众号后台「自动回复 → 关键词回复」，把 `{{...}}` 占位符换成真实网盘分享链接。');
  L.push('');
  L.push('## 0. 三条铁规（务必先读）');
  L.push('');
  L.push('1. **网盘链接不进正文** —— 只在自动回复里给。链接失效时只改这一处，也避免被判「营销导流」。');
  L.push('2. **关键词越简单越好** —— 单一词，别搞暗号；读者记不住就等于没有。项目名不认识就推总入口。');
  L.push('3. **`no` 类不给链接** —— 未授予再分发权的项目（下表「只介绍」组）只能给**官网地址**，给网盘链接即侵权。');
  L.push('');
  L.push(`**总入口关键词：\`${ENTRY_KEYWORD}\`** —— 回复网盘软件总目录 + 最新一期的《开源软件更新合集》，兜住所有记不住项目名的读者。`);
  L.push('');
  L.push('| 分组 | 条数 |');
  L.push('|---|---|');
  L.push(`| ✅ 可给网盘链接 | ${counts.linkAllowed} |`);
  L.push(`| ⚠️ 有条件（前提有效才给） | ${counts.conditional} |`);
  L.push(`| ⏸ 暂缓（资源/授权待核） | ${counts.hold} |`);
  L.push(`| ⛔ 只介绍（给官网，不给链接） | ${counts.introOnly} |`);
  L.push('');

  const head = '| 项目 | 主关键词 | 备用关键词 | 台账版本 | 网盘目录 | 链接占位符 | 状态 | 文章 |';
  const sep = '|---|---|---|---|---|---|---|---|';

  if (finalized.length) {
    L.push('## 1. 已定稿项目（文章已成稿，优先配置）');
    L.push('');
    L.push(head);
    L.push(sep);
    for (const r of finalized) L.push(row(r, true));
    L.push('');
  }

  L.push(`## 2. 可给网盘链接（共 ${ok.length} 条${finalized.length ? `；上表已定稿的 ${finalized.length} 条不重复列出` : ''}）`);
  L.push('');
  L.push('> 全部通过授权核验（A/B 类开源，或官方条款明确允许再分发的 freeware）。');
  L.push('');
  L.push(head);
  L.push(sep);
  for (const r of ok.filter((x) => !x.finalized)) L.push(row(r, false));
  L.push('');

  if (cond.length) {
    L.push('## 3. 有条件（' + cond.length + ' 条）');
    L.push('');
    L.push('> ⚠️ 这些项目的再分发授权**带前提**。前提一旦失效（例如公众号转为商业运营），必须立即停止给链接并下架。');
    L.push('');
    L.push(head);
    L.push(sep);
    for (const r of cond) L.push(row(r, false));
    L.push('');
  }

  if (hold.length) {
    L.push('## 4. 暂缓（' + hold.length + ' 条）');
    L.push('');
    L.push('> 开源协议没问题，但仓库内置第三方资源待拆分 / 授权待人工核 → **核完再配关键词**。');
    L.push('');
    L.push(head);
    L.push(sep);
    for (const r of hold) L.push(row(r, false));
    L.push('');
  }

  if (intro.length) {
    L.push('## 5. 只介绍（' + intro.length + ' 条）—— 自动回复给官网，**不给网盘链接**');
    L.push('');
    L.push(head);
    L.push(sep);
    for (const r of intro) L.push(row(r, false));
    L.push('');
  }

  L.push('## 6. 自动回复文案模板');
  L.push('');
  L.push('**可给链接组**：');
  L.push('');
  L.push('```');
  L.push('【{{项目名}} {{版本}}】');
  L.push('开源协议：{{协议}} · 原始仓库：{{仓库地址}}');
  L.push('下载（官方原版，未做任何修改）：{{NETDISK_LINK_xxx}}');
  L.push('中文安装说明见本号文章，装不上或报错可在后台留言。');
  L.push('如权利人认为本分发不当，请联系我们，将第一时间处理。');
  L.push('```');
  L.push('');
  L.push('**只介绍组**（无网盘链接）：');
  L.push('');
  L.push('```');
  L.push('【{{项目名}}】本号只做介绍，不提供下载。');
  L.push('官网/仓库：{{官网地址}}');
  L.push('{{停更/付费说明}}');
  L.push('```');
  L.push('');
  L.push('**总入口**（`' + ENTRY_KEYWORD + '`）：');
  L.push('');
  L.push('```');
  L.push('【开源软件目录】全部整理好的软件都在这里：{{NETDISK_ROOT_LINK}}');
  L.push('最新一期《开源软件更新合集》：{{LATEST_COLLECTION_LINK}}');
  L.push('想看哪个软件，直接回复软件名（如 ' + (finalized[0]?.keyword || ok[0]?.keyword || 'OBS') + '）。');
  L.push('```');
  L.push('');

  L.push('## 7. 占位符 → 网盘目录 对照（配置时替换）');
  L.push('');
  L.push('| 占位符 | 网盘目录 |');
  L.push('|---|---|');
  L.push(`| \`{{NETDISK_ROOT_LINK}}\` | \`仓/待售/软件/\` |`);
  const withLink = [...new Map([...finalized, ...ok, ...cond].map((r) => [r.id, r])).values()];
  for (const r of withLink) {
    if (r.linkPlaceholder) L.push(`| \`${r.linkPlaceholder}\` | \`仓/待售/${r.netdiskPath}\` |`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push(`元信息：关键词冲突 ${counts.keywordCollisions === 0 ? '0 ✅' : counts.keywordCollisions + ' ⚠️（脚本已自动加后缀去重，仍需人工确认）'} · 总条目 ${counts.total}`);
  L.push('');
  return L.join('\n');
}

function row(r, final) {
  const star = final ? ' ✅ 已定稿' : '';
  return `| ${r.name}${star} | \`${r.keyword}\` | ${r.aliases.map((a) => `\`${a}\``).join(' ')} | ${r.version || '—'} | \`${r.netdiskPath || '—'}\` | ${r.linkPlaceholder ? `\`${r.linkPlaceholder}\`` : '—'} | ${r.statusCn} | ${r.finalized ? '✅' : '—'} |`;
}

main();
