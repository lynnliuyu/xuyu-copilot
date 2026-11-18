/**
 * 发货「配置方案」——把预检结果进一步组织成「可按店铺/商品生成、可审阅拟改字段与
 * 风险、确认后仅落本地文件」的受控流程。
 *
 * ⚠️ 安全边界（本模块的全部能力）：
 *   · 只读：读网关本地台账 + 已授权的 consign 事实（out/consign-facts.json）；
 *   · 只写本地：确认后仅写 `out/delivery-plans/<id>.json`（.gitignore 内），
 *     绝不调用 `consign/save`、`dummy/send`、`kami/*` 或任何线上写接口；
 *   · 不联网：不发起任何外网查询（沙箱内可完全跑通）。
 *
 * 与「线上应用」的关系：本模块只负责生成/保存/回看计划。真正把配置写到线上
 * 是另一条需要单独授权的流程（consign:api apply / kami-auto / dummy/send），
 * 界面与本文件都会显式标注这一点，并区分：
 *   · 已有证据：网关回调路径确实工作过（本地订单台账有出卡记录）；
 *   · 未证实：线上「商品侧发货设置」当前状态（需登录态 consign/info 或后台核对）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deliverySnapshot,
  deliveryPreflight,
  type DeliveryPreflightIssue,
  type ConsignFacts,
} from './delivery';
import { SHOPS } from './resources';
import { loadListings } from './publish-draft';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 计划目录：默认 <repo>/out/delivery-plans（.gitignore 内），可用 XGJ_DELIVERY_PLANS_DIR 覆盖 */
export function plansDir(): string {
  return process.env.XGJ_DELIVERY_PLANS_DIR
    ? path.resolve(process.env.XGJ_DELIVERY_PLANS_DIR)
    : path.resolve(HERE, '..', '..', '..', 'out', 'delivery-plans');
}

/** 方案里每个拟改字段的取值来源标注 */
export interface PlanField {
  field: string;
  label: string;
  current: string;
  proposed: string;
  /** 'authoritative' = 来自已授权只读结论；'proposed' = 拟设值（应用前需线上核对） */
  source: 'authoritative' | 'proposed' | 'unknown';
  note?: string;
}

export interface PlanEvidence {
  /** 网关回调路径是否已证实工作过（本地订单台账有出卡就是证据） */
  gatewayCallback: 'proven' | 'none' | 'unproven';
  /** 线上商品侧发货设置当前状态是否已证实（需登录态/后台） */
  onlineBinding: 'verified' | 'unverified';
  note: string;
}

export interface PlanTarget {
  goods_no: string;
  goods_name: string;
  shop: string | null;
  product_id: number | null;
  /** 预检问题（原样保留，含 level） */
  issues: DeliveryPreflightIssue[];
  /** 拟改字段（kind_way / app_id / goods_no / template_id 等） */
  fields: PlanField[];
  evidence: PlanEvidence;
  /** ready = 本地预检无 blocker；blocked = 有 blocker（仍会列出，由人决定） */
  status: 'ready' | 'blocked';
}

export interface DeliveryPlan {
  id: string;
  generatedAt: string;
  scope: { shop: string | null; codes: string[] | null };
  summary: { total: number; ready: number; blocked: number };
  targets: PlanTarget[];
  /** 显式声明：线上应用需单独授权，本计划不包含任何写操作 */
  disclaimer: string;
}

const DISCLAIMER =
  '本计划仅保存在本地（out/delivery-plans/），未调用任何线上写接口。' +
  '若要应用到线上（consign/save、kami 绑定、dummy/send 发货），' +
  '必须另行获得明确授权，由受控流程执行并逐条核对结果。';

/** 计划的 id：时间戳 + 8 位随机（避免同名覆盖） */
function newPlanId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 10);
  return `plan-${ts}-${rand}`;
}

function planIdSafe(id: string): boolean {
  // 形如 plan-2026-11-18T17-57-00-004Z-sk1oufxf（ISO 时间戳里的 Z 也要允许）
  return /^plan-[0-9TZ.-]+-[a-z0-9]{8}$/.test(id);
}

/** 拟改字段：按线上配置口径列出 kind_way=4 / app_id / goods_no / template_id */
function buildFields(consignFacts: ConsignFacts, productId: number | null, goodsNo: string, templateId: number | null): PlanField[] {
  const fact = productId !== null ? consignFacts.byProduct[String(productId)] : undefined;
  // 模板 id 取自已核实的同批结论（外部注入）；没有就标 unknown，不猜。
  const tpl = templateId ?? fact?.template_id ?? null;
  return [
    {
      field: 'kind_way',
      label: '发货方式',
      current: fact ? String(fact.kind_way ?? '—') : '待核',
      proposed: '4（直接货源）',
      source: fact ? 'authoritative' : 'unknown',
      note: fact ? '来自授权只读结论' : '需登录态 consign/info 或后台核对',
    },
    {
      field: 'app_id',
      label: '货源应用',
      current: fact ? String('已绑定') : '待核',
      proposed: '绑定虚拟货源应用（如 1787570964481861）',
      source: fact ? 'authoritative' : 'unknown',
      note: 'app_id 由货源应用决定；填错会静默丢弃 goods_no',
    },
    {
      field: 'goods_no',
      label: '货源编号',
      current: goodsNo,
      proposed: goodsNo,
      source: 'authoritative',
      note: '与本地货源目录一致（只认 goods_no）',
    },
    {
      field: 'template_id',
      label: '内容模板',
      current: tpl ? String(tpl) : '待核',
      proposed: tpl ? String(tpl) : '待核',
      source: tpl ? 'authoritative' : 'unknown',
      note: tpl ? '模板需含「卡密信息」变量，否则货出但买家收不到内容' : '模板需在后台确认含卡密变量',
    },
  ];
}

/**
 * 生成方案预览（纯只读，不写盘、不联网）。
 * @param input.shop  只选一家店（user_name）；null = 全部
 * @param input.codes 指定 goods_no 列表；null = 该店全部
 */
export function generateDeliveryPlan(
  input: { shop?: string | null; codes?: string[] | null },
  consignFacts: ConsignFacts = { byProduct: {} },
): DeliveryPlan {
  const snap = deliverySnapshot(consignFacts);
  const listings = loadListings();
  const wanted = input.codes && input.codes.length ? new Set(input.codes) : null;

  const targets: PlanTarget[] = [];
  for (const g of snap.goods) {
    if (input.shop && g.shop !== input.shop) continue;
    if (wanted && !wanted.has(g.goods_no)) continue;

    const pf = deliveryPreflight(g.goods_no);
    const listing = listings[g.goods_no];
    const fact = listing?.product_id ? consignFacts.byProduct[String(listing.product_id)] : undefined;
    const tpl = fact?.template_id ?? null;

    // 证据：本地订单台账里该商品是否有出卡记录 → 网关回调路径已证实
    const gatewayCallback: PlanEvidence['gatewayCallback'] = g.last_order_no
      ? (g.last_order_kami && g.last_order_kami > 0 ? 'proven' : 'unproven')
      : 'none';
    const onlineBinding: PlanEvidence['onlineBinding'] = fact ? 'verified' : 'unverified';

    targets.push({
      goods_no: g.goods_no,
      goods_name: g.goods_name,
      shop: g.shop,
      product_id: g.product_id,
      issues: pf.issues,
      fields: buildFields(consignFacts, g.product_id, g.goods_no, tpl),
      evidence: {
        gatewayCallback,
        onlineBinding,
        note:
          (gatewayCallback === 'proven'
            ? '网关回调已有出卡证据（本地订单台账）'
            : gatewayCallback === 'unproven'
              ? '有订单但无出卡记录（可能标记发货未出卡）'
              : '网关侧无订单记录（可能从未走回调/未售出）') +
          '；' +
          (onlineBinding === 'verified'
            ? '线上发货设置已由授权只读结论核实'
            : '线上发货设置当前状态未证实（需登录态 consign/info 或后台核对）'),
      },
      status: pf.issues.some((i) => i.level === 'blocker') ? 'blocked' : 'ready',
    });
  }

  const ready = targets.filter((t) => t.status === 'ready').length;
  return {
    id: newPlanId(),
    generatedAt: new Date().toISOString(),
    scope: { shop: input.shop ?? null, codes: wanted ? [...wanted] : null },
    summary: { total: targets.length, ready, blocked: targets.length - ready },
    targets,
    disclaimer: DISCLAIMER,
  };
}

/** 确认后保存到本地（仅写文件，无网络） */
export function savePlan(plan: DeliveryPlan): { ok: true; id: string; path: string } | { ok: false; error: string } {
  if (!planIdSafe(plan.id)) return { ok: false, error: '计划 id 不合法' };
  if (!plan.targets.length) return { ok: false, error: '计划为空，没有可保存的目标' };
  const dir = plansDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.id}.json`);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2), 'utf8');
  return { ok: true, id: plan.id, path: file };
}

/** 列出已保存的计划（供回看） */
export function listPlans(): Array<{ id: string; generatedAt: string; scope: DeliveryPlan['scope']; summary: DeliveryPlan['summary']; file: string }> {
  const dir = plansDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && planIdSafe(f.replace(/\.json$/, '')))
    .map((f) => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DeliveryPlan;
        return { id: p.id, generatedAt: p.generatedAt, scope: p.scope, summary: p.summary, file: path.join(dir, f) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a!.generatedAt < b!.generatedAt ? 1 : -1)) as ReturnType<typeof listPlans>;
}

/** 读取单个计划（回看详情） */
export function loadPlan(id: string): DeliveryPlan | null {
  if (!planIdSafe(id)) return null;
  const file = path.join(plansDir(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DeliveryPlan;
  } catch {
    return null;
  }
}

/** 店铺下拉（前端展示用；与 resources.SHOPS 同源） */
export function planShops(): Array<{ user_name: string; label: string; note?: string }> {
  return SHOPS.map((s) => ({ ...s }));
}
