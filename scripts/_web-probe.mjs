/**
 * 用真实 Chrome 打开闲管家，注入 localStorage 登录态，
 * 然后**在页面上下文里**发请求 —— 这样 cookie / 风控指纹都由浏览器自己带。
 *
 * 目的：验证 `POST /v1/kami/consign/list` 在浏览器环境里能不能通。
 * 只读（list），不做任何写操作。
 */
import { chromium } from 'playwright-core';

const TOKEN = process.env.XGJ_WEB_TOKEN ?? '';
if (!TOKEN) {
  console.error('缺少 XGJ_WEB_TOKEN');
  process.exit(1);
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  console.log('① 打开 www.goofish.pro');
  await page.goto('https://www.goofish.pro/', { waitUntil: 'domcontentloaded', timeout: 45000 });

  console.log('② 注入 localStorage.access_token');
  await page.evaluate((t) => {
    localStorage.setItem('access_token', t);
  }, TOKEN);

  console.log('③ 刷新，看是否自动登录');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const url = page.url();
  const hasLogin = await page.evaluate(() => Boolean(localStorage.getItem('access_token')));
  console.log('   当前 URL:', url);
  console.log('   localStorage 有 token:', hasLogin);

  console.log('④ 在页面上下文里发 consign/list');
  const result = await page.evaluate(async (t) => {
    try {
      const r = await fetch('https://api2.goofish.pro/v1/kami/consign/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: t },
        body: JSON.stringify({ page_no: 1, page_size: 10 }),
        credentials: 'include',
      });
      const text = await r.text();
      return { status: r.status, body: text.slice(0, 400) };
    } catch (e) {
      return { status: -1, body: String(e) };
    }
  }, TOKEN);

  console.log('   HTTP', result.status);
  console.log('   ', result.body);

  console.log('\n⑤ 用页面的 axios（如果存在）再试一次');
  const axiosResult = await page.evaluate(async () => {
    const w = window;
    const cand = ['axios', '$http', 'http', 'request'];
    for (const k of cand) {
      if (w[k]) return { found: k, ok: true };
    }
    return { found: null, ok: false };
  });
  console.log('   页面全局对象:', JSON.stringify(axiosResult));

  await browser.close();
}

void main().catch((e) => {
  console.error('💥', e instanceof Error ? e.message : e);
  process.exit(1);
});
