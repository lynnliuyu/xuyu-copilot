#!/usr/bin/env node
/**
 * 公众号「草稿箱」探测 / 推送
 *
 * ── 背景（别重复调研，依据见 memory/REFERENCE.md）
 * 微信《发布能力》文档注明：2025-07 起回收个人主体、企业未认证账号的**发布接口**权限；
 * `freepublish/submit` 的适用范围写明「服务号 仅认证 ✔」。
 * 所以「接口发文」对个人号是没门的。**唯一可能省事的一环是 `draft/add`（推进草稿箱）** ——
 * 但官方文档没写它的权限范围，社区实测多为 `48001 api unauthorized`，**必须以自己账号实测为准**。
 * 本脚本就是那次"实测"。
 *
 * ── 两种模式
 *   --probe          只探测权限：换 token → 查草稿数 → 打印结论（不写任何东西）
 *   --push <文章id>  真把排版好的图文推进草稿箱（**只建草稿，绝不发布**）
 *
 * ── 为什么必须分两步
 *   ⚠️ 即使草稿箱通了，**「发表」在后台仍需管理员扫码** —— 不存在无人值守的一键发布。
 *   本脚本只负责把内容送到"你只需点发表"的位置。
 *
 * ── 凭证（写在 .env，已在 .gitignore）
 *   正式号：WECHAT_MP_APPID / WECHAT_MP_SECRET
 *   测试号：WECHAT_TEST_APPID / WECHAT_TEST_SECRET
 *   用 --account test 走测试号，默认走正式号。
 *
 * ── IP 白名单（最常踩的坑）
 *   正式号必须在后台「基本配置 → IP 白名单」加入**调用方公网 IP**，否则换 token 直接报
 *   `40164 invalid ip`。本机公网 IP 会变 → 建议从固定 IP 的服务器发起调用。
 *
 * 用法：
 *   node scripts/mp-wechat-draft.mjs --probe [--account test]
 *   node scripts/mp-wechat-draft.mjs --push maccy
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** 从 .env 读键值（不引依赖） */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const env = loadEnv();
const TEST = has('--account') && val('--account') === 'test';
const APPID = TEST ? env.WECHAT_TEST_APPID : env.WECHAT_MP_APPID;
const SECRET = TEST ? env.WECHAT_TEST_SECRET : env.WECHAT_MP_SECRET;
const WHO = TEST ? '测试号' : '正式号';

if (!APPID || !SECRET) {
  console.error(`❌ .env 里没有${WHO}凭证。`);
  console.error(`   需要：${TEST ? 'WECHAT_TEST_APPID / WECHAT_TEST_SECRET' : 'WECHAT_MP_APPID / WECHAT_MP_SECRET'}`);
  console.error(`   ⚠️ AppSecret 要在公众平台「设置与开发 → 基本配置」点「重置」才显示，且只显示一次。`);
  process.exit(2);
}

// ⭐ 长度先校验：公众号 AppID 固定 18 位、AppSecret 固定 32 位。
//    抄错一个字符时，接口只回一句模糊的 `40125 invalid appsecret`，
//    量长度却能一眼看出是"抄错了"还是"真没权限"——省一整轮往返。
for (const [name, v, want] of [
  [`${TEST ? 'WECHAT_TEST_APPID' : 'WECHAT_MP_APPID'}`, APPID, 18],
  [`${TEST ? 'WECHAT_TEST_SECRET' : 'WECHAT_MP_SECRET'}`, SECRET, 32],
]) {
  if (String(v).length !== want) {
    console.error(`❌ ${name} 长度 ${String(v).length}，应为 ${want} 位 —— 多半是复制时掉字符了。`);
    console.error(`   后台 → 设置与开发 → 基本配置 → 开发者密码 → 重置 → 用旁边的「复制」按钮（别手动划选）。`);
    process.exit(2);
  }
}

const API = 'https://api.weixin.qq.com';
const mask = (s) => (s ? s.slice(0, 6) + '…' + s.slice(-4) : '');

/** 常见错误码翻译成人话 */
const HINT = {
  40001: 'secret 不对（或已被重置失效）',
  40164: '⚠️ 调用方公网 IP 不在白名单 → 后台「基本配置 → IP 白名单」加进去',
  48001: 'api 功能未授权 —— 这个号没有该接口权限（个人主体未认证的典型结果）',
  45009: '接口调用超过限额',
  40007: 'media_id 无效',
  40008: '消息格式错误',
  41001: '缺少 access_token',
};

async function req(url, opts) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  try {
    return { http: r.status, json: JSON.parse(text) };
  } catch {
    return { http: r.status, json: null, text: text.slice(0, 200) };
  }
}

/** ⚠️ 微信成功时会**省略** errcode 字段，所以判成功的条件是「没有 errcode 或 errcode===0」，
 *  不能只写 `errcode === 0` —— 那样会把成功全判成失败（本脚本第一版就是这么错的）。 */
const isOk = (j) => !!j && (j.errcode === undefined || j.errcode === 0);

function explain(j) {
  if (!j) return '';
  if (isOk(j)) return '✅ ok';
  return `❌ ${j.errcode} ${j.errmsg}${HINT[j.errcode] ? `\n       → ${HINT[j.errcode]}` : ''}`;
}

console.log(`══════ 公众号草稿箱${has('--push') ? '推送' : '探测'} ══════`);
console.log(`  账号：${WHO}　AppID：${mask(APPID)}　Secret：${mask(SECRET)}`);
console.log('');

// ── ① 换 access_token ──────────────────────────────────────────────
const tok = await req(`${API}/cgi-bin/token?grant_type=client_credential&appid=${APPID}&secret=${SECRET}`);
console.log('① 获取 access_token');
if (!tok.json?.access_token) {
  console.log(`   ${explain(tok.json)}`);
  if (tok.json?.errcode === 40164) {
    const ip = tok.json.errmsg?.match(/from ip ([0-9.]+)/)?.[1];
    if (ip) console.log(`       你的公网 IP 是 ${ip}，把它加进白名单即可。`);
  }
  process.exit(1);
}
const TOKEN = tok.json.access_token;
console.log(`   ✅ 拿到（${String(TOKEN).slice(0, 12)}…，有效期 ${tok.json.expires_in}s）`);
console.log('');

// ── ② 探测草稿箱权限 ───────────────────────────────────────────────
console.log('② 探测草稿箱接口权限（cgi-bin/draft/count）');
const cnt = await req(`${API}/cgi-bin/draft/count?access_token=${TOKEN}`);
console.log(`   原始返回 ${JSON.stringify(cnt.json)}　${explain(cnt.json)}`);
const draftOk = isOk(cnt.json);
console.log('');

// ── ③ 探测素材接口（推草稿要传封面）────────────────────────────────
console.log('③ 探测永久素材接口权限（cgi-bin/material/get_materialcount）');
const mat = await req(`${API}/cgi-bin/material/get_materialcount?access_token=${TOKEN}`);
console.log(`   原始返回 ${JSON.stringify(mat.json)}　${explain(mat.json)}`);
const matOk = isOk(mat.json);
console.log('');

// ── ④ 顺带探测发布接口（预期不可用，做个对照）──────────────────────
console.log('④ 对照：发布接口权限（cgi-bin/freepublish/batchget，预期个人号不可用）');
const pub = await req(`${API}/cgi-bin/freepublish/batchget?access_token=${TOKEN}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ offset: 0, count: 1, no_content: 1 }),
});
console.log(`   原始返回 ${JSON.stringify(pub.json)}　${explain(pub.json)}`);
console.log('');

// ── 列草稿（确认推送结果）──────────────────────────────────────────
if (has('--list')) {
  console.log('');
  console.log('══════ 草稿箱内容 ══════');
  const list = await req(`${API}/cgi-bin/draft/batchget?access_token=${TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offset: 0, count: 20, no_content: 1 }),
  });
  if (!isOk(list.json)) {
    console.log(`   ${explain(list.json)}`);
  } else {
    console.log(`   共 ${list.json.total_count} 条`);
    for (const it of list.json.item || []) {
      const a = (it.content?.news_item || [])[0] || {};
      console.log(`   · ${a.title || '（无标题）'}`);
      console.log(`     作者 ${a.author || '—'}　更新 ${new Date(it.update_time * 1000).toLocaleString('zh-CN', { hour12: false })}`);
    }
  }
}

// ── 结论 ────────────────────────────────────────────────────────────
console.log('══════ 结论 ══════');
console.log(`  草稿箱接口（draft/add）　　${draftOk ? '✅ 可用 → 能自动进草稿，你只需点发表+扫码' : '❌ 不可用'}`);
console.log(`  永久素材接口（传封面）　　 ${matOk ? '✅ 可用' : '❌ 不可用'}`);
console.log(`  发布接口（freepublish）　　${isOk(pub.json) ? '⚠️ 可用（意外；测试号权限本就特殊，不代表正式号）' : '❌ 不可用（与官方文档一致）'}`);
console.log('');
console.log('⚠️ 提醒：即便草稿箱可用，「发表」在后台仍需管理员扫码 —— 不存在无人值守的一键发布。');

if (has('--push')) {
  console.log('');
  const id = val('--push');
  if (!draftOk || !matOk) {
    console.log('❌ 草稿箱或素材接口不可用，无法推送。');
    process.exit(1);
  }

  const dir = path.join(ROOT, 'out', 'mp', id);
  if (!fs.existsSync(dir)) {
    console.error(`❌ 没有 out/mp/${id}/ —— 先跑 npm run mp -- ${id}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'mp-config.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'article.html'), 'utf8');
  const titleRaw = (fs.readFileSync(path.join(dir, '发布清单.md'), 'utf8').match(/```\n(.+?)\n```/s) || [])[1] || id;
  const title = titleRaw.trim().slice(0, 64);
  const digest = ((fs.readFileSync(path.join(dir, '发布清单.md'), 'utf8')
    .match(/## 三、摘要（≤120 字）\n\n```\n([\s\S]*?)\n```/) || [])[1] || '').trim().slice(0, 120);

  // ① 传封面为「永久缩略图素材」（草稿的 thumb_media_id 必须是永久素材）
  const cover = path.join(dir, '首图-900x383.png');
  console.log(`① 上传封面为永久素材 → ${path.basename(cover)}`);
  let thumb;
  {
    const buf = fs.readFileSync(cover);
    const fd = new FormData();
    fd.append('media', new Blob([buf], { type: 'image/png' }), 'cover.png');
    const r = await fetch(`${API}/cgi-bin/material/add_material?access_token=${TOKEN}&type=thumb`, {
      method: 'POST',
      body: fd,
      signal: AbortSignal.timeout(60_000),
    });
    const j = await r.json();
    if (!isOk(j) || !j.media_id) {
      console.log(`   ${explain(j)}`);
      process.exit(1);
    }
    thumb = j.media_id;
    console.log(`   ✅ media_id ${thumb}`);
  }
  console.log('');

  /** 在草稿箱里找标题前缀相同的草稿（标题尾部常带版本号之类的变化，取前 12 字最稳） */
  async function findDraftByTitle(t) {
    const r = await req(`${API}/cgi-bin/draft/batchget?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ offset: 0, count: 20, no_content: 1 }),
    });
    if (!isOk(r.json)) return null;
    const key = String(t).slice(0, 12);
    for (const it of r.json.item || []) {
      for (const a of (it.content && it.content.news_item) || []) {
        if (a.title && String(a.title).slice(0, 12) === key) {
          return { media_id: it.media_id, title: a.title };
        }
      }
    }
    return null;
  }

  const article = {
    title,
    author: cfg.account || '',
    digest,
    content: html,
    thumb_media_id: thumb,
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };

  // ② 已有同名草稿就**原地更新**，没有才新建。
  //    为什么非要这么做：微信的 draft/add 是「追加」语义 —— 重复推送只会在草稿箱里
  //    堆出多条同名草稿，而每条发表都要人工点一次，最后很容易点错旧版本。
  const exists = await findDraftByTitle(title);
  if (exists) {
    console.log('② 命中已有草稿，原地更新（cgi-bin/draft/update）');
    console.log(`   旧稿标题：${exists.title}`);
    const ur = await req(`${API}/cgi-bin/draft/update?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ media_id: exists.media_id, index: 0, articles: article }),
    });
    if (!isOk(ur.json)) {
      console.log(`   ${explain(ur.json)}`);
      console.log('   ⚠️ 更新失败。可先在后台手工删掉旧草稿，再重跑一次（就会转为新建）');
      process.exit(1);
    }
    console.log(`   ✅ 已更新　draft media_id：${exists.media_id}`);
  } else {
    console.log('② 新建草稿（cgi-bin/draft/add）');
    const dr = await req(`${API}/cgi-bin/draft/add?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ articles: [article] }),
    });
    if (!isOk(dr.json)) {
      console.log(`   ${explain(dr.json)}`);
      console.log('   ⚠️ 常见原因：IP 不在白名单 / 该接口对未认证号不可用 / 内容格式被拒');
      process.exit(1);
    }
    console.log(`   ✅ 已进草稿箱　draft media_id：${dr.json.media_id}`);
  }
  console.log('');
  console.log('══════ 下一步 ══════');
  console.log(`  登录公众号后台 → 草稿箱 → 打开这条草稿 → 核对 → 点「发表」→ 扫码`);
  console.log(`  标题：${title}`);
  console.log(`  ⚠️ 本脚本只建草稿，**从不发布** —— 发表必须在后台由管理员扫码完成。`);
}
