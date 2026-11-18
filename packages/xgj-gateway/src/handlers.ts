/**
 * 各接口的业务处理。全部返回官方「统一响应」信封。
 *
 * 依赖的数据源通过 `createHandlers(store)` 注入 —— 默认是 JSON 文件存储，
 * 其他项目可以传自己的 `GatewayStore` 实现。
 *
 * 注意一个贯穿全文件的约束：金额、库存、状态、时间戳这类字段
 * 官方要求 **整数**；写成字符串会被判为「参数错误」。所以这里所有
 * 数值字段都显式 Number() 过一遍。
 */
import {
  GOODS_STATUS,
  ORDER_STATUS,
  type Goods,
  type GoodsListData,
  type MerchantInfo,
  type OrderData,
  type OrderDetailBody,
  type PlatformInfo,
  type SubscribeListData,
  type VsBareResponse,
  type VsErrorResponse,
  type VsResponse,
} from './types';
import { getStore, type GatewayStore } from './store';
import { opt } from './config';

export const OK = <T>(data: T): VsResponse<T> => ({ code: 0, msg: 'OK', data });
export const ERR = (code: number, msg: string): VsErrorResponse => ({ code, msg });
/** 订阅类接口的成功响应：官方 schema 只有 code + msg，**不能带 data** */
export const OK_BARE = (): VsBareResponse => ({ code: 0, msg: 'OK' });

const nowSec = () => Math.floor(Date.now() / 1000);

/** 生成我们自己的货源订单号 */
function genOutOrderNo(): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
  return `SRC${t}${r}`;
}

export interface HandlerOptions {
  /**
   * 「查询平台信息」要原样回传的 app_id（= 闲管家应用概况的 AppKey）。
   * 不传则读环境变量 GOOFISH_APP_KEY。
   */
  appId?: string;
}

export type Handler = (body: any) => unknown;

export interface Handlers {
  handlePlatformInfo(): VsResponse<PlatformInfo> | VsErrorResponse;
  handleMerchantInfo(): VsResponse<MerchantInfo>;
  handleGoodsList(body: any): VsResponse<GoodsListData> | VsErrorResponse;
  handleGoodsDetail(body: any): VsResponse<Goods> | VsErrorResponse;
  handleGoodsChangeSubscribe(body: any): VsBareResponse | VsErrorResponse;
  handleGoodsChangeUnsubscribe(body: any): VsBareResponse | VsErrorResponse;
  handleGoodsChangeSubscribeList(body: any): VsResponse<SubscribeListData> | VsErrorResponse;
  handlePurchaseCreate(body: any): VsResponse<OrderData> | VsErrorResponse;
  handleOrderDetail(body: any): VsResponse<OrderData> | VsErrorResponse;
  /** 路径 → 处理函数 */
  routes: Record<string, Handler>;
  /** 官方文档里存在但本网关故意不实现的路径 */
  unimplemented: Set<string>;
}

export function createHandlers(store: GatewayStore = getStore(), options: HandlerOptions = {}): Handlers {
  // ------------------------------------------------------------ 基础接口

  /** 查询平台信息。app_id 必须是当前对接的「应用概况 AppKey」，且为整数 */
  function handlePlatformInfo(): VsResponse<PlatformInfo> | VsErrorResponse {
    const appKey = options.appId ?? opt('GOOFISH_APP_KEY');
    const appId = Number(appKey);
    if (!appKey || !Number.isFinite(appId)) {
      // 这个错误只会在我们自己的配置出问题时出现，与闲管家无关
      return ERR(1, 'GOOFISH_APP_KEY 未配置或不是整数：查询平台信息必须原样返回应用 AppKey');
    }
    return OK<PlatformInfo>({
      app_id: appId,
      features: {
        // 我们只做同步发卡：不接退款/调价/低价采购，全部如实返回 false
        is_support_order_refund: false,
        is_support_goods_notify: false,
        is_support_loss_purchase: false,
      },
    });
  }

  /** 查询商户信息。balance 必须 > 0，否则管家侧保存会失败 */
  function handleMerchantInfo(): VsResponse<MerchantInfo> {
    const balance = Number(store.merchant().balance ?? 0);
    return OK<MerchantInfo>({ balance: balance > 0 ? Math.floor(balance) : 999999 });
  }

  // ------------------------------------------------------------ 商品接口

  function handleGoodsList(body: any): VsResponse<GoodsListData> | VsErrorResponse {
    const pageNo = Number(body?.page_no);
    const pageSize = Number(body?.page_size);
    if (!Number.isFinite(pageNo) || !Number.isFinite(pageSize) || pageNo < 1 || pageSize < 1) {
      return ERR(1201, '下单参数错误：page_no / page_size 为必填正整数');
    }

    let list: Goods[] = store.loadCatalog().goods.map((g) => store.goodsWithStock(g));

    // keyword：官方要求同时支持「商品名称模糊」与「商品编码精准」
    const kw = typeof body?.keyword === 'string' ? body.keyword.trim() : '';
    if (kw) {
      const lower = kw.toLowerCase();
      list = list.filter(
        (g) => g.goods_name.toLowerCase().includes(lower) || g.goods_no.toLowerCase() === lower,
      );
    }
    // ⚠️ 2026-10-19 实测：闲管家不同应用/店铺查询时传的 goods_type 不一样
    //   （主账号传 1，另一个店铺传 2），而我们的商品原本统一标成 2 →
    //   传 1 的那一侧被过滤成空列表，后台报「获取货源商品失败」。
    //   本网关只有卡密类商品，不存在"类型区分"的语义 ⇒ **忽略 goods_type**，
    //   避免再次因为两边枚举不一致而静默返回空。
    if (body?.goods_type !== undefined && body?.goods_type !== null) {
      const t = Number(body.goods_type);
      if (t !== 1 && t !== 2) {
        list = list.filter((g) => g.goods_type === t);
      }
    }

    const count = list.length;
    const start = (pageNo - 1) * pageSize;
    const page = list.slice(start, start + pageSize);

    return OK<GoodsListData>({ list: page, count });
  }

  function handleGoodsDetail(body: any): VsResponse<Goods> | VsErrorResponse {
    const goodsNo = typeof body?.goods_no === 'string' ? body.goods_no : '';
    const goodsType = Number(body?.goods_type);
    if (!goodsNo) return ERR(1201, '下单参数错误：goods_no 必填');

    const g = store.findGoods(goodsNo);
    if (!g) return ERR(1100, `商品不存在：${goodsNo}`);
    // 同 goods/list：1/2 都是"卡密类"，两边枚举不一致时不拦（否则详情查不到、下单也会挂）
    if (goodsType && goodsType !== 1 && goodsType !== 2 && g.goods_type !== goodsType) {
      return ERR(1100, `商品类型不匹配：${goodsNo}`);
    }

    return OK<Goods>(store.goodsWithStock(g));
  }

  // ------------------------------------------------- 商品变更订阅（自动调价）

  /**
   * 订阅商品变更通知。
   *
   * ⚠️ 这是最容易漏掉、又**一定会被调用**的一个接口：闲管家在「卡密仓库配置
   * 货源商品」时，顺序是 `goods/list → goods/change/subscribe → goods/detail`。
   * 如果订阅这步返回失败，管家侧配置会**直接中断**，后面的 `goods/detail`
   * 永远不会发生 —— 现象就是「日志里只有 goods/list，然后什么都没有」。
   * （2026-10-06 实测踩过：该接口被连调 6 次后放弃，全是 unknown-path。）
   *
   * 业务上我们很简单：**只接受订阅，不主动推送**。因为：
   *   - 我们不改价（价格写死在 catalog 里）
   *   - 库存只在出卡时递减，管家下单时本来就拿到了最新库存
   * 主动推送需要反过来调管家的「商品回调通知」接口，等真有需求再接。
   *
   * 返回体按官方 schema 只有 code + msg，**不带 data**。
   */
  function handleGoodsChangeSubscribe(body: any): VsBareResponse | VsErrorResponse {
    const goodsNo = typeof body?.goods_no === 'string' ? body.goods_no : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const notifyUrl = typeof body?.notify_url === 'string' ? body.notify_url : '';
    const goodsType = Number(body?.goods_type);

    if (!goodsNo || !token || !notifyUrl || !Number.isFinite(goodsType)) {
      return ERR(1201, '参数错误：goods_type / goods_no / token / notify_url 均为必填');
    }
    if (!store.findGoods(goodsNo)) return ERR(1100, `商品不存在：${goodsNo}`);

    store.subscribeGoods({ goods_type: goodsType, goods_no: goodsNo, token, notify_url: notifyUrl });
    return OK_BARE();
  }

  /** 取消商品变更通知。未订阅也返回成功（管家重试应视为幂等） */
  function handleGoodsChangeUnsubscribe(body: any): VsBareResponse | VsErrorResponse {
    const goodsNo = typeof body?.goods_no === 'string' ? body.goods_no : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const goodsType = Number(body?.goods_type);
    if (!goodsNo || !token || !Number.isFinite(goodsType)) {
      return ERR(1201, '参数错误：goods_type / goods_no / token 均为必填');
    }
    store.unsubscribeGoods(goodsNo, token);
    return OK_BARE();
  }

  /** 查询已订阅的商品列表。管家可能用它做对账 */
  function handleGoodsChangeSubscribeList(body: any): VsResponse<SubscribeListData> | VsErrorResponse {
    const pageNo = Number(body?.page_no);
    const pageSize = Number(body?.page_size);
    if (
      !Number.isFinite(pageNo) ||
      !Number.isFinite(pageSize) ||
      pageNo < 1 ||
      pageSize < 1 ||
      pageSize > 100 // 官方注明「最大行数需支持到 100」
    ) {
      return ERR(1201, '下单参数错误：page_no / page_size 为必填正整数，且 page_size 不超过 100');
    }

    let list = store.listSubscriptions();
    if (typeof body?.goods_no === 'string' && body.goods_no) {
      list = list.filter((s) => s.goods_no === body.goods_no);
    }
    if (body?.goods_type !== undefined && body?.goods_type !== null) {
      const t = Number(body.goods_type);
      list = list.filter((s) => s.goods_type === t);
    }
    // 新的排前面，方便管家取最近一次订阅
    list = [...list].sort((a, b) => b.subscribe_time - a.subscribe_time);

    const count = list.length;
    const start = (pageNo - 1) * pageSize;
    return OK<SubscribeListData>({ list: list.slice(start, start + pageSize), count });
  }

  // ------------------------------------------------------------ 订单接口

  /**
   * 创建卡密订单。
   *
   * 我们采用**同步返回结果**（order_status=20 且带 card_items），
   * 因此不需要维护 notify_url、也不需要回调闲管家。官方明确说明：
   * 「下单结果是同步返回时，直接返回成功、失败，就不需要使用 notify_url」。
   *
   * 同步的好处是链路短、无状态、失败立刻可见；代价是如果后续要接入
   * 「异步生成分享链接」这类慢操作，就得改走 notify_url 回调。
   */
  function handlePurchaseCreate(body: any): VsResponse<OrderData> | VsErrorResponse {
    const orderNo = typeof body?.order_no === 'string' ? body.order_no : '';
    const goodsNo = typeof body?.goods_no === 'string' ? body.goods_no : '';
    const qty = Number(body?.buy_quantity);

    if (!orderNo || !goodsNo || !Number.isFinite(qty) || qty < 1) {
      return ERR(1201, '下单参数错误：order_no / goods_no / buy_quantity 必填且数量 >= 1');
    }

    // 幂等：闲管家会重试，同一 order_no 必须返回同一结果，不能再次扣卡
    const existed = store.findOrder(orderNo);
    if (existed) return OK<OrderData>(existed);

    const g = store.findGoods(goodsNo);
    if (!g) return ERR(1100, `商品不存在：${goodsNo}`);
    if (g.status !== GOODS_STATUS.ON) return ERR(1101, `商品不可用（已下架）：${goodsNo}`);

    const amount = Number(g.price) * qty;

    // 安全价校验：官方说明 max_amount 是「商家可接受的最大成本金额」，防止商家亏损
    if (body?.max_amount !== undefined && body?.max_amount !== null) {
      const max = Number(body.max_amount);
      if (Number.isFinite(max) && amount > max) {
        return ERR(1202, `下单金额低于成本价：本次需 ${amount} 分，商家可接受上限 ${max} 分`);
      }
    }

    const cards = store.claimCards(goodsNo, qty, orderNo);
    if (!cards) return ERR(1102, `商品库存不足：${goodsNo}`);

    const t = nowSec();
    const record: OrderData = {
      out_order_no: genOutOrderNo(),
      order_no: orderNo,
      order_status: ORDER_STATUS.SUCCESS,
      order_amount: amount,
      order_time: t,
      end_time: t,
      goods_no: goodsNo,
      goods_name: g.goods_name,
      buy_quantity: qty,
      card_items: cards,
      remark: '同步发卡成功',
    };

    store.saveOrder({
      ...record,
      goods_no: goodsNo,
      biz_order_no: typeof body?.biz_order_no === 'string' ? body.biz_order_no : '',
      created_at: t,
    });

    return OK<OrderData>(record);
  }

  /** 查询订单详情。管家用它核验发货结果 */
  function handleOrderDetail(body: any): VsResponse<OrderData> | VsErrorResponse {
    const orderNo = typeof body?.order_no === 'string' ? body.order_no : '';
    const outOrderNo = typeof body?.out_order_no === 'string' ? body.out_order_no : '';
    if (!orderNo && !outOrderNo) return ERR(1201, '下单参数错误：order_no 与 out_order_no 至少传一个');

    let rec = orderNo ? store.findOrder(orderNo) : undefined;
    if (!rec && outOrderNo) {
      rec = Object.values(store.loadOrders()).find((o) => o.out_order_no === outOrderNo);
    }
    if (!rec) return ERR(1200, `订单不存在：${orderNo || outOrderNo}`);

    const orderType = Number(body?.order_type);
    void (orderType as unknown as OrderDetailBody); // 类型标注用途；业务上无需分支

    return OK<OrderData>(rec);
  }

  /**
   * 尚未对接、但被文档列出的路径，明确回 1（请求错误）而不是 404，便于排查。
   *
   * 现在只剩直充下单 —— 我们是卡密货源，用不到直充；
   * 真要做直充时，加 handlers 并从这里移出去即可。
   */
  const routes: Record<string, Handler> = {
    '/goofish/open/info': () => handlePlatformInfo(),
    '/goofish/user/info': () => handleMerchantInfo(),
    '/goofish/goods/list': handleGoodsList,
    '/goofish/goods/detail': handleGoodsDetail,
    '/goofish/goods/change/subscribe': handleGoodsChangeSubscribe,
    '/goofish/goods/change/unsubscribe': handleGoodsChangeUnsubscribe,
    '/goofish/goods/change/subscribe/list': handleGoodsChangeSubscribeList,
    '/goofish/order/purchase/create': handlePurchaseCreate,
    '/goofish/order/detail': handleOrderDetail,
  };

  return {
    handlePlatformInfo,
    handleMerchantInfo,
    handleGoodsList,
    handleGoodsDetail,
    handleGoodsChangeSubscribe,
    handleGoodsChangeUnsubscribe,
    handleGoodsChangeSubscribeList,
    handlePurchaseCreate,
    handleOrderDetail,
    routes,
    unimplemented: new Set(['/goofish/order/recharge/create']),
  };
}
