/** 百度网盘业务错误。errno 是排查的第一顺位依据。 */
export class BdpanError extends Error {
  readonly errno: number;
  readonly requestId?: string;
  readonly showMsg?: string;
  readonly raw: unknown;
  readonly endpoint: string;

  constructor(endpoint: string, payload: any) {
    const errno = Number(payload?.errno ?? -1);
    const showMsg = String(payload?.show_msg ?? payload?.errmsg ?? '');
    const hint = ERRNO_HINTS[errno];
    super(`[${endpoint}] errno=${errno} ${showMsg}${hint ? ` — ${hint}` : ''}`);
    this.name = 'BdpanError';
    this.errno = errno;
    this.requestId = payload?.request_id ? String(payload.request_id) : undefined;
    this.showMsg = showMsg;
    this.raw = payload;
    this.endpoint = endpoint;
  }
}

/** 常见错误码的处置建议 */
export const ERRNO_HINTS: Record<number, string> = {
  '-6': 'access_token 失效或 scope 未包含 netdisk，需要重新授权',
  '-7': '文件或目录无权访问，确认用户授权与目录范围',
  '-9': '文件或目录不存在，检查绝对路径与 URL 编码',
  2: '参数错误，检查必选参数、参数值和提交方式',
  13998: '没有申请分享权限 —— 需完成企业开发者认证并购买文件分享服务',
  31034: '命中频控（listall 建议不超过 8~10 次/分钟），退避后重试',
  31066: '文件不存在，检查 path 是否正确',
  42213: '没有共享目录的权限，确认 path 是否在应用可访问范围内',
  13001: '分享状态异常，分享已过期或被取消',
  13002: '分享已过期',
  13006: '外链浏览/转存/下载人数超限',
};

const RETRYABLE = new Set([-1, -11, 31034, 429, 500]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof BdpanError) return RETRYABLE.has(err.errno);
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
