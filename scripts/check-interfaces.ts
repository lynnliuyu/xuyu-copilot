/**
 * 接口能力边界探测。
 *
 * 用途：确认本应用能用哪些接口、能访问哪些目录。
 * 背景：官方文档称 2026-06-03 之后创建的应用，download / listall / filemanager /
 * precreate / meta / move 仅支持访问 /apps/{appname}；但 list 与 search 不在此名单内。
 * 实测用于确认本账号的真实边界（老应用可能不受限）。
 */
import { panGet } from '../packages/bdpan-core/src/http';
import { getAccessToken } from '../packages/bdpan-core/src/token';

const tok = await getAccessToken();

async function probe(label: string, endpoint: string, params: Record<string, unknown>) {
  try {
    const j: any = await panGet(endpoint, { access_token: tok, ...params } as any);
    const n = (j.list ?? j.info ?? []).length;
    console.log(`  OK   ${label.padEnd(40)} 返回 ${n} 条`);
    return j;
  } catch (e: any) {
    console.log(`  FAIL ${label.padEnd(40)} ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

console.log('=== list（不在限制名单内）===');
for (const dir of ['/', '/我的资源', '/淘宝出售类']) {
  await probe(`list dir=${dir}`, '/rest/2.0/xpan/file', { method: 'list', dir, limit: 5 });
}

console.log('\n=== listall（官方限制在 /apps 内）===');
for (const path of ['/', '/我的资源']) {
  await probe(`listall path=${path}`, '/rest/2.0/xpan/multimedia', {
    method: 'listall',
    path,
    recursion: 1,
    limit: 5,
  });
}

console.log('\n=== search ===');
await probe('search key=笔刷 dir=/', '/rest/2.0/xpan/file', {
  method: 'search',
  key: '笔刷',
  dir: '/',
  recursion: 1,
  num: 5,
});

console.log('\n=== filemanager move（限制名单内）===');
try {
  const res = await fetch('https://pan.baidu.com/rest/2.0/xpan/file', {
    method: 'POST',
    headers: { 'User-Agent': 'pan.baidu.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      method: 'filemanager',
      access_token: tok,
      opera: 'move',
      async: '0',
      filelist: JSON.stringify([{ path: '/__不存在的探针文件__', dest: '/我的资源' }]),
    }).toString(),
  });
  const js: any = await res.json();
  console.log(`  filemanager move -> errno=${js.errno} ${js.show_msg ?? js.errmsg ?? ''}`);
  console.log('  （该测试用不存在的源文件，errno 非 0 属预期，仅用于确认权限边界）');
} catch (e: any) {
  console.log('  filemanager 异常: ' + e.message);
}

console.log('\n=== meta（限制名单内）===');
await probe('meta fsids=[1]', '/rest/2.0/xpan/multimedia', { method: 'filemetas', fsids: '[1]' });
