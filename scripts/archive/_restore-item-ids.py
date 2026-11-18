#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把台账里**丢掉的 `item_id` 补回来**（在 134 上跑，直接打本机 admin API）。

为什么需要
----------
`publish.run` 写台账时是**整条覆盖**，只写 `product_id / state / title / updated_at`，
**不保留 `item_id`** —— 所以对「已在售」的商品再走一次 publish.run（换图就是这种），
台账里的 `item_id` 就没了。而 `item_id` 是「这件货在闲鱼上到底是哪一条」的唯一凭据，
掉了以后：
  · 无法直接跳去看线上详情；
  · 排查「在售但发不出货」时少了抓手；
  · 铁律 #40 说的「事后 publish.sync 补回」**其实没实现** —— `publish.sync` 只在响应里
    返回 item_id，**不落盘**；`sync:listings` 也不写。

本脚本用只读的 `product/detail`（经由 admin 的 `publish.sync`）拿真实 item_id，
再**按键合并**写回台账 —— 每条都「读最新 → 只改这一个 key → 写回」，
所以不会覆盖滴灌器等并发写入。

用法：
  python3 restore-item-ids.py                       # 预演（只报告）
  python3 restore-item-ids.py --apply               # 写回
  python3 restore-item-ids.py --apply BD-ARTCRAFT   # 只处理指定 code
  python3 restore-item-ids.py --apply --missing-only  # 只补「有 product_id 却没 item_id」的
"""
import json, os, subprocess, sys, time

LEDGER = '/opt/bdpan-goofish/drafts/.listings.json'
API = 'http://127.0.0.1:8790/api/pipeline/publish.sync'
argv = sys.argv[1:]
APPLY = '--apply' in argv
MISSING_ONLY = '--missing-only' in argv
codes_want = [a for a in argv if a.startswith('BD-')]


def sync(code):
    r = subprocess.run(['curl', '-s', '--max-time', '40', '-X', 'POST', API,
                        '-H', 'Content-Type: application/json',
                        '-d', json.dumps({'code': code})],
                       capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {}


led = json.load(open(LEDGER, encoding='utf-8'))
targets = []
for code, e in led.items():
    if not isinstance(e, dict) or not e.get('product_id'):
        continue
    if codes_want and code not in codes_want:
        continue
    if MISSING_ONLY and e.get('item_id'):
        continue
    targets.append(code)

print(f'台账 {len(led)} 条；命中待补 {len(targets)} 条' + ('（已写入）' if APPLY else '（预演）'))

fixed = same = nodata = 0
for i, code in enumerate(targets, 1):
    d = sync(code)
    iid = (d.get('detail') or {}).get('item_id')
    cur = (json.load(open(LEDGER, encoding='utf-8')).get(code) or {}).get('item_id')
    if not iid:
        print(f'  ⚠️ {code:<24} 线上查不到 item_id ({d.get("message", "")[:40]})')
        nodata += 1
        continue
    if cur == iid:
        same += 1
        continue
    print(f'  {"✅" if APPLY else "·"} {code:<24} item_id {cur} → {iid}')
    if APPLY:
        # ⭐ 读-改-写：重读一次最新台账，只动这一个 key，避免覆盖并发写入
        fresh = json.load(open(LEDGER, encoding='utf-8'))
        fresh.setdefault(code, {})['item_id'] = iid
        tmp = LEDGER + '.tmp'
        json.dump(fresh, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        os.replace(tmp, LEDGER)
    fixed += 1
    time.sleep(0.4)

print(f'\n补回 {fixed} · 本来就有 {same} · 查不到 {nodata}')
