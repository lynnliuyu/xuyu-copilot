/**
 * 闲管家开放平台接口注册表。
 *
 * 全部路径来自官方 Apifox 文档（项目 2973339），2026-10-06 逐条核对。
 * 网关域名 https://open.goofish.pro，所有接口均为 POST + JSON body，
 * 鉴权参数（appid / timestamp / seller_id / sign）放在 query string。
 */

export const EP = {
  // ---------- 用户 ----------
  shopList: '/api/open/user/authorize/list', // 查询闲鱼店铺（无 body）
  addressList: '/api/open/user/address/list', // 查询商家地址

  // ---------- 商品 ----------
  productCategoryList: '/api/open/product/category/list', // 查询商品类目
  productPvList: '/api/open/product/pv/list', // 查询商品属性
  productList: '/api/open/product/list', // 查询商品列表
  productDetail: '/api/open/product/detail', // 查询商品详情
  productSkuList: '/api/open/product/sku/list', // 查询商品规格（仅多规格）
  productCreate: '/api/open/product/create', // 创建商品（单个）
  productBatchCreate: '/api/open/product/batchCreate', // 创建商品（批量）
  productEdit: '/api/open/product/edit', // 编辑商品
  productPublish: '/api/open/product/publish', // 上架商品
  productDownShelf: '/api/open/product/downShelf', // 下架商品
  productEditStock: '/api/open/product/edit/stock', // 编辑库存
  productDelete: '/api/open/product/delete', // 删除商品

  // ---------- 订单 ----------
  orderList: '/api/open/order/list', // 查询订单列表
  orderDetail: '/api/open/order/detail', // 查询订单详情
  orderKamiList: '/api/open/order/kam/list', // 订单卡密列表
  orderShip: '/api/open/order/ship', // 订单物流发货
  orderDummySend: '/api/open/trade/logistics/dummy/send', // 无需物流发货
  orderModifyPrice: '/api/open/order/modify/price', // 订单修改价格
  orderWaybillModify: '/api/open/trade/logistics/waybill/modify', // 修改快递单号
  addressModifyInfo: '/api/open/trade/address/modify/info', // 订单修改地址详情
  addressModifyOperate: '/api/open/trade/address/modify/operate', // 订单修改地址审核

  // ---------- 售后 ----------
  refundList: '/api/open/trade/refund/list', // 售后订单列表
  refundDetail: '/api/open/trade/refund/detail', // 售后订单详情
  refundAgree: '/api/open/trade/refund/operate/agree', // 售后订单同意退款
  refundRefuse: '/api/open/trade/refund/operate/refused', // 售后订单拒绝退款

  // ---------- 卡密 ----------
  kamiCategoryCreate: '/api/open/kami/category/create', // 卡密分类创建
  kamiCategoryList: '/api/open/kami/category/list', // 卡密分类列表
  kamiCategoryEdit: '/api/open/kami/category/edit', // 卡密分类编辑
  kamiCategoryDelete: '/api/open/kami/category/delete', // 卡密分类删除
  kamiKindCreate: '/api/open/kami/kind/create', // 卡种创建
  kamiKindList: '/api/open/kami/kind/list', // 卡种列表
  kamiKindInfo: '/api/open/kami/kind/info', // 卡种详情
  kamiKindEdit: '/api/open/kami/kind/edit', // 卡种编辑
  kamiKindDelete: '/api/open/kami/kind/delete', // 卡种删除
  kamiStorageCreate: '/api/open/kami/storage/create', // 卡种添加卡密库存
  kamiGroupCreate: '/api/open/kami/group/create', // 发卡组合创建
  kamiGroupList: '/api/open/kami/group/list', // 发卡组合列表
  kamiGroupEdit: '/api/open/kami/group/edit', // 发卡组合修改
  kamiGroupDelete: '/api/open/kami/group/delete', // 发卡组合删除
  kamiGroupUpdateStatus: '/api/open/kami/group/update/status', // 发卡组合更新状态

  // ---------- 其他 ----------
  expressCompanies: '/api/open/express/companies', // 查询快递公司
} as const;

export type EndpointKey = keyof typeof EP;

/* ========================================================================
 * 枚举
 * ====================================================================== */

/** 商品类型 item_biz_type */
export const ITEM_BIZ_TYPE: Record<number, string> = {
  2: '普通商品',
  0: '已验货',
  10: '验货宝',
  16: '品牌授权',
  19: '闲鱼严选',
  24: '闲鱼特卖',
  26: '品牌捡漏',
  35: '跨境商品',
};

/** 行业类型 sp_biz_type */
export const SP_BIZ_TYPE: Record<number, string> = {
  1: '手机',
  2: '潮品',
  3: '家电',
  8: '乐器',
  9: '3C数码',
  16: '奢品',
  17: '母婴',
  18: '美妆个护',
  19: '文玩/珠宝',
  20: '游戏电玩',
  21: '家居',
  22: '虚拟游戏',
  23: '租号',
  24: '图书',
  25: '卡券',
  27: '食品',
  28: '潮玩',
  29: '二手车',
  30: '宠植',
  31: '工艺礼品',
  33: '汽车服务',
  99: '其他',
};

/** 闲鱼特卖类型 flash_sale_type */
export const FLASH_SALE_TYPE: Record<number, string> = {
  1: '临期',
  2: '孤品',
  3: '断码',
  4: '微瑕',
  5: '尾货',
  6: '官翻',
  7: '全新',
  8: '福袋',
  99: '其他',
  2601: '微瑕',
  2602: '临期',
  2603: '清仓',
  2604: '官翻',
};

/** 订单类型 order_type（推送报文） */
export const ORDER_TYPE: Record<number, string> = {
  1: '普通订单',
  2: '分销订单',
  3: '验货宝订单',
  4: '拍卖订单',
  7: '卡密订单',
  8: '直充订单',
  9: '租赁订单',
  10: '服务订单',
};

/** 发货方式 send_way（无需物流发货） */
export const SEND_WAY: Record<number, string> = {
  1: '虚拟发货',
  2: '无需物流',
};

/** 卡种类型 kind_type（卡密） */
export const KAMI_KIND_TYPE: Record<number, string> = {
  1: '文本卡密',
  2: '链接卡密',
  3: '文件卡密',
};

/**
 * 商品服务标识 service_support。
 * 官方 FAQ 第 12 条：这不是「传了就生效」的开关，闲鱼 APP 必须已开通对应服务，
 * 否则上架会报「未开通服务或当前品类不支持开通服务; [2]-[99]」。默认留空。
 */
export const SERVICE_SUPPORT = {
  SDR: 'SDR',
} as const;
