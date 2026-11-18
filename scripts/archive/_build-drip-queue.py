#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重组滴灌队列：把「14 条 ArtCraft 换图」插到队首，后面接上未完成的 Blender 重上架。

为什么合并成一条队列（而不是两个脚本各自跑）：
  服务端 300s 节流是**单闸门**（`takeSlot()`）。两个循环同时抢，会互相把对方顶成
  RATE_LIMIT，节奏全乱、日志也读不清。合并成一条队列 = 一个循环、一个节奏。

用法：python3 build-queue.py            # 预演
      python3 build-queue.py --apply    # 写 out/drip-shunhe-codes.json
"""
import json, os, sys, glob

OUT = '/opt/bdpan-goofish/out'
DRAFTS = '/opt/bdpan-goofish/drafts'
APPLY = '--apply' in sys.argv

RIDS = ['artcraft-fullset', 'artcraft', 'figcraft', 'photocraft', 'pdfcraft', 'lightcraft',
        'wordcraft', 'vectorcraft', 'effectcraft', 'cadcraft', 'designcraft', 'deckcraft',
        'soundcraft', 'craft-launcher']

# resource_id → 草稿 code
code_of = {}
for f in glob.glob(os.path.join(DRAFTS, 'BD-*.json')):
    d = json.load(open(f, encoding='utf-8'))
    if d.get('_resource_id') in RIDS:
        code_of[d['_resource_id']] = d['code']

missing = [r for r in RIDS if r not in code_of]
if missing:
    sys.exit(f'❌ 这些资源没找到对应草稿：{missing}')

refresh = [code_of[r] for r in RIDS]

old_codes = json.load(open(f'{OUT}/drip-shunhe-codes.json'))
prog = json.load(open(f'{OUT}/drip-shunhe-progress.json'))
done = {x['code'] for x in prog.get('live', [])} | {x['code'] for x in prog.get('bad', [])}
rest = [c for c in old_codes if c not in done and c not in refresh]

print(f'换图（队首）：{len(refresh)} 条')
for c in refresh:
    print(f'   {c}')
print(f'\nBlender 剩余（队尾）：{len(rest)} 条')
print(f'   例：{rest[:3]} … {rest[-2:]}')
print(f'\n合计 {len(refresh) + len(rest)} 条，预计 {((len(refresh)+len(rest))*305/3600):.1f} 小时')
print(f'   其中换图部分：{len(refresh)*305/60:.0f} 分钟')

if APPLY:
    # 先把旧队列与日志留档，便于回溯
    for src, suf in ((f'{OUT}/drip-shunhe-codes.json', 'before-imgv2'),
                     (f'{OUT}/drip-shunhe-progress.json', 'before-imgv2'),
                     (f'{OUT}/drip-shunhe.log', 'before-imgv2')):
        if os.path.exists(src):
            dst = src.replace('.json', f'.{suf}.json').replace('.log', f'.{suf}.log')
            if not os.path.exists(dst):
                os.rename(src, dst)
                print(f'   留档 {os.path.basename(dst)}')
    json.dump(refresh + rest, open(f'{OUT}/drip-shunhe-codes.json', 'w'), ensure_ascii=False, indent=0)
    print('\n✅ 新队列已写入 out/drip-shunhe-codes.json')
else:
    print('\n（预演，未写入）')
