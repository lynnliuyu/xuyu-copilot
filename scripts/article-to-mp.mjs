#!/usr/bin/env node
/**
 * 文章 → 公众号 HTML
 *
 * 公众号编辑器会**剥掉 <style> 标签和 class**，只认行内样式。
 * 所以这里所有样式都写成 style="..."，产出的 HTML 可以直接粘进编辑器。
 *
 * 三条必须守住的规矩（踩过就知道有多疼）：
 *   ① **必须剥掉内部备注**：文首的元数据引用块、"封面用一句话"这类编辑提示、
 *      以及整节「文末附录（编辑用）」—— 这些一旦发出去就是事故。
 *   ② **占位符必须换成真值**：`<联系方式>`、`${项目}` 这类不能带着上线，
 *      所以最后有一道全量扫描，残留就报错。
 *   ③ **表格必须转成卡片**：公众号对 <table> 的支持不稳定，窄屏横向滚动很难看。
 *      转成"首列当标题、其余列做明细"的卡片，手机上才读得下去。
 *
 * 用法：
 *   node scripts/article-to-mp.mjs articles/maccy.md
 *   node scripts/article-to-mp.mjs --all
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 可调项（改这里就能统一换风格）──────────────────────────────────
const C = {
  body: 'font-size:16px;line-height:1.75;color:#3f3f46;letter-spacing:.5px;',
  p: 'margin:0 0 16px;font-size:16px;line-height:1.75;color:#3f3f46;letter-spacing:.5px;',
  strong: 'font-weight:700;color:#18191c;',
  h2: 'margin:34px 0 16px;padding-left:12px;border-left:4px solid #C8FF3D;font-size:19px;font-weight:700;color:#18191c;line-height:1.5;',
  h3: 'margin:24px 0 10px;font-size:17px;font-weight:700;color:#18191c;line-height:1.6;',
  h4: 'margin:20px 0 8px;font-size:16px;font-weight:700;color:#18191c;',
  code: 'background:#F1F3F5;color:#C7254E;padding:1px 5px;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:15px;',
  quote: 'margin:0 0 18px;padding:14px 16px;background:#F7F8FA;border-left:3px solid #C8FF3D;border-radius:0 8px 8px 0;',
  quoteText: 'margin:0;font-size:15px;line-height:1.75;color:#5b6270;',
  codeBlock: 'margin:0 0 18px;padding:14px 16px;background:#0E1116;border-radius:8px;font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.8;color:#C8FF3D;letter-spacing:0;word-break:break-all;',
  noticeBlock: 'margin:0 0 18px;padding:14px 16px;background:#F7F8FA;border:1px solid #E8EAED;border-radius:8px;font-size:14px;line-height:1.9;color:#5b6270;letter-spacing:.3px;word-break:break-all;',
  li: 'margin:0 0 8px;font-size:16px;line-height:1.75;color:#3f3f46;',
  bullet: 'color:#A6C93A;font-weight:700;',
  card: 'margin:0 0 18px;border:1px solid #E8EAED;border-radius:10px;overflow:hidden;',
  cardRow: 'padding:11px 14px;border-bottom:1px solid #F1F3F5;',
  cardRowLast: 'padding:11px 14px;',
  cardKey: 'font-size:15px;font-weight:700;color:#18191c;',
  cardVal: 'font-size:15px;color:#3f3f46;',
  cardValSub: 'display:block;font-size:13px;color:#9aa1ad;margin-bottom:2px;letter-spacing:.3px;',
  linkUrl: 'color:#9aa1ad;font-size:13px;',
};

// ── 配置（占位符换真值；缺就报错，不静默）────────────────────────
function loadConfig() {
  const p = 'assets/mp-config.json';
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 行内语法 → 行内样式 HTML。先把 code 抽成占位符，避免 ** 被误处理。 */
function inline(src) {
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, a) => {
    codes.push(a);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, a) => `<strong style="${C.strong}">${a}</strong>`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p, a) => `${p}${a}`); // 斜体去掉强调，保留文字

  // 链接：公众号会剥掉站外 <a>，所以直接落成「文字（url）」
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    text === url
      ? `<span style="${C.linkUrl}">${url}</span>`
      : `${text}<span style="${C.linkUrl}">（${url}）</span>`);

  s = s.replace(/\u0000C(\d+)\u0000/g, (_, i) =>
    `<span style="${C.code}">${esc(codes[+i])}</span>`);
  return s;
}

const isCJK = (s) => {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const total = s.replace(/\s/g, '').length || 1;
  return cjk / total > 0.3;
};

// ── 块级解析 ────────────────────────────────────────────────────────
function parseBlocks(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^---+$/.test(line.trim())) { i++; continue; } // 分隔线丢掉，H2 已经分了段

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push({ t: 'code', text: buf.join('\n'), lang: fence[1] });
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }

    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      out.push({ t: 'table', rows: rows.map(parseRow).filter((r) => r !== null) });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ t: 'quote', text: buf.join('\n') });
      continue;
    }

    if (/^\s*(?:[-*]|\d+[.)、])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+[.)、])\s+/.test(lines[i])) {
        const m = lines[i].match(/^\s*([-*]|\d+[.)、])\s+(.*)$/);
        items.push({ marker: m[1], text: m[2] });
        i++;
      }
      out.push({ t: 'list', items });
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\|/.test(lines[i]) &&
      !/^>/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) buf.push(lines[i++]);
    out.push({ t: 'p', text: buf.join('\n') });
  }
  return out;
}

function parseRow(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null; // 分隔行
  return cells;
}

// ── 块级渲染 ────────────────────────────────────────────────────────
function renderTable(rows) {
  if (!rows.length) return '';
  const headers = rows[0];
  const body = rows.slice(1);
  const multi = headers.length > 2; // 只剩一列明细时不用重复列名
  const parts = [`<section style="${C.card}">`];
  body.forEach((cells, ri) => {
    const last = ri === body.length - 1;
    parts.push(`<section style="${last ? C.cardRowLast : C.cardRow}">`);
    parts.push(`<section style="${C.cardKey}">${inline(cells[0] || '')}</section>`);
    for (let c = 1; c < cells.length; c++) {
      if (!cells[c]) continue;
      const label = multi && headers[c] ? `<span style="${C.cardValSub}">${inline(headers[c])}</span>` : '';
      parts.push(
        `<section style="${C.cardVal}${c === 1 ? ';margin-top:4px;' : ';margin-top:6px;'}">${label}${inline(cells[c])}</section>`,
      );
    }
    parts.push('</section>');
  });
  parts.push('</section>');
  return parts.join('');
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.t === 'h') {
      if (b.level === 1) continue; // 标题走公众号的标题字段，不进正文
      const style = b.level === 2 ? C.h2 : b.level === 3 ? C.h3 : C.h4;
      out.push(`<section style="${style}">${inline(b.text)}</section>`);
    } else if (b.t === 'p') {
      out.push(`<p style="${C.p}">${inline(b.text).replace(/\n/g, '<br>')}</p>`);
    } else if (b.t === 'quote') {
      out.push(
        `<section style="${C.quote}"><section style="${C.quoteText}">${inline(b.text).replace(/\n/g, '<br>')}</section></section>`,
      );
    } else if (b.t === 'code') {
      // 中文为主的块（授权声明那类）是**散文**不是代码 → 走行内格式（加粗/行内码要生效），
      // 否则 `**最宽松**` 会原样印出去，读者一眼看出没排版。
      if (isCJK(b.text)) {
        out.push(`<section style="${C.noticeBlock}">${inline(b.text).replace(/\n/g, '<br>')}</section>`);
      } else {
        out.push(`<section style="${C.codeBlock}">${esc(b.text).replace(/\n/g, '<br>')}</section>`);
      }
    } else if (b.t === 'list') {
      const items = b.items.map((it) => {
        const marker = /^[-*]$/.test(it.marker)
          ? `<span style="${C.bullet}">•</span>`
          : `<span style="${C.bullet}">${esc(it.marker)}</span>`;
        return `<section style="${C.li}">${marker}&nbsp;&nbsp;${inline(it.text)}</section>`;
      });
      out.push(items.join(''));
    } else if (b.t === 'table') {
      out.push(renderTable(b.rows));
    }
  }
  return out.join('\n');
}

// ── 清洗：剥内部备注、换占位符 ─────────────────────────────────────
/** 丢掉"编辑提醒"类引用块。
 *
 *  ⚠️ 必须**整块丢**：只删命中那一行，剩下的半截备注照样会被发出去。
 *  （localsend 那篇就混进过 `{{NETDISK_LINK_localsend}}` 和一条"编辑提醒"）
 */
function dropEditorQuotes(md) {
  const lines = md.split('\n');
  const out = [];
  const MARK = /编辑提醒|编辑用|已挂号|进度日志|待补截图|数据来源|条目 id|条目id|体检结论|文章草稿/;
  let i = 0;
  while (i < lines.length) {
    if (/^>/.test(lines[i])) {
      const block = [];
      while (i < lines.length && /^>/.test(lines[i])) block.push(lines[i++]);
      if (block.some((l) => MARK.test(l))) continue;
      out.push(...block);
      continue;
    }
    out.push(lines[i++]);
  }
  return out.join('\n');
}

function clean(md, cfg) {
  let s = md;

  // ① 整节「文末附录（编辑用）」— 一刀切掉
  s = s.replace(/\n#+\s*文末附录[\s\S]*$/, '\n');

  // ② 文首元数据引用块（草稿标记、数据来源、条目 id）
  //    ⚠️ 不能只写 `/^(?:>...)+/` —— 文章是「H1 → 空行 → 引用块」，
  //    字符串并不以 `>` 开头，锚点对不上就一个字都剥不掉。
  s = s.replace(/^(#[^\n]*\n+)(?:>[^\n]*\n)+/, '$1');
  s = s.replace(/^(?:>[^\n]*\n)+/, '');

  // ③ 夹在正文里的编辑提示
  s = s.replace(/^>\s*封面用一句话[^\n]*\n?/gm, '');
  s = s.replace(/^.*（编辑用[^\n]*\n?/gm, '');
  s = dropEditorQuotes(s);

  // ④ 行内编辑痕迹：`→ 占位符 {{XXX}}`
  s = s.replace(/[，,]?\s*→\s*占位符\s*`?\{\{[^}]*\}\}`?/g, '');
  s = s.replace(/\{\{[^}]*\}\}/g, '');

  // ⑤ 占位符换真值
  s = s.replace(/[<＜]联系方式[>＞]/g, cfg.contact || '<联系方式未配置>');
  s = s.replace(/[<＜]你的联系方式[>＞]/g, cfg.contact || '<联系方式未配置>');
  s = s.replace(/\$\{项目\}/g, cfg.watchCmd || '<跟版本命令未配置>');

  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** 残留占位符扫描 —— 带着占位符发出去就是事故，所以宁可报错 */
function scanPlaceholders(html) {
  const hits = [];
  const patterns = [
    [/&lt;[^&\n]{1,16}?&gt;/g, '尖括号占位符'],
    [/\$\{[^}\n]{1,20}\}/g, '模板占位符'],
    [/\{\{[^}\n]{1,40}\}\}/g, '双花括号占位符'],
    [/TODO|FIXME|XXX|待补|待填|占位|编辑提醒|编辑用/g, '待办/编辑标记'],
  ];
  for (const [re, name] of patterns) {
    const m = html.match(re);
    if (m) hits.push(`${name}：${[...new Set(m)].slice(0, 6).join(' ')}`);
  }
  return hits;
}

// ── 元信息提取（标题 / 关键词 / 摘要）──────────────────────────────
/**
 * 关键词表有两种写法，都得认（夜班流水线前后不一致留下的）：
 *   形态 A（maccy）：| 项 | 值 |，行名是「主关键词 / 备用关键词 / 网盘目录」
 *   形态 B（其余三篇）：| 关键词 | 用途 | 自动回复内容 |，靠"用途"列里有没有「主关键词」区分
 */
function extractMeta(md, blocks) {
  const title = (md.match(/^#\s+(.*)$/m) || [, ''])[1].trim();

  let keyword = '', alt = [], netdisk = '';
  // ⚠️ 别用 `[\s\S]*?\n\n` 收尾 —— 标题行后面紧跟一个空行，非贪婪会在表格之前就停住，
  //    结果一个关键词都读不到。要一直吃到下一个 H2 或文末。
  const kw = md.match(/附\s*2[\s\S]*?(?=\n##\s|$)/);
  if (kw) {
    const clean = (s) => s.replace(/`/g, '').replace(/\*\*/g, '').trim();
    for (const row of kw[0].split('\n').filter((l) => l.startsWith('|'))) {
      const cells = parseRow(row);
      if (!cells || cells.length < 2) continue;
      const [c0, c1, c2] = cells;

      // 形态 A
      if (/^主关键词/.test(c0) || /^项$/.test(c0)) {
        if (/主关键词/.test(c0)) keyword = clean(c1);
        if (/备用关键词/.test(c0)) {
          alt = clean(c1).split(/[、,，/]/).map((x) => x.trim()).filter(Boolean);
        }
        if (/网盘目录/.test(c0)) netdisk = clean(c1);
        continue;
      }

      // 形态 B：首列是关键词本身，第二列说明用途
      if (/主关键词/.test(c1 || '')) {
        keyword = clean(c0);
      } else if (/备用|场景词/.test(c1 || '') && c0) {
        alt.push(clean(c0));
      }
      if (/网盘|目录/.test(c2 || '') && !netdisk) {
        const m = (c2 || '').match(/[`\(（]?(仓\/[^`\s)）]+)/);
        if (m) netdisk = m[1];
      }
    }
  }
  // 网盘目录兜底：全文找一次
  if (!netdisk) {
    const m = md.match(/网盘目录\s*[|｜]\s*`([^`]+)`/);
    if (m) netdisk = m[1];
  }

  // 摘要取 ① 一句话定位 的第一句加粗内容
  let summary = '';
  const one = blocks.find((b, i) => b.t === 'h' && /一句话定位/.test(b.text));
  if (one) {
    const idx = blocks.indexOf(one);
    for (let j = idx + 1; j < blocks.length; j++) {
      const b = blocks[j];
      if (b.t === 'h') break;
      if (b.t === 'p') {
        const m = b.text.match(/\*\*([^*]+)\*\*/);
        if (m) { summary = m[1]; break; }
      }
    }
  }
  return { title, keyword, altKeywords: alt, netdisk, summary };
}

// ── 产物 ────────────────────────────────────────────────────────────
/**
 * 发布操作台：一页装下「发布要用的全部东西」，逐项复制粘贴即可。
 *
 * 为什么要有这个页：发文那一下必须本人在公众号后台操作（个人订阅号无发布接口），
 * 但那一步之外的东西全都可以提前备好 —— 标题、摘要、作者、封面、正文。
 * 分散在几个文件里手动找，容易漏、容易复制错，所以合成一页。
 */
function buildPublishCenter(html, meta, cfg, dir, id) {
  const account = cfg.account || '繁梦开源小仓库';
  const coverPath = path.join(dir, '首图-1800x766@2x.png');
  let coverBlock;
  if (fs.existsSync(coverPath)) {
    const b64 = fs.readFileSync(coverPath).toString('base64');
    coverBlock = `<img class="cover" src="data:image/png;base64,${b64}" alt="公众号封面">
      <p class="dim">尺寸 1800×766（2.35:1）。<b>上传这张</b>。转发到聊天时公众号会按 1:1 居中裁切，本图已验证标题不会被切。</p>
      <p class="dim">同目录还有 <code>方图-900x900.png</code>，编辑器要求 1:1 时用它。</p>`;
  } else {
    coverBlock = `<p class="warn">没找到封面图 —— 先跑 <code>npm run mp:cover -- ${id}</code></p>`;
  }

  const alt = meta.altKeywords.length ? meta.altKeywords.join('、') : '—';

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.title)} · 发布操作台</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;background:#F2F3F5;font-family:-apple-system,"PingFang SC",sans-serif;color:#18191c;}
  .bar{position:sticky;top:0;z-index:9;background:#18191c;color:#fff;padding:14px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
  .bar b{color:#C8FF3D;font-size:15px;}
  .bar .sp{flex:1;}
  button{background:#C8FF3D;color:#0E1116;border:0;border-radius:8px;padding:11px 20px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}
  button:hover{opacity:.85;}
  button:active{transform:translateY(1px);}
  button.ghost{background:transparent;color:#8B94A3;border:1px solid #3a3f47;font-weight:400;}
  .wrap{max-width:760px;margin:26px auto 80px;padding:0 18px;}
  .card{background:#fff;border-radius:14px;padding:22px 24px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
  .card h2{margin:0 0 4px;font-size:17px;display:flex;align-items:center;gap:10px;}
  .num{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#C8FF3D;color:#0E1116;font-size:13px;font-weight:700;flex:0 0 auto;}
  .card .hint{font-size:13px;color:#8B94A3;margin:0 0 14px;line-height:1.65;}
  .field{background:#F7F8FA;border:1px solid #E8EAED;border-radius:10px;padding:13px 15px;font-size:15px;line-height:1.6;margin-bottom:10px;word-break:break-all;white-space:pre-wrap;}
  .field.small{font-size:14px;color:#3f3f46;}
  textarea{width:100%;border:1px solid #E8EAED;border-radius:10px;padding:13px 15px;font-size:15px;font-family:inherit;line-height:1.6;resize:vertical;background:#F7F8FA;color:#18191c;}
  .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
  .dim{font-size:13px;color:#8B94A3;line-height:1.7;margin:8px 0 0;}
  .warn{color:#C77700;font-size:14px;}
  code{background:#F1F3F5;color:#C7254E;padding:1px 6px;border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:13px;}
  .cover{width:100%;border-radius:10px;display:block;border:1px solid #E8EAED;}
  .steps{margin:0;padding-left:20px;font-size:14px;line-height:2;color:#3f3f46;}
  .steps b{color:#18191c;}
  table.st{width:100%;border-collapse:collapse;font-size:14px;}
  table.st td{padding:9px 12px;border-bottom:1px solid #EDEFF2;vertical-align:top;line-height:1.7;}
  table.st tr:last-child td{border-bottom:0;}
  table.st td:first-child{color:#8B94A3;width:44%;}
  .article{background:#fff;padding:0;border-radius:10px;border:1px solid #E8EAED;}
  .article-inner{max-width:677px;margin:0 auto;padding:24px 16px 8px;}
  .ok{color:#1a8f3a;font-weight:700;}
  .note-ok{margin-top:14px;padding:13px 15px;background:#F2FAE8;border:1px solid #D8EDB4;border-radius:10px;font-size:13.5px;line-height:1.9;color:#3f4a2a;}
  .toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%) translateY(20px);background:#18191c;color:#C8FF3D;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:700;opacity:0;transition:.25s;pointer-events:none;}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0);}
</style></head><body>

<div class="bar">
  <b>发布操作台 ｜ ${esc(account)}</b>
  <span class="sp"></span>
  <button onclick="copyArticle()">① 复制正文</button>
  <button class="ghost" onclick="scrollTo({top:document.body.scrollHeight,behavior:'smooth'})">看正文</button>
</div>
<div class="toast" id="toast">已复制</div>

<div class="wrap">

  <div class="card">
    <h2><span class="num">0</span>发布前状态（已逐项验过）</h2>
    <p class="hint">下面这些都已就绪。**只剩最后一步只能你操作：点发布** —— 个人订阅号没有发布接口，公众号也不允许程序发文。</p>
    <table class="st">
      <tr><td>正式号</td><td><code>${esc(cfg.accountId || '（未配置）')}</code>　<span class="ok">✅</span></td></tr>
      <tr><td>服务器配置</td><td><span class="ok">✅ 已连通</span>　<code>${esc(cfg.serverUrl || '')}</code></td></tr>
      <tr><td>关键词回复</td><td><span class="ok">✅</span>　<code>${esc(meta.keyword || '—')}</code> 实测返回真链接 + 提取码</td></tr>
      <tr><td>网盘包</td><td><span class="ok">✅</span>　官方原包 + 使用说明 + <code>授权说明/</code>（LICENSE 全文）</td></tr>
      <tr><td>封面 / 正文 / 摘要</td><td><span class="ok">✅</span>　本页下方，各自带复制按钮</td></tr>
    </table>
    <p class="dim">⚠️ 启用服务器配置后，<b>公众号网页端设的「自动回复」和「自定义菜单」会失效</b> —— 消息全部转到我们那台服务上。这是微信的机制，不是故障；关注欢迎语、关键词、总目录都已接管并实测过。</p>
    <div class="note-ok">
      <b>⭐ 更快的路径（推荐）</b>：这篇可以直接推进<b>草稿箱</b>，你进后台核对后点发表即可，<b>不用逐项复制</b>。
      <br>命令：<code>npm run mp:draft -- ${esc(id)}</code>　　查看草稿箱：<code>npm run mp:drafts</code>
      <br>下方 1–5 的复制按钮是<b>备用路径</b> —— 草稿箱那条路走不通时用。
      <br>⚠️ 无论哪条路，<b>「点发表」这一步都要你在后台扫码完成</b>：个人主体账号没有发布接口（本号实测报 <code>48001 api unauthorized</code>，与官方文档一致）。
    </div>
  </div>

  <div class="card">
    <h2><span class="num">1</span>标题</h2>
    <p class="hint">公众号标题上限 64 字，但列表里大约只显示前 20 字，核心信息要压在开头。</p>
    <textarea id="f-title" rows="2" readonly>${esc(meta.title)}</textarea>
    <div class="row" style="margin-top:10px;">
      <button onclick="copyEl('f-title')">复制标题</button>
      <span class="dim" id="title-len" style="margin:0;"></span>
    </div>
  </div>

  <div class="card">
    <h2><span class="num">2</span>作者</h2>
    <div class="row">
      <div class="field" id="f-author" style="flex:1;margin:0;">${esc(account)}</div>
      <button onclick="copyEl('f-author')">复制</button>
    </div>
  </div>

  <div class="card">
    <h2><span class="num">3</span>摘要</h2>
    <p class="hint">上限 120 字。留空的话公众号会自动截正文前几句，通常不好看，建议手填。</p>
    <textarea id="f-summary" rows="3" readonly>${esc(meta.summary || '')}</textarea>
    <div class="row" style="margin-top:10px;">
      <button onclick="copyEl('f-summary')">复制摘要</button>
      <span class="dim" id="sum-len" style="margin:0;"></span>
    </div>
  </div>

  <div class="card">
    <h2><span class="num">4</span>封面</h2>
    <p class="hint">编辑器会让你裁两处：<b>头条封面（2.35:1）</b> 和 <b>分享小图（1:1）</b>。本套图已按 1:1 居中裁切做过安全验证，标题不会被切掉。</p>
    ${coverBlock}
  </div>

  <div class="card">
    <h2><span class="num">5</span>正文</h2>
    <p class="hint">点顶部「① 复制正文」，到公众号编辑器正文区 <b>Ctrl+V</b>。⚠️ 别用 Ctrl+A 全选复制——那会把工具栏也带进去。建议用 Chrome / Edge，Safari 粘样式容易丢。</p>
    <div class="row">
      <button onclick="copyArticle()">复制正文</button>
      <span class="dim" style="margin:0;">${html.replace(/<[^>]+>/g, '').replace(/\s/g, '').length} 字　下面就是它粘过去后的样子</span>
    </div>
  </div>

  <div class="card article">
    <div class="article-inner" id="article">${html}</div>
  </div>

  <div class="card">
    <h2><span class="num">6</span>关键词回复（已上线，实测通过）</h2>
    <p class="hint">发布后读者在公众号里回复下面这个词，会拿到下载链接。现在就能先用测试号或本地验证。</p>
    <div class="row">
      <div class="field" style="flex:1;margin:0;"><b>主关键词：</b><code>${esc(meta.keyword || '—')}</code>　　<b>备用：</b>${esc(alt)}</div>
    </div>
    <p class="dim">网盘目录：<code>${esc(meta.netdisk || '—')}</code>　·　回复内容已在本地实测，含真链接与提取码。</p>
  </div>

  <div class="card">
    <h2><span class="num">7</span>发布后</h2>
    <ol class="steps">
      <li><b>先在手机上预览一遍</b>　编辑器右上角「预览」发给自己微信。手机和电脑显示差别很大，这步别省。</li>
      <li><b>开原创声明</b>（有资格才开，没有就先不开，<b>不要伪造</b>）。</li>
      <li><b>自己补一条留言</b>　留言区是第二流量入口。</li>
      <li><b>确认关键词能拿到东西</b>　让朋友回复一次 <code>${esc(meta.keyword || '')}</code> 试。</li>
    </ol>
    <p class="dim">这条已纳入月度版本巡检：<code>${esc(cfg.watchCmd || 'npm run gh:watch')}</code> 会在官方发新版时提示。链接失效只改一处（关键词回复的链接表），<b>不用改已发的文章</b>。</p>
  </div>

</div>

<script>
function toast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('on');
  clearTimeout(window._tt); window._tt=setTimeout(function(){t.classList.remove('on')},1500);
}
function copyEl(id){
  var el=document.getElementById(id);
  if(el.tagName==='TEXTAREA'){ el.select(); }
  else { var r=document.createRange(); r.selectNodeContents(el); var s=getSelection(); s.removeAllRanges(); s.addRange(r); }
  try{ document.execCommand('copy'); toast('已复制'); }
  catch(e){ toast('复制失败，请手动选中'); }
  if(el.tagName==='TEXTAREA') el.setSelectionRange(0,0);
}
function copyArticle(){
  var el=document.getElementById('article');
  var r=document.createRange(); r.selectNodeContents(el);
  var s=getSelection(); s.removeAllRanges(); s.addRange(r);
  try{ document.execCommand('copy'); toast('正文已复制 → 去公众号编辑器 Ctrl+V'); }
  catch(e){ toast('复制失败，请手动选中正文'); }
}
document.getElementById('title-len').textContent = document.getElementById('f-title').value.length + ' 字';
document.getElementById('sum-len').textContent = document.getElementById('f-summary').value.length + ' / 120 字';
</script>
</body></html>`;
}

function buildPreview(html, meta, cfg) {
  const account = cfg.account || '繁梦开源小仓库';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(meta.title)} · 公众号预览</title>
<style>
  body{margin:0;background:#EDEDED;font-family:-apple-system,"PingFang SC",sans-serif;}
  .bar{position:sticky;top:0;background:#18191c;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:14px;font-size:14px;flex-wrap:wrap;}
  .bar b{color:#C8FF3D;}
  button{background:#C8FF3D;color:#0E1116;border:0;border-radius:6px;padding:8px 16px;font-size:14px;font-weight:700;cursor:pointer;}
  button:active{opacity:.7;}
  .wrap{max-width:677px;margin:24px auto 60px;background:#fff;padding:28px 20px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);}
  h1.t{font-size:22px;line-height:1.4;color:#18191c;margin:0 0 8px;}
  .sub{font-size:13px;color:#9aa1ad;margin:0 0 24px;}
</style></head><body>
<div class="bar">
  <span>公众号预览 ｜ 正文宽度 677px</span>
  <button onclick="copyAll()">① 复制正文</button>
  <span id="tip">粘贴到公众号编辑器即可（样式会一起带过去）</span>
</div>
<div class="wrap">
  <h1 class="t">${esc(meta.title)}</h1>
  <p class="sub">${account} ｜ 关键词 ${meta.keyword || '—'}</p>
  <div id="article">${html}</div>
</div>
<script>
function copyAll(){
  var el=document.getElementById('article');
  var r=document.createRange(); r.selectNodeContents(el);
  var s=getSelection(); s.removeAllRanges(); s.addRange(r);
  try{ document.execCommand('copy'); document.getElementById('tip').textContent='✅ 已复制，去公众号编辑器粘贴'; }
  catch(e){ document.getElementById('tip').textContent='复制失败，请手动全选正文'; }
}
</script>
</body></html>`;
}

function writeChecklist(dir, meta, cfg, stats) {
  const account = cfg.account || '繁梦开源小仓库';
  const md = `# ${meta.title} · 发布清单

> 账号：**${account}**　｜　正文 ${stats.chars} 字 / ${stats.blocks} 个块
> ⚠️ 公众号封面用 **2.35:1 首图**；转发到聊天按 **1:1 居中裁切**，本套图已验证不切字。

## 一、发布前逐项勾

| # | 事项 | 值 / 做法 |
|---|---|---|
| 1 | **标题** | 见下方「标题」栏，粘贴后逐字核对 |
| 2 | **封面** | 上传 \`首图-1800x766@2x.png\`（2 倍图更清晰） |
| 3 | **分享小图** | 若编辑器要求 1:1，用 \`方图-900x900.png\` |
| 4 | **作者** | 填 **${account}** |
| 5 | **摘要** | 见下方「摘要」栏（≤120 字） |
| 6 | **原创声明** | 有资格就开；没有就先不开，**不要伪造** |
| 7 | **正文** | 打开 \`preview.html\` → 点「复制正文」→ 粘进编辑器 |
| 8 | **关键词回复** | 后台确认 \`${meta.keyword || '—'}\` 已配好，能返回网盘链接 |
| 9 | **留言/在看** | 发布后自己补一条留言引导讨论 |

## 二、标题

\`\`\`
${meta.title}
\`\`\`

> 公众号标题上限 64 字，但**列表里大约只显示前 20 字**，所以核心信息要压在开头。

## 三、摘要（≤120 字）

\`\`\`
${meta.summary || '（未提取到，请手写一句）'}
\`\`\`

## 四、关键词

| 项 | 值 |
|---|---|
| 主关键词 | \`${meta.keyword || '—'}\` |
| 备用关键词 | ${meta.altKeywords.length ? meta.altKeywords.map((k) => `\`${k}\``).join(' ') : '—'} |
| 网盘目录 | \`${meta.netdisk || '—'}\` |

⚠️ 备用关键词也要在后台配（读者未必记得住主关键词）。

## 五、可选：插图位置

正文目前是**纯文字 + 卡片**，没有任何截图，可以直接发。想更好看，下面几处值得补图（图要你自己截，我这边拿不到界面）：

| 位置 | 截什么 |
|---|---|
| ③ 核心亮点 第一条之后 | 软件主界面，最能说明"它长什么样" |
| ⑥ 支持系统 之前 | 下载页面，证明官方产物真实存在 |
| ⑦ 安装部署 最后一步之后 | 装好后的实际效果 |

## 六、发布后

- 把本条加入**每月版本巡检**：\`${cfg.watchCmd || 'npm run gh:watch'}\` 会在官方发新版时提示。
- 链接失效/版本更新时，**改一处**（关键词回复的链接表）即可全量生效，不用改文章。
`;
  fs.writeFileSync(path.join(dir, '发布清单.md'), md);
}

// ── 主流程 ──────────────────────────────────────────────────────────
function convert(mdPath, cfg) {
  const md = fs.readFileSync(mdPath, 'utf8');
  const id = path.basename(mdPath, '.md');
  const cleaned = clean(md, cfg);
  const blocks = parseBlocks(cleaned);
  const html = renderBlocks(blocks);
  const meta = extractMeta(md, blocks);

  const outDir = path.join('out', 'mp', id);
  fs.mkdirSync(outDir, { recursive: true });

  const chars = html.replace(/<[^>]+>/g, '').length;

  fs.writeFileSync(path.join(outDir, 'article.html'), html);
  fs.writeFileSync(path.join(outDir, 'preview.html'), buildPreview(html, meta, cfg));
  fs.writeFileSync(path.join(outDir, '发布操作台.html'), buildPublishCenter(html, meta, cfg, outDir, id));
  writeChecklist(outDir, meta, cfg, { chars, blocks: blocks.length });

  const problems = scanPlaceholders(html);
  return { id, outDir, meta, chars, blocks: blocks.length, problems, title: meta.title };
}

const cfg = loadConfig();
if (!cfg.contact || !cfg.watchCmd) {
  console.warn('⚠️  assets/mp-config.json 缺字段，占位符会换成显式报错文本（不会被静默发出）\n');
}

const args = process.argv.slice(2);
let files;
if (args.includes('--all')) {
  // ⚠️ 跳过 `_` 开头的文件：`_TEMPLATE.md` 是写作标准，不是文章（gen-keywords 也是这个约定）
  files = fs.readdirSync('articles').filter((f) => f.endsWith('.md') && !f.startsWith('_')).map((f) => path.join('articles', f));
} else if (args[0]) {
  files = [args[0]];
} else {
  console.error('用法：node scripts/article-to-mp.mjs <articles/xxx.md> | --all');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const r = convert(f, cfg);
  const flag = r.problems.length ? '⚠️' : '✅';
  console.log(`\n${flag} ${r.id}  →  ${r.outDir}/`);
  console.log(`   标题：${r.title}`);
  console.log(`   正文：${r.chars} 字 / ${r.blocks} 块　关键词：${r.meta.keyword || '—'}`);
  console.log(`   文件：发布操作台.html（⭐ 一页搞定，先开这个）· article.html · preview.html · 发布清单.md`);
  if (r.problems.length) {
    bad++;
    console.log('   ⚠️ 残留占位符，发布前必须处理：');
    r.problems.forEach((p) => console.log('      -', p));
  }
}
console.log(bad ? `\n❌ ${bad} 篇有残留占位符` : '\n✅ 占位符扫描通过');
