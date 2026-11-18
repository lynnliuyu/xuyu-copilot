/**
 * 公共 API：把闲管家「虚拟货源」网关嵌进你自己的服务。
 *
 * 两种用法：
 *
 * 1) 直接跑进程（Docker / CLI）：
 *      import { run } from '@bdpan/xgj-gateway';
 *      run();
 *
 * 2) 接自己的数据源（商品与卡密来自数据库/HTTP，而不是 JSON 文件）：
 *      import { createServer, createJsonStore, type GatewayStore } from '@bdpan/xgj-gateway';
 *      const store: GatewayStore = { ...你自己实现... };
 *      createServer({ config, store }).listen(8787);
 *
 * 协议契约见同目录 README.md。
 */
export {
  createHandlers,
  OK,
  ERR,
  OK_BARE,
  type Handlers,
  type Handler,
  type HandlerOptions,
} from './handlers';

export {
  createServer,
  configSummary,
  normalizePath,
  inGoofishRange,
  GOOFISH_CIDRS,
  type ServerOptions,
} from './server';

export {
  createJsonStore,
  createMemoryStore,
  getStore,
  seedCheckout,
  dataDir,
  isShared,
  type GatewayStore,
  type Catalog,
  type CardRecord,
  type MerchantConfig,
  type OrderRecord,
  type SubscriptionRecord,
} from './store';

export { loadConfig, configProblems, opt, bool, type GatewayConfig } from './config';
export { genVsSign, md5, safeEqual, compactBody } from './sign';
export * from './types';

import { loadConfig, configProblems } from './config';
import { createServer } from './server';
import { getStore, seedCheckout } from './store';

/**
 * 起一个进程内的网关。缺配置时抛错（而不是静默跑起来等第一次请求才 401）。
 * 返回 http.Server，方便调用方自行管理生命周期。
 */
export function run(config = loadConfig()) {
  const problems = configProblems(config);
  if (problems.length) {
    throw new Error(`配置不完整：\n  - ${problems.join('\n  - ')}`);
  }
  const store = getStore();
  seedCheckout(store);
  const server = createServer({ config, store });
  server.listen(config.port, '0.0.0.0');
  return server;
}
