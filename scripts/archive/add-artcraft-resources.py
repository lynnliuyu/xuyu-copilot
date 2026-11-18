#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 ArtCraft 套件的 13 个应用登记成项目里的「资源条目」。

依据：out/artcraft-listings.json（含网盘目录与分享链接）
口径：类别 software（软件/应用，默认 ¥2.88）；店铺留空 → 走类别默认店铺。
"""
import json
import os
import subprocess
import sys

ROOT = "/Users/noonebook/WorkBuddy/百度网盘mcp"
API = "http://127.0.0.1:8790/api/pipeline/resource.save"
LISTINGS = os.path.join(ROOT, "out", "artcraft-listings.json")

CN = {
    "artcraft": "ArtCraft AI创作工作台",
    "photocraft": "PhotoCraft 开源照片编辑器",
    "pdfcraft": "PdfCraft 开源PDF编辑器",
    "lightcraft": "LightCraft 无损修图软件",
    "wordcraft": "WordCraft 开源文字处理",
    "vectorcraft": "VectorCraft 开源矢量绘图",
    "effectcraft": "EffectCraft 动效合成工具",
    "cadcraft": "CADCraft 开源CAD制图",
    "designcraft": "DesignCraft 版面设计工具",
    "deckcraft": "DeckCraft 开源演示文稿",
    "soundcraft": "SoundCraft 开源音频工作站",
    "figcraft": "FigCraft 界面设计工具",
    "craft-launcher": "Craft Launcher 启动器",
}
NOTE_TMPL = ("来源：开源项目 storytold/{repo}（GitHub，Apache-2.0 许可，允许再分发）。"
             "安装包为官方原版、未做修改。⚠️ AI 生成功能需自备 API Key 或购买官方点数，安装包不含额度。")

DRY = "--apply" not in sys.argv

# 追加的「整套」条目：13 个应用打包成一个商品（一个链接一次拿全），¥9.90
FULLSET = {
    "repo": "artcraft-fullset",
    "repo_label": "storytold/artcraft 等 13 个开源仓库",
    "display_name": "ArtCraft 开源创作套件 13个应用",
    "root": "我的应用数据/bdpan/软件/ArtCraft 开源套件",
    "share": "https://pan.baidu.com/s/1I2NZG5s1ee3_s_cFOpK_uA",
    "pwd": "a1q1",
    "price_fen": 990,
}


def main():
    d = json.load(open(LISTINGS, encoding="utf-8"))
    items = list(d["items"])
    items.append(FULLSET)                      # 整套排在最后
    ok = 0
    for it in items:
        repo = it["repo"]
        body = {
            "id": repo,
            "name": repo,
            "display_name": it.get("display_name") or CN.get(repo, repo),
            "category": "software",
            # 单品 ¥2.88（沿用「软件/应用」类别默认价）；整套 ¥9.90
            "price_fen": it.get("price_fen") or 288,
            "notes": NOTE_TMPL.format(repo=it.get("repo_label") or f"storytold/{repo}"),
            "shop": "",                        # 空 = 用类别默认店铺（顺和）
            "cover_images": [],                # 稍后用 card.generate 生成
            "baidu": {
                "root": it.get("root") or f"我的应用数据/bdpan/软件/ArtCraft 开源套件/{repo}",
                "share_url": it["share"],
                "pwd": it["pwd"],
            },
            "quark": {"root": "", "share_url": "", "pwd": ""},
        }
        if DRY:
            print(f'  [预演] {repo:<16} {body["display_name"]:<26} {body["baidu"]["share_url"][:46]}')
            continue
        r = subprocess.run(
            ["curl", "-s", "--max-time", "60", "-X", "POST", API,
             "-H", "Content-Type: application/json", "-d", json.dumps(body, ensure_ascii=False)],
            capture_output=True, text=True, timeout=90)
        try:
            j = json.loads(r.stdout)
        except Exception:
            j = {"ok": False, "error": r.stdout[:120]}
        if j.get("ok"):
            ok += 1
            print(f'  ✅ {repo:<16} {j.get("message","已保存")}')
        else:
            print(f'  ❌ {repo:<16} {j.get("error") or r.stdout[:120]}')
    if DRY:
        print("\n[预演] 未写入。加 --apply 实际写入。")
    else:
        print(f"\n成功 {ok}/{len(d['items'])} 条")


if __name__ == "__main__":
    main()
