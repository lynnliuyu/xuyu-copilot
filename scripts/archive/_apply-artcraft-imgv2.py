#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ArtCraft 14 条商品的封面图换成 -v2 官方素材图（在 134 上跑）。

只改两个地方，都是「图片 URL」这一个字段：
  1. drafts/<code>.json  → publish_shop[0].images = [新URL]
  2. drafts/.resources.json → <resource_id>.cover_images = [新URL]

不动店铺、不动价格、不动标题、不动正文 —— 因为那些都已经是对的。
"""
import json, os, sys, glob

ROOT = '/opt/bdpan-goofish'
DRAFTS = os.path.join(ROOT, 'drafts')
BASE = 'https://xgj.fmkj.top/goods'
APPLY = '--apply' in sys.argv

# resource_id → 新图文件名（= resource_id + '-v2.png'，即上传时的命名规则）
RIDS = ['artcraft', 'artcraft-fullset', 'photocraft', 'pdfcraft', 'lightcraft', 'wordcraft',
        'vectorcraft', 'effectcraft', 'cadcraft', 'designcraft', 'deckcraft', 'soundcraft',
        'figcraft', 'craft-launcher']
url_of = {r: f'{BASE}/{r}-v2.png' for r in RIDS}

# 1) 草稿
changed = []
for f in glob.glob(os.path.join(DRAFTS, 'BD-*.json')):
    try:
        d = json.load(open(f, encoding='utf-8'))
    except Exception:
        continue
    rid = d.get('_resource_id')
    if rid not in RIDS:
        continue
    ps = d.get('publish_shop') or []
    if not ps:
        print(f'  ⚠️ {os.path.basename(f)} 没有 publish_shop，跳过')
        continue
    old = ps[0].get('images')
    if old == [url_of[rid]]:
        continue
    ps[0]['images'] = [url_of[rid]]
    changed.append((os.path.basename(f), rid, old, url_of[rid]))
    if APPLY:
        json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

print(f'\n草稿：待改 {len(changed)} 个' + ('（已写入）' if APPLY else '（预演，未写入）'))
for name, rid, old, new in changed:
    o = (old or ['(空)'])[0]
    print(f'  {name:<24} {rid:<18}\n     旧 {o}\n     新 {new}')

# 2) 资源条目
rpath = os.path.join(DRAFTS, '.resources.json')
res = json.load(open(rpath, encoding='utf-8'))
rc = 0
for rid in RIDS:
    e = res.get(rid)
    if not e:
        print(f'  ⚠️ 资源条目 {rid} 不存在')
        continue
    if e.get('cover_images') == [url_of[rid]]:
        continue
    e['cover_images'] = [url_of[rid]]
    rc += 1
if APPLY and rc:
    json.dump(res, open(rpath, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f'\n资源条目：待改 {rc} 个' + ('（已写入）' if APPLY else '（预演，未写入）'))

# 3) 复核
if APPLY:
    bad = 0
    for f in glob.glob(os.path.join(DRAFTS, 'BD-*.json')):
        d = json.load(open(f, encoding='utf-8'))
        rid = d.get('_resource_id')
        if rid in RIDS and (d.get('publish_shop') or [{}])[0].get('images') != [url_of[rid]]:
            bad += 1
            print(f'  ❌ {os.path.basename(f)} 复核失败')
    res2 = json.load(open(rpath, encoding='utf-8'))
    for rid in RIDS:
        if (res2.get(rid) or {}).get('cover_images') != [url_of[rid]]:
            bad += 1
            print(f'  ❌ 资源 {rid} 复核失败')
    print(f'\n复核：{"全部一致 ✅" if bad == 0 else f"{bad} 处不一致 ❌"}')
