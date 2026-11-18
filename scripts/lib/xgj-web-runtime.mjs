import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const CACHE = fileURLToPath(new URL('../../.cache/xgj-web/', import.meta.url));
const APP_URL = 'https://www.goofish.pro/app_v3.71.1_1791804226263.js';
const WASM_URL = 'https://xgj-wasm.goofish.pro/utils.wasm.gz';
const APP_HASH = '622a073d14243dc4c2c6af7b3c19297d28fb6ded72274c7f6cc71fc943ea8dd1';
const WASM_HASH = '640e37887c2fddd4859768367035bf5ff5dccfdddd2a51896555d29b83f12989';
const LOADER_HASH = 'f31917827bfd98edee28fa9f7aaa920f1ca51b19337b767133a06753dfa3daff';
const hash = data => createHash('sha256').update(data).digest('hex');
function checked(data, expected) {
  if (hash(data) !== expected) throw new Error('官方运行库版本或校验值变化，停止加载；需要重新审核');
  return data;
}

/** Explicit setup only. Runtime never downloads or evaluates a changing remote bundle. */
export async function installRuntime() {
  const download = async url => {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`运行库下载失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const [appBytes, wasmRaw] = await Promise.all([download(APP_URL), download(WASM_URL)]);
  const app = checked(appBytes, APP_HASH).toString('utf8');
  const wasm = checked(wasmRaw[0] === 31 ? gunzipSync(wasmRaw) : wasmRaw, WASM_HASH);
  // Decode only aliases of the bundle's string-table function. Arbitrary hex calls
  // are real program logic and MUST NOT be replaced (e.g. filesystem errno).
  const init = app.slice(0, app.indexOf(',function(_0x1fc8af)')) + ');';
  const table = app.slice(app.indexOf('function a310_0x39bd'));
  const context = vm.createContext(Object.create(null));
  vm.runInContext(table + '\n' + init, context, { timeout: 3000 });
  const aliases = new Set([...app.matchAll(/(_0x[a-f0-9]+)=a310_0x5dcd/g)].map(m => m[1]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of app.matchAll(/(_0x[a-f0-9]+)=(_0x[a-f0-9]+)/g)) {
      if (aliases.has(m[2]) && !aliases.has(m[1])) { aliases.add(m[1]); changed = true; }
    }
  }
  const decoded = app.replace(/(_0x[a-f0-9]+)\(0x([a-f0-9]+)\)/g,
    (match, name, hex) => aliases.has(name) ? JSON.stringify(context.a310_0x5dcd(parseInt(hex, 16))) : match);
  const ts = await import('typescript');
  const ast = ts.createSourceFile('bundle.js', decoded, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let loader;
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.text === './src/common/data/utils.js') loader = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  checked(loader || '', LOADER_HASH);
  await mkdir(CACHE, { recursive: true, mode: 0o700 });
  await writeFile(CACHE + 'loader.js', loader, { mode: 0o600 });
  await writeFile(CACHE + 'utils.wasm', wasm, { mode: 0o600 });
}

/** Official WASM with a minimal JS compatibility environment; no browser, DOM or network. */
export async function loadRuntime() {
  let loader, bytes;
  try {
    [loader, bytes] = await Promise.all([readFile(CACHE + 'loader.js'), readFile(CACHE + 'utils.wasm')]);
  } catch { throw new Error('先执行 npm run consign:api -- setup 安装已固定校验值的官方运行库'); }
  checked(loader, LOADER_HASH); checked(bytes, WASM_HASH);
  const context = vm.createContext({
    window: { location: { hostname: 'www.goofish.pro' } },
    navigator: { languages: ['zh-CN'], userAgent: 'bdpan-goofish-node' },
    localStorage: { getItem: () => null },
    // No credentials in this context. Official code uses console for diagnostics.
    console: { log() {}, warn() {}, error() {} },
    TextDecoder, TextEncoder, WebAssembly, URL, crypto: webcrypto,
    setTimeout, clearTimeout, setInterval, clearInterval,
    a310_0x5dcd: () => undefined,
  });
  const requireStub = name => {
    if (name.includes('defineProperty')) return { default: (obj, key, value) => (obj[key] = value, obj) };
    if (name.includes('/buffer/')) return { Buffer };
    if (name.includes('/core-js/') || name.includes('/mock/process.js')) return {};
    throw new Error('官方运行库出现未知依赖');
  };
  requireStub.r = () => {};
  requireStub.n = value => ({ a: value });
  const exports = {};
  const factory = vm.runInContext('(' + loader.toString('utf8') + ')', context, { timeout: 3000 });
  factory({ exports }, exports, requireStub);
  return await exports.default({ wasmBinary: bytes, locateFile: () => '/unused' });
}
