/**
 * 微信公众号「关键词自动回复」——纯逻辑层（无网络、无依赖、可单测）。
 *
 * 为什么单独抽一层：微信消息接口的坑几乎全在**签名校验**和**XML 编解码**两处，
 * 这两块与 HTTP 无关，抽出来就能离线反复测，不必等公网、不必扫码。
 *
 * ⚠️ 关键事实：**被动回复只需要 Token，不需要 AppSecret。**
 * AppSecret 只有「主动推送 / 管理素材」才用，本服务刻意不读取它。
 */
import crypto from 'node:crypto';

// ── ① 签名校验 ────────────────────────────────────────────────────
/**
 * 微信服务器校验：sha1( 字典序拼接(token, timestamp, nonce) )。
 * 注意是**字典序排序**，不是按参数名或给定顺序。
 */
export function computeSignature(token, timestamp, nonce) {
  const raw = [String(token), String(timestamp), String(nonce)].sort().join('');
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

export function verifySignature(token, { signature, timestamp, nonce }) {
  if (!signature || !timestamp || !nonce) return false;
  const expect = computeSignature(token, timestamp, nonce);
  // 定长比较用 timingSafeEqual，避免早退比较
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── ② XML 解析 / 生成 ─────────────────────────────────────────────
/** 取 <Tag>...</Tag>，自动剥 CDATA；取不到返回 null */
export function pick(xml, tag) {
  const re = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`);
  const m = String(xml).match(re);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] ?? '').trim();
}

export function parseMessage(xml) {
  return {
    toUser: pick(xml, 'ToUserName'),
    fromUser: pick(xml, 'FromUserName'),
    createTime: pick(xml, 'CreateTime'),
    msgType: (pick(xml, 'MsgType') || '').toLowerCase(),
    content: pick(xml, 'Content') ?? '',
    event: (pick(xml, 'Event') || '').toLowerCase(),
    eventKey: pick(xml, 'EventKey'),
    msgId: pick(xml, 'MsgId'),
  };
}

/** CDATA 里的 `]]>` 必须断开，否则生成的 XML 会被截断 */
function cdata(s) {
  return `<![CDATA[${String(s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export function buildTextReply({ toUser, fromUser, content, now = Math.floor(Date.now() / 1000) }) {
  return [
    '<xml>',
    `<ToUserName>${cdata(toUser)}</ToUserName>`,
    `<FromUserName>${cdata(fromUser)}</FromUserName>`,
    `<CreateTime>${now}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content>${cdata(content)}</Content>`,
    '</xml>',
  ].join('');
}

// ── ③ 关键词匹配 ──────────────────────────────────────────────────
/**
 * 归一化：去空白、去全角空格、统一小写。
 * 微信用户在手机上打字常有前后空格，不能因为空格就匹配失败。
 */
export function normalize(s) {
  return String(s ?? '')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/**
 * @param {string} text 用户发来的原文
 * @param {Array} rows  关键词表（out/keywords-table.json 的 rows）
 * @returns {{hit: object|null, reason: string}}
 */
export function matchKeyword(text, rows) {
  const q = normalize(text);
  if (!q) return { hit: null, reason: 'empty' };

  // 1) 关键词精确命中
  for (const r of rows) {
    if (normalize(r.keyword) === q) return { hit: r, reason: 'keyword' };
  }
  // 2) 备用关键词命中
  for (const r of rows) {
    if ((r.aliases || []).some((a) => normalize(a) === q)) return { hit: r, reason: 'alias' };
  }
  // 3) 包含式兜底（「我想下载 Maccy 有吗」也能命中）——只在**唯一命中**时采用，避免误回
  const partial = rows.filter((r) => {
    const k = normalize(r.keyword);
    return k.length >= 3 && q.includes(k);
  });
  if (partial.length === 1) return { hit: partial[0], reason: 'partial' };

  return { hit: null, reason: partial.length > 1 ? 'ambiguous' : 'miss' };
}

// ── ④ 回复文案 ────────────────────────────────────────────────────
const LINK_OPEN = '[网盘链接占位]';
const LINK_CLOSED = '（该项目为「只介绍」类，不代存安装包，请前往原项目获取）';

/**
 * @param {object} row     关键词行
 * @param {object} detail  补充信息（来自 gh-audit：repo / homepage / stars / license）
 * @param {object} opts    { links: {id: url}, entryKeyword, indexText }
 */
export function buildReplyText(row, detail = {}, opts = {}) {
  const repo = detail.repo ? `https://github.com/${detail.repo}` : detail.homepage || '—';
  const title = `【${row.name}${row.version ? ' ' + row.version : ''} · ${row.cn || ''}】`;

  // 「只介绍」类：只给官方地址，不给网盘
  if (!row.linkAllowed) {
    return [
      title,
      '',
      '⚠️ 这个项目我们**只做介绍，不代存安装包**（授权或资源需要单独核验）。',
      '',
      `🔗 原项目地址：${repo}`,
      '前往官方页面即可获取最新版，顺手点个 Star 支持作者。',
    ].join('\n');
  }

  const link = opts.links?.[row.id] || LINK_OPEN;
  return [
    title,
    '',
    '📦 下载（本号转存的官方原包，含授权说明与校验值）',
    link,
    '',
    `🔗 原项目地址：${repo}`,
    '好用记得去点个 Star，支持原作者。',
  ].join('\n');
}

export const HELP_TEXT = [
  '发「开源软件」看全部目录',
  '发「项目名」拿下载链接，例如：Maccy、calibre、Tabby',
  '没有找到？把名字发我，我们会补上',
].join('\n');
