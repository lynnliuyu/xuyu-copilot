#!/usr/bin/env node
/**
 * 公众号文章发布前自动检查
 *
 * 检查的不是"代码对不对"，是"发出去会不会出事"。分五类：
 *   ① 残留 markdown 语法 —— `**`、`|---|`、裸 `##` 混进正文，一眼就露怯
 *   ② 内部信息泄漏 —— 仓库路径、脚本名、体检产物，这些绝不能被读者看到
 *   ③ 平台不合规写法 —— <style>/class（会被剥掉，白写）、外链 <a>（会被剥掉）
 *   ④ 违规词 —— 公众号自己的红线，和闲鱼那套不同
 *   ⑤ 结构完整性 —— 标签配对、空块、标题/关键词是否齐
 *
 * 用法：node scripts/verify-mp-article.mjs [id...]   不给 id 就查全部
 */

import fs from 'node:fs';
import path from 'node:path';

const cfg = fs.existsSync('assets/mp-config.json')
  ? JSON.parse(fs.readFileSync('assets/mp-config.json', 'utf8'))
  : {};

// ① 残留 markdown
const MD_LEFTOVER = [
  [/\*\*[^*\n]+\*\*/, '加粗标记 ** 未转换'],
  [/`[^`\n]+`/, '行内代码反引号未转换'],
  [/^\s*#{1,6}\s/m, '标题井号未转换'],
  [/^\s*\|.*\|\s*$/m, '表格竖线未转换'],
  [/^\s*\|[\s:|-]+\|\s*$/m, '表格分隔行未转换'],
  [/^\s*>\s/m, '引用符号未转换'],
  [/^\s*```/m, '代码围栏未转换'],
  [/\[[^\]\n]+\]\([^)\n]+\)/, 'markdown 链接未转换'],
];

// ② 内部信息（允许白名单里的值，比如配置注入的跟版本命令）
const INTERNAL = [
  [/docs\/[\w\u4e00-\u9fff-]+\.md/, '内部文档路径'],
  [/out\/[\w-]+\//, '产物目录路径'],
  [/\.workbuddy/, '工作目录'],
  [/articles\/[\w-]+\.md/, '文章源文件路径'],
  [/gh-audit|gh-watch|make-source-note/, '内部脚本名'],
  [/\bnpm run (?!gh:watch)/, 'npm 命令'],
  [/drafts\/|packages\//, '仓库内部目录'],
  [/编辑提醒|编辑用|待补|待填|已挂号|进度日志/, '编辑标记'],
];

// ④ 违规词（公众号 / 微信生态红线）
const BANNED = /破解|白嫖|永久免费|全网最低|内购|去广告版|盗版|绿色版去授权/;

function isAllowed(line, allow) {
  return allow.some((a) => a && line.includes(a));
}

function check(id, dir) {
  const problems = [];
  const warnings = [];

  const htmlPath = path.join(dir, 'article.html');
  if (!fs.existsSync(htmlPath)) {
    problems.push('缺 article.html');
    return { problems, warnings };
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const allow = [cfg.watchCmd].filter(Boolean);

  // ⚠️ 查「残留 markdown 语法」之前必须先剔掉代码块/告示块 ——
  //    代码块里出现 `#`、反引号、`**` 是**正常内容**（shell 示例本来就长这样），
  //    不剔掉会一直误报。（localsend 那篇的 `-` 就是这么被误判的）
  const prose = html
    .replace(/<section style="[^"]*font-family:Menlo[^"]*">[\s\S]*?<\/section>/g, '')
    .replace(/<section style="[^"]*background:#F7F8FA;border:1px solid[^"]*">[\s\S]*?<\/section>/g, '');

  // ① 残留 markdown
  for (const [re, name] of MD_LEFTOVER) {
    const m = prose.match(re);
    if (m) problems.push(`① ${name}：${JSON.stringify(m[0].slice(0, 40))}`);
  }

  // ② 内部信息（按行判断，白名单内放行）
  for (const [re, name] of INTERNAL) {
    const hitLines = html.split('\n').filter((l) => re.test(l) && !isAllowed(l, allow));
    if (hitLines.length) {
      const sample = (hitLines[0].match(re) || [''])[0];
      problems.push(`② ${name} 泄漏：${sample}（共 ${hitLines.length} 处）`);
    }
  }

  // ③ 平台不合规写法
  if (/<style[\s>]/i.test(html)) problems.push('③ 含 <style> 标签（公众号会剥掉）');
  if (/\sclass=/.test(html)) problems.push('③ 含 class 属性（公众号会剥掉）');
  if (/<a\s+[^>]*href/i.test(html)) problems.push('③ 含站外 <a> 链接（公众号会剥掉）');
  if (/<img/i.test(html)) warnings.push('③ 含 <img>：确认图片是上传到公众号素材库，不是外链');

  // ④ 违规词
  const banned = html.match(new RegExp(BANNED, 'g'));
  if (banned) problems.push(`④ 违规词：${[...new Set(banned)].join(' ')}`);

  // ⑤ 结构
  for (const tag of ['section', 'p']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) problems.push(`⑤ <${tag}> 标签不配对：开 ${open} / 闭 ${close}`);
  }
  const bareTag = html.match(/<(section|p|strong|span)(?![^>]*style=)[^>]*>/g);
  if (bareTag) warnings.push(`⑤ ${bareTag.length} 个标签没有 style（公众号里可能没样式）`);

  const text = html.replace(/<[^>]+>/g, '').replace(/\s/g, '');
  if (text.length < 1500) problems.push(`⑤ 正文过短（${text.length} 字），可能转换丢了内容`);

  // ⑤-b 字数预算 —— 读者读不完的长文 = 没达到「都是干货」。
  //      预算与判据见 articles/_TEMPLATE.md（正文 1800–2200 字）。
  const BUDGET_HARD = 2600;
  const BUDGET_SOFT = 2200;
  if (text.length > BUDGET_HARD) {
    problems.push(`⑤ 正文过长（${text.length} 字 > ${BUDGET_HARD}）—— 按 articles/_TEMPLATE.md 删回 2200 字内`);
  } else if (text.length > BUDGET_SOFT) {
    warnings.push(`正文 ${text.length} 字，略超 ${BUDGET_SOFT} 字预算`);
  }

  // ⑤-c 内容纪律：出现这些，基本就说明又把「读者用不上」或「不该给读者看」的东西写进去了
  const NOISE = [
    [/已核实|非推测|非猜测|硬指标/, '元评论（"已核实/硬指标"）'],
    [/体检产物|授权核验报告|提交前必查|分发义务核对/, '内部流程用语'],
    [/命令行版|\bCLI\b/, 'CLI 展开（读者用不上）'],
    [/Flatpak|PPA|Steam|自托管/, '与我们的包无关的渠道 / 部署展开'],
  ];
  for (const [re, name] of NOISE) {
    if (re.test(prose)) warnings.push(`⑤ 内容纪律：出现 ${name}`);
  }

  // 图片 / 封面是否就位
  if (!fs.existsSync(path.join(dir, '首图-900x383.png'))) warnings.push('缺公众号首图（先跑 render-mp-cover.py）');
  if (!fs.existsSync(path.join(dir, '发布清单.md'))) warnings.push('缺发布清单');

  // ⑤-d 分节预算 —— 全文字数看不出来「某一节占太多」，而读者感觉到的恰恰是后者。
  //      （授权声明 + 支持系统 曾经各占 230~317 字，两块吃掉全文近三成）
  const mdPath = path.join('articles', `${id}.md`);
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8').split('# 文末附录')[0];
    const secs = {};
    let cur = '(文首)';
    for (const l of md.split('\n')) {
      const m = l.match(/^#{1,3}\s+(.*)$/);
      if (m) { cur = m[1].trim(); secs[cur] = secs[cur] || 0; continue; }
      secs[cur] = (secs[cur] || 0) + l.replace(/\s/g, '').length;
    }
    const LIMIT = [
      [/授权声明/, 165],
      // 支持系统：4–5 行表格（OBS 有 Apple/Intel 两个 mac 档）的天然下限约 200，
      // 所以给 225。**列数超过 2 列、或行数超过 5 行才是真问题**（读者要的是"我下哪个"）。
      [/支持系统/, 225],
      [/常见问题/, 400],
      [/核心亮点/, 540],
      [/它解决什么问题/, 240],
      [/^安装/, 480],
    ];
    for (const [re, lim] of LIMIT) {
      for (const [k, v] of Object.entries(secs)) {
        if (re.test(k) && v > lim) warnings.push(`⑤ 分节偏长：「${k}」${v} 字 > 预算 ${lim}`);
      }
    }
  }
  //    文章里写着「不用先关注后给空链接那套」—— 链接没配就发，等于自己打脸。
  const kw = (fs.existsSync(path.join(dir, '发布清单.md'))
    ? (fs.readFileSync(path.join(dir, '发布清单.md'), 'utf8').match(/主关键词 \| `([^`]+)`/) || [])[1]
    : null);
  let linkState = 'unknown';
  if (fs.existsSync('assets/free-software/netdisk-links.json')) {
    const links = JSON.parse(fs.readFileSync('assets/free-software/netdisk-links.json', 'utf8'));
    const entry = links[id];
    linkState = entry && String(entry).trim() ? 'ready' : 'missing';
  }

  return { problems, warnings, chars: text.length, kw, linkState };
}

const args = process.argv.slice(2);
let ids = args;
if (!ids.length) {
  ids = fs.existsSync('out/mp')
    ? fs.readdirSync('out/mp').filter((d) => !d.startsWith('_') && fs.existsSync(path.join('out/mp', d, 'article.html')))
    : [];
}
if (!ids.length) {
  console.error('没有可检查的文章（先跑 article-to-mp.mjs）');
  process.exit(2);
}

let bad = 0;
let gateBlocked = 0;
for (const id of ids) {
  const dir = path.join('out', 'mp', id);
  const { problems, warnings, chars, kw, linkState } = check(id, dir);
  if (problems.length) {
    bad++;
    console.log(`\n❌ ${id}（${chars || '?'} 字）`);
    problems.forEach((p) => console.log('   ', p));
    warnings.forEach((p) => console.log('    ⚠️', p));
  } else {
    console.log(`✅ ${id}　${chars} 字　${warnings.length ? `${warnings.length} 条提醒` : '无问题'}`);
    warnings.forEach((p) => console.log('    ⚠️', p));
  }
  if (linkState !== 'ready') {
    gateBlocked++;
    console.log(`    ⛔ 下载闸门未开：关键词 \`${kw || '?'}\` 对应的网盘链接还没配`);
    console.log(`       → 现在发出去，读者回复关键词只会拿到「[网盘链接占位]」`);
    console.log(`       → 补链接：assets/free-software/netdisk-links.json 的 "${id}" 字段（改完不用重启，服务热加载）`);
  }
}

console.log(
  bad
    ? `\n❌ ${bad}/${ids.length} 篇未通过发布前检查`
    : `\n✅ ${ids.length} 篇均通过发布前检查（排版/合规/泄漏）`,
);
if (gateBlocked) {
  console.log(`⛔ 但有 ${gateBlocked}/${ids.length} 篇的下载闸门还没开 —— 见上面每篇的提示`);
}
process.exit(bad ? 1 : 0);
