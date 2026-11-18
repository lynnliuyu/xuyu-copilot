/**
 * 闲管家商品状态映射。
 *
 * `product_status` 是数字枚举，官方文档没给完整对照表。这里的取值是对齐同类接入实现
 * 后确认的（2026-10-07），比本项目早期「拿到 detail 就打印原始 JSON」有用得多 ——
 * 至少能一眼看出商品到底在售、下架还是处理中。
 *
 * 认不出来的状态一律兜底为 `unknown`：**宁可不认识，也不要猜错**。
 * 猜错的方向性风险是不对称的 —— 把「已下架」误判成「在售」会让运营以为货还挂着。
 */

export type RemoteListingState =
  | 'unlinked'
  | 'draft'
  | 'pending_review'
  | 'on_sale'
  | 'sold_out'
  | 'down_shelved'
  | 'deleted'
  | 'unknown';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const REMOTE_STATE_LABEL: Record<RemoteListingState, { label: string; tone: Tone }> = {
  unlinked: { label: '尚未创建到闲管家', tone: 'info' },
  draft: { label: '闲管家草稿（未上架）', tone: 'neutral' },
  pending_review: { label: '上架处理中', tone: 'info' },
  on_sale: { label: '已确认在售', tone: 'success' },
  sold_out: { label: '已确认售罄', tone: 'warning' },
  down_shelved: { label: '已确认下架', tone: 'warning' },
  deleted: { label: '已确认删除', tone: 'neutral' },
  unknown: { label: '状态待确认', tone: 'warning' },
};

/** product_status → 数字。非数字返回 null（不抛错，由调用方决定兜底策略） */
export function toStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function listingStateFromRemoteStatus(value: unknown): RemoteListingState {
  const s = toStatusCode(value);
  if (s === -1) return 'deleted';
  if (s === 21) return 'draft';
  if (s === 22) return 'on_sale';
  if (s === 23 || s === 33) return 'sold_out';
  if (s === 31 || s === 36) return 'down_shelved';
  return 'unknown';
}

export function describeListingState(state: RemoteListingState): string {
  return REMOTE_STATE_LABEL[state].label;
}
