import { opt, bool } from '../../bdpan-core/src/env';
import { GoofishClient, type GoofishConfig } from './client';

/**
 * ⚠️ 凭证隔离：本项目同时挂了两种闲管家应用，**AppKey 不通用、签名算法也不同**。
 *   · 进销存（本适配层用：我们 → 闲管家，创建/上架/改价/下架）→ `GOOFISH_ERP_APP_*`
 *   · 虚拟货源（网关用：闲管家 → 我们，open/info 需原样返回其 AppKey）→ `GOOFISH_APP_*`
 *
 * 优先读 ERP 专用变量，未配置时回落到旧名，保证历史配置不会被悄悄改错。
 */
export const GOOFISH_APP_KEY = () => opt('GOOFISH_ERP_APP_KEY') || opt('GOOFISH_APP_KEY');
export const GOOFISH_APP_SECRET = () => opt('GOOFISH_ERP_APP_SECRET') || opt('GOOFISH_APP_SECRET');
export const GOOFISH_APP_NAME = () => opt('GOOFISH_ERP_APP_NAME') || opt('GOOFISH_APP_NAME');
export const GOOFISH_SELLER_ID = () => opt('GOOFISH_SELLER_ID');
export const GOOFISH_NOTIFY_URL = () => opt('GOOFISH_NOTIFY_URL');

/** 是否已配置进销存凭证（区分「用的是 ERP 专用值」还是「回落到旧值」） */
export const usingErpCredentials = () => Boolean(opt('GOOFISH_ERP_APP_KEY'));

/**
 * 应用 ID（数字）。卡密绑定商品时 `app_id` 必须填它，填 0 会被服务端静默忽略。
 *
 * ⚠️ 2026-10-19 实测的关键区别：
 *   · `GOOFISH_ERP_APP_KEY` = 1788532675364357 → `bdmcp-xy-j`（进销存，用来建商品/上架）
 *   · `GOOFISH_APP_KEY`     = 1787570964481861 → `bd-to-xy`（虚拟货源，**发货走这条**）
 * 卡密「关联货源」必须用 **bd-to-xy**：填 ERP 那个 ID 时服务端不回填 `goods_name`
 * （＝不认这个商品，等于白绑）；换成 bd-to-xy 后 `goods_name` 立刻被自动回填。
 */
export const appIdFromEnv = (): number => Number(opt('GOOFISH_APP_KEY') || 0);

/** 进销存应用 ID（建商品/上架用，不是卡密绑定的那个） */
export const erpAppIdFromEnv = (): number => Number(opt('GOOFISH_ERP_APP_KEY') || 0);

/** 写操作总开关。false 时所有 create/publish/delete 一律走 dry-run */
export const isLive = () => bool('GOOFISH_LIVE', false);

export function configFromEnv(): GoofishConfig {
  return {
    appKey: GOOFISH_APP_KEY(),
    appSecret: GOOFISH_APP_SECRET(),
    sellerId: GOOFISH_SELLER_ID() || undefined,
    qps: Number(opt('GOOFISH_QPS', '10')) || 10,
  };
}

let cached: GoofishClient | null = null;

export function getClient(): GoofishClient {
  if (!cached) cached = new GoofishClient(configFromEnv());
  return cached;
}
