#!/usr/bin/env node
/**
 * 微信公众号「关键词自动回复」服务（测试号 / 正式号通用）。
 *
 * ── 它干什么
 *   ① GET  /wechat  → 微信服务器「接口配置」时的签名校验，原样返回 echostr
 *   ② POST /wechat  → 用户发来的消息 → 匹配关键词 → 回一条文本
 *   ③ GET  /health  → 本机自检
 *
 * ── 为什么只需要 Token，不需要 AppSecret
 *   被动回复（用户发消息 → 我们回一条）走的是消息接口，微信只校验 Token 签名。
 *   AppSecret 是「主动推送 / 素材管理」才用的，本服务**刻意不读它**，
 *   这样即使配置文件泄露，也只泄露一个我们自己定义的字符串。
 *
 * ── 用法
 *   WECHAT_TOKEN='你定的token' PORT=8899 node scripts/wechat-reply-server.mjs
 *   node scripts/wechat-reply-server.mjs --selftest   # 不起公网服务，只跑本地自测
 *
 * ── 接线到测试号（三步）
 *   1. 本服务起在 127.0.0.1:8899
 *   2. 公网入口把它暴露成 https://<你的域名>/wechat
 *      （复用现有入口最省事：`api.fmkj.top` 的 Caddy 加一段 handle /wechat/*）
 *   3. 测试号页面填：URL = https://<你的域名>/wechat，Token = 与 WECHAT_TOKEN 一致
 *      → 点「提交」，本服务日志会打出一行「✅ 签名校验通过」
 *
 * ⚠️ 本服务只读本地文件（keywords-table.json / gh-audit.json / netdisk-links.json），
 *    不写任何东西，不碰闲管家与发布链路。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifySignature,
  parseMessage,
  buildTextReply,
  matchKeyword,
  buildReplyText,
  normalize,
  HELP_TEXT,
} from './lib/wechat-reply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYWORDS = path.join(ROOT, 'out', 'keywords-table.json');
const AUDIT = path.join(ROOT, 'out', 'gh-audit.json');
const LINKS = path.join(ROOT, 'assets', 'free-software', 'netdisk-links.json');

/** 极简 .env 读取（与 tunnel-ssh.mjs 一致）：process.env 优先，便于命令行临时覆盖 */
function readEnv(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    /* 没有 .env 就用默认值 */
  }
  return fallback;
}

const PORT = Number(process.env.PORT || readEnv('WECHAT_PORT', '8899'));
const HOST = process.env.HOST || '127.0.0.1';
// ⚠️ 必须**惰性读取**：自测模式会在启动后设置 WECHAT_TOKEN，
//    若在这里就固化成常量，自测会读到空串 → 签名校验一律 403。
const getToken = () => process.env.WECHAT_TOKEN || readEnv('WECHAT_TOKEN');
const ROUTE = process.env.WECHAT_PATH || readEnv('WECHAT_PATH', '/wechat');
const MAX_CONTENT_BYTES = 2000; // 微信被动回复文本上限 2048 字节，留点余量

// ── 数据加载（每次请求读盘代价太大 → 启动时读一次，带 mtime 热更新）──
function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

let cache = { rows: [], details: {}, links: {}, entryKeyword: '开源软件', mtime: 0 };
function loadData(force = false) {
  const m = [KEYWORDS, AUDIT, LINKS].map((p) => (fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0)).join(
    '|',
  );
  if (!force && m === cache.mtime) return cache;
  const kw = readJson(KEYWORDS, { rows: [], entryKeyword: '开源软件' });
  const audit = readJson(AUDIT, { items: [] });
  const details = Object.fromEntries((audit.items || []).map((x) => [x.id, x]));
  cache = {
    rows: kw.rows || [],
    entryKeyword: kw.entryKeyword || '开源软件',
    details,
    links: readJson(LINKS, {}) || {},
    mtime: m,
  };
  return cache;
}

// ── 总目录文案 ────────────────────────────────────────────────────
function buildIndexText(data) {
  const ok = data.rows.filter((r) => r.linkAllowed);
  // ⚠️ 措辞不能写「已上架」——那只代表"已收录"，不代表包已经在网盘上、能下载。
  //    网盘目录可以是空的，读者一回复拿到占位符，这句就变成虚假承诺了。
  const ready = ok.filter((r) => String((data.links || {})[r.id] || '').trim());
  let head;
  if (!ready.length) {
    head = `【开源软件目录】已收录 ${ok.length} 个，按字母序：`;
  } else if (ready.length === ok.length) {
    head = `【开源软件目录】已收录 ${ok.length} 个，均可下载，按字母序：`;
  } else {
    head = `【开源软件目录】已收录 ${ok.length} 个（${ready.length} 个已就位可下载），按字母序：`;
  }
  const list = ok
    .map((r) => r.keyword)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .join('、');
  return `${head}\n\n${list}\n\n发「项目名」拿下载链接（不区分大小写）。`;
}

function truncateBytes(s, max) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  return buf.subarray(0, max).toString('utf8').replace(/\uFFFD$/, '') + '…';
}

// ── 消息处理 ──────────────────────────────────────────────────────
function handleMessage(msg) {
  const data = loadData();

  // 关注事件 → 欢迎 + 目录
  if (msg.msgType === 'event') {
    if (msg.event === 'subscribe') {
      return `欢迎！这里分享真正好用、协议干净的开源软件。\n\n${buildIndexText(data)}`;
    }
    return ''; // 取关/其它事件不回
  }

  if (msg.msgType !== 'text') {
    return HELP_TEXT;
  }

  const text = String(msg.content || '').trim();

  // 总入口
  if (normalize(text) === normalize(data.entryKeyword) || normalize(text) === '目录') {
    return buildIndexText(data);
  }

  const { hit, reason } = matchKeyword(text, data.rows);

  if (!hit) {
    if (reason === 'ambiguous') {
      return `你发的词能对上多个项目，请直接发准确的名字。\n\n${buildIndexText(data)}`;
    }
    return `没找到「${text}」这个项目。\n\n${HELP_TEXT}`;
  }

  return buildReplyText(hit, data.details[hit.id] || {}, {
    links: data.links,
    entryKeyword: data.entryKeyword,
  });
}

// ── HTTP ──────────────────────────────────────────────────────────
const LOG = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    const d = loadData();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(
      JSON.stringify({
        ok: true,
        route: ROUTE,
        tokenSet: Boolean(getToken()),
        rows: d.rows.length,
        linkable: d.rows.filter((r) => r.linkAllowed).length,
        linksConfigured: Object.keys(d.links).length,
      }),
    );
  }

  if (url.pathname !== ROUTE) {
    res.writeHead(404).end('not found');
    return;
  }

  // ① 签名校验
  if (req.method === 'GET') {
    const q = {
      signature: url.searchParams.get('signature'),
      timestamp: url.searchParams.get('timestamp'),
      nonce: url.searchParams.get('nonce'),
    };
    const echostr = url.searchParams.get('echostr') || '';
    if (!getToken()) {
      LOG('❌ 未设置 WECHAT_TOKEN —— 请在启动时传入');
      res.writeHead(500).end('token not configured');
      return;
    }
    if (!verifySignature(getToken(), q)) {
      LOG('❌ 签名校验失败 —— 后台填的 Token 与本服务 .env 的 WECHAT_TOKEN 不一致');
      res.writeHead(403).end('bad signature');
      return;
    }
    // 措辞不写"测试号"：正式号配置服务器时打的也是这条，写死会误导
    LOG('✅ 签名校验通过（公众号「服务器配置」已连通）');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(echostr);
  }

  // ② 消息回复
  if (req.method === 'POST') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) req.destroy(); // 防超大 body
      else chunks.push(c);
    });
    req.on('end', () => {
      const xml = Buffer.concat(chunks).toString('utf8');
      const msg = parseMessage(xml);
      LOG(`📨 ${msg.msgType}${msg.event ? '/' + msg.event : ''} from=${msg.fromUser} 「${msg.content}」`);

      let out = '';
      try {
        out = handleMessage(msg) || '';
      } catch (e) {
        LOG('⚠️ 处理失败：', e.message);
        out = HELP_TEXT;
      }
      if (!out) {
        res.writeHead(200).end(''); // 回空 = 不回复
        return;
      }
      const body = buildTextReply({
        toUser: msg.fromUser,
        fromUser: msg.toUser,
        content: truncateBytes(out, MAX_CONTENT_BYTES),
      });
      LOG(`↩️  回复 ${Buffer.byteLength(out, 'utf8')} 字节`);
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(body);
    });
    return;
  }

  res.writeHead(405).end('method not allowed');
});

// ── 自测：不起公网，直接用本机 HTTP 打一轮 ────────────────────────
async function selftest() {
  const { computeSignature } = await import('./lib/wechat-reply.mjs');
  const token = 'selftest-token';
  process.env.WECHAT_TOKEN = process.env.WECHAT_TOKEN || token;
  const useToken = process.env.WECHAT_TOKEN;

  await new Promise((r) => server.listen(0, HOST, r));
  const port = server.address().port;
  const base = `http://${HOST}:${port}${ROUTE}`;
  let pass = 0;
  let fail = 0;
  const t = (name, cond, extra = '') => {
    if (cond) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name} ${extra}`);
    }
  };

  // 1) 签名校验
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'abc123';
  const sig = computeSignature(useToken, ts, nonce);
  const r1 = await fetch(`${base}?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=HELLO`);
  t('GET 签名正确 → 200 且原样返回 echostr', r1.status === 200 && (await r1.text()) === 'HELLO');

  const r2 = await fetch(`${base}?signature=deadbeef&timestamp=${ts}&nonce=${nonce}&echostr=X`);
  t('GET 签名错误 → 403', r2.status === 403);

  // 2) 关键词回复
  const post = async (content) => {
    const xml = `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[oUser123]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>1</MsgId></xml>`;
    const r = await fetch(base, { method: 'POST', body: xml });
    return r.text();
  };

  const rep1 = await post('Maccy');
  t('发「Maccy」→ 命中且带下载段', rep1.includes('Maccy') && rep1.includes('下载'));
  t('回复 XML 结构正确（To/From 已对调）', rep1.includes('<ToUserName><![CDATA[oUser123]]>') && rep1.includes('<FromUserName><![CDATA[gh_test]]>'));

  const rep2 = await post('  maccy  ');  // 带空格 + 小写
  t('发「  maccy  」→ 同样命中（归一化生效）', rep2.includes('Maccy'));

  const rep3 = await post('calibre');
  t('发别名/另一项目 → 对应命中', rep3.includes('calibre'));

  const rep4 = await post('alt-tab');
  t('「只介绍」类 → 不给网盘链接', rep4.includes('只做介绍') && !rep4.includes('📦'));

  const rep5 = await post('开源软件');
  t('总入口 → 返回目录', rep5.includes('目录') && rep5.includes('已收录'));

  const rep6 = await post('不存在的项目xyz');
  t('未命中 → 提示 + 帮助', rep6.includes('没找到'));

  const rep7 = await post('我要 Maccy 的链接');
  t('包含式兜底 → 唯一命中时也回', rep7.includes('Maccy') && rep7.includes('下载'));

  const rep8 = await post('a]]>b<>&"x');
  t('恶意/异常字符 → 不产生非法 XML', !/\]\]>\]\]>/.test(rep8) && rep8.startsWith('<xml>'));

  // 3) 非文本消息
  const r3 = await fetch(base, {
    method: 'POST',
    body: `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[image]]></MsgType><PicUrl><![CDATA[http://x/y.jpg]]></PicUrl></xml>`,
  });
  t('图片消息 → 回帮助而非报错', (await r3.text()).includes('项目名'));

  // 4) 关注事件
  const r4 = await fetch(base, {
    method: 'POST',
    body: `<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[oU]]></FromUserName><CreateTime>${ts}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[subscribe]]></Event></xml>`,
  });
  t('关注事件 → 欢迎语', (await r4.text()).includes('欢迎'));

  // 5) health
  const r5 = await fetch(`http://${HOST}:${port}/health`);
  const h = await r5.json();
  t('health 正常且读到关键词表', h.ok && h.rows === 65);

  console.log(`\n  自测结果：${pass} 通过 / ${fail} 失败`);
  server.close();
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  await selftest();
} else {
  const d = loadData(true);
  server.listen(PORT, HOST, () => {
    LOG(`微信关键词回复服务已启动 → http://${HOST}:${PORT}${ROUTE}`);
    LOG(`  关键词 ${d.rows.length} 条（可给链接 ${d.rows.filter((r) => r.linkAllowed).length}）`);
    LOG(`  Token：${getToken() ? '已设置' : '⚠️ 未设置（加 WECHAT_TOKEN=xxx 启动）'}`);
    LOG(`  自检：curl http://${HOST}:${PORT}/health`);
  });
}
