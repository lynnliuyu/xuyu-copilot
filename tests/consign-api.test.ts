import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, stat, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error local mjs module
import { XgjWebClient, formQuery, saveSession, readSession } from '../scripts/lib/xgj-web-client.mjs';

const signature = 'key=test;secret=test;signature=test';
function runtime(calls: any[] = []) {
  return { httpSinWithKey(...args: any[]) { calls.push(args); return signature; },
    aes256EcbEncryptWithDefaultKey(value: string) { return 'cipher:' + value; },
    aes256EcbDecryptWithDefaultKey(value: string) { return value.replace(/^cipher:/, ''); } };
}
const response = (data: any, code = 0) => new Response(JSON.stringify({ code, data }));

test('info signs exact JSON bytes and query on api2; carries token, forbids redirects', async () => {
  const signed: any[] = [], requests: any[] = [];
  const client = new XgjWebClient({ runtime: runtime(signed), token: 'private-test-token', minInterval: 0,
    fetchImpl: async (url: string, options: any) => { requests.push({ url, options }); return response({ product: { product_id: 123 } }); } });
  await client.info(123);
  assert.deepEqual(signed[0], ['/v1/kami/consign/info', 'channel=1&version=3.71.1', 'POST', '{"send_type":1,"product_id":123,"product_sku":0}', 0]);
  assert.equal(requests[0].url, 'https://api2.goofish.pro/v1/kami/consign/info?channel=1&version=3.71.1');
  assert.equal(requests[0].options.headers.Authorization, 'private-test-token');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.body, signed[0][3]);
});

test('QR auth encrypts and signs ciphertext and persists only final access token', async () => {
  const signed: any[] = [], requests: any[] = [];
  const results = [{ qrcode_token: 'qr' }, { login_status: 2, login_token: 'confirmation' }, { access_token: 'new-private-token' }];
  const client = new XgjWebClient({ runtime: runtime(signed), minInterval: 0,
    fetchImpl: async (url: string, options: any) => { requests.push({ url, options }); return new Response('cipher:' + JSON.stringify({ code: 0, data: results.shift() })); } });
  await client.createLoginQr(); await client.checkLoginQr('qr');
  assert.equal(await client.finishLogin('confirmation'), 'new-private-token');
  assert.equal(signed.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(signed[i][4], 1); assert.equal(signed[i][3], requests[i].options.body);
    assert.ok(signed[i][3].startsWith('cipher:')); assert.equal(requests[i].options.headers.Authorization, undefined);
  }
  assert.equal(typeof client.request, 'undefined'); // no arbitrary production endpoint exposed
});

test('expired session stops without retries; upstream messages and tokens stay out of errors', async () => {
  let requests = 0;
  const client = new XgjWebClient({ runtime: runtime(), token: 'private-test-token', minInterval: 0,
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ code: 401, msg: 'private-test-token' })); } });
  await assert.rejects(client.info(123), (error: any) => error.auth && !error.message.includes('private-test-token'));
  await assert.rejects(client.info(123), /登录已失效/);
  assert.equal(requests, 1);
  assert.throws(() => client.info(Number.MAX_SAFE_INTEGER + 1), /不合法/);
});

test('transport timeout and invalid signatures never retry or leak raw exceptions', async () => {
  let requests = 0;
  const client = new XgjWebClient({ runtime: runtime(), token: 'test', minInterval: 0,
    fetchImpl: async () => { requests++; throw new Error('sensitive payload'); } });
  await assert.rejects(client.info(123), (error: any) => !error.message.includes('sensitive'));
  assert.equal(requests, 1);
  const invalid = new XgjWebClient({ runtime: { ...runtime(), httpSinWithKey: () => 'emsc' }, token: 'test',
    fetchImpl: async () => { requests++; return response({}); } });
  await assert.rejects(invalid.info(123), /未生成有效/);
  assert.equal(requests, 1);
});

test('form query matches official plus-space encoding, arrays, nulls, Unicode', () => {
  assert.equal(formQuery({ keyword: 'a b中文', ids: [1, 2], empty: null }), 'keyword=a+b%E4%B8%AD%E6%96%87&ids%5B%5D=1&ids%5B%5D=2&empty=');
});

test('session file is private and atomic; symlinks and loose permissions rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xgj-session-'));
  const path = join(dir, 'session.json');
  try {
    await saveSession('private-one', path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readSession(path), 'private-one');
    await saveSession('private-two', path);
    assert.equal(await readSession(path), 'private-two');
    await chmod(path, 0o644);
    await assert.rejects(readSession(path), /600/);
    await chmod(path, 0o600);
    const link = join(dir, 'link.json'); await symlink(path, link);
    await assert.rejects(readSession(link));
    await writeFile(path, JSON.stringify({ access_token: 'header\ninjection' }));
    await assert.rejects(readSession(path), /格式错误/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('single save defaults to dry-run, refuses batches and stale snapshots, verifies writes', async () => {
  const before = { product: { product_id: 123, item_id: 456, authorize_id: 789 }, consign: { status: 0, consign_id: 0 } };
  const payload = { product_id: [123], product_list: [{ product_id: 123, item_id: 456, authorize_id: 789 }],
    kind_way: 4, status: 1, send_type: 1, ex_url_status: 0, consign_id: 0, app_id: 100,
    goods_no: 'BD-TEST', goods_name: 'Test', goods_price: 288, goods_stock: 9999 };
  const urls: string[] = []; let saved = false;
  const client = new XgjWebClient({ runtime: runtime(), token: 'test', minInterval: 0,
    fetchImpl: async (url: string) => {
      urls.push(url);
      if (url.includes('/save?')) { saved = true; return response({}); }
      if (url.includes('/goods/list?')) return response({ list: [{ goods_no: 'BD-TEST', title: 'Test', purchase_price: '2.88', stock: 9999 }] });
      return response(saved ? { ...before, consign: { status: 1, kind_way: 4, app_id: 100, goods_no: 'BD-TEST' } } : before);
    } });
  await assert.rejects(client.saveSingle({ ...payload, product_id: [123, 124] }, { before, apply: true }), /单商品/);
  await assert.rejects(client.saveSingle(payload, { before: {} }), /快照不一致/);
  assert.equal((await client.saveSingle(payload, { before })).dry_run, true);
  assert.equal(saved, false);
  assert.equal((await client.saveSingle(payload, { before, apply: true })).status, 'verified');
  assert.equal(urls.filter(url => url.includes('/save?')).length, 1);
  assert.ok(urls.at(-1)?.includes('/consign/info?'));
});
