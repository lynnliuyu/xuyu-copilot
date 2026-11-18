import { sleep } from './errors';

/**
 * 串行限速器：保证两次调用之间至少间隔 minIntervalMs。
 * 百度网盘 listall 官方建议不超过 8~10 次/分钟，靠它兜底。
 */
export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  /** 排队执行，前一个任务完成后才轮到下一个 */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    });
    // 无论成功失败都不阻断后续排队
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
