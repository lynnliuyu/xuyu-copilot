import { APP_ID, bool } from './env';
import { PAN_BASE } from './http';
import { getAccessToken } from './token';
import { assertInScope } from './paths';

/**
 * 创建分享链接（付费能力）。
 *
 * 官方依据（百度网盘开放平台）：
 *  - 《接入指南 › 计费说明》：文件分享服务为付费开放能力，购买服务后才可正式使用
 *  - 《接入指南 › 接入流程》第 2 步：文件分享服务属于企业开发者专属权益，需先完成企业开发者认证
 *  - 《创建分享链接》权限说明：本接口为付费接口，购买文件分享服务并开通分享权限后才可正式使用
 *  - 《错误码说明》公共错误码：13998 没有申请分享权限
 *
 * 因此本函数默认关闭，需在 .env 中显式设置 BDPAN_SHARE_ENABLED=true 才会真正发出请求。
 */
export interface ShareResult {
  link: string;
  short_url: string;
  share_id: number;
  period: number;
  pwd: string;
  remark?: string;
}

export interface CreateShareOptions {
  /** 要分享的文件 fs_id 列表 */
  fsids: number[];
  /** 有效期，单位天（官方必填） */
  period: number;
  /** 提取码：长度 4，数字 + 小写字母 */
  pwd: string;
  remark?: string;
}

export function shareEnabled(): boolean {
  return bool('BDPAN_SHARE_ENABLED', false);
}

export function assertShareEnabled(): void {
  if (!shareEnabled()) {
    throw new Error(
      '分享能力当前处于关闭状态。\n' +
        '原因：百度网盘「文件分享服务」是付费接口，且属于企业开发者专属权益，' +
        '未开通时调用会返回 errno=13998。\n' +
        '开通后请在 .env 中设置 BDPAN_SHARE_ENABLED=true。',
    );
  }
}

function randomPwd(len = 4): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export { randomPwd };

export async function createShare(opts: CreateShareOptions): Promise<ShareResult> {
  assertShareEnabled();
  if (!opts.fsids?.length) throw new Error('fsids 不能为空');
  if (!opts.period || opts.period <= 0) throw new Error('period 必填且需大于 0（单位：天）');
  const pwd = opts.pwd ?? randomPwd(4);
  if (!/^[a-z0-9]{4}$/.test(pwd)) throw new Error('提取码 pwd 必须是 4 位数字或小写字母');

  const access_token = await getAccessToken();
  const url = `${PAN_BASE}/apaas/1.0/share/set?product=netdisk`;

  const form = new URLSearchParams();
  form.set('appid', APP_ID());
  form.set('access_token', access_token);
  form.set('product', 'netdisk');
  form.set('fsid_list', JSON.stringify(opts.fsids.map((n) => String(n))));
  form.set('period', String(opts.period));
  form.set('pwd', pwd);
  if (opts.remark) form.set('remark', opts.remark);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'pan.baidu.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json: any = await res.json();
  if (Number(json.errno) !== 0) {
    const hint =
      Number(json.errno) === 13998
        ? '（没有申请分享权限：需完成企业开发者认证并购买文件分享服务）'
        : '';
    throw new Error(`[share/set] errno=${json.errno} ${json.show_msg ?? ''}${hint}`);
  }
  const d = json.data ?? {};
  return {
    link: d.link,
    short_url: d.short_url,
    share_id: d.share_id,
    period: d.period,
    pwd: d.pwd,
    remark: d.remark,
  };
}

/** 仅用于本地校验路径归属，避免把不该分享的路径传进来 */
export function assertSharePaths(paths: string[]): void {
  assertInScope(...paths);
}
