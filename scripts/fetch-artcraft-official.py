#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓 ArtCraft 套件的**官方素材**：官方图标 + 官方 UI 截图。

为什么要这个脚本
----------------
之前 14 张商品图是「同一套紫渐变模板 + 同一个通用占位图标，只换文字」，
结果在闲鱼列表里一眼看过去全一样、毫无区分度。用户要求：**用官方产品图**。

两类素材、两条来源（都是官方的、都免版权争议）：
  · 图标 —— 从**本地已下载的官方安装包**（.dmg）里提取 .app 的 .icns，
            sips 转 512px PNG。这是应用自己打包进去的图标，100% 官方。
  · 截图 —— 从各应用**官方仓库的 docs/images**（或 README）抓 UI 真实截图。
            走 gh-proxy 镜像（raw.githubusercontent.com 直连不通，见 fetch-artcraft-suite.py）。

产物：assets/artcraft-official/<app>/icon.png  +  shot.<ext>
      另出 manifest.json 记录来源 URL 与许可，便于日后审计（铁律 #26：结论要有实物证据）。

用法：
  python3 scripts/fetch-artcraft-official.py            # 全量
  python3 scripts/fetch-artcraft-official.py figcraft   # 只抓指定 app
  python3 scripts/fetch-artcraft-official.py --icons    # 只提图标
  python3 scripts/fetch-artcraft-official.py --shots    # 只抓截图
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = "/Users/noonebook/WorkBuddy/百度网盘mcp"
SUITE = os.path.join(ROOT, "out", "artcraft-suite")
DEST = os.path.join(ROOT, "assets", "artcraft-official")
MIRROR = os.environ.get("MIRROR", "https://gh-proxy.com/")

# app 目录名 = 网盘目录名 = 草稿用的 id 段
#   shot : 仓库内相对路径；artcraft 用 README 的 user-attachments（绝对 URL）
APPS = [
    {"app": "artcraft", "repo": "artcraft",
     "shot_url": "https://github.com/user-attachments/assets/21f103e3-cc19-4882-a630-9caa1b76ae31"},
    {"app": "photocraft", "repo": "photocraft", "shot": "docs/images/photocraft-demo.jpg"},
    {"app": "pdfcraft", "repo": "pdfcraft", "shot": "docs/images/pdfcraft-dark.png"},
    {"app": "lightcraft", "repo": "lightcraft", "shot": "docs/images/hero-tetons.jpg"},
    {"app": "wordcraft", "repo": "wordcraft", "shot": "docs/images/hero.png"},
    {"app": "vectorcraft", "repo": "vectorcraft", "shot": "docs/images/shot-1-neon.png"},
    {"app": "effectcraft", "repo": "effectcraft", "shot": "docs/images/effectcraft-hero.png"},
    {"app": "cadcraft", "repo": "cadcraft", "shot": "docs/images/ui-apartment.png"},
    {"app": "designcraft", "repo": "designcraft", "shot": "docs/images/ui-spread.png"},
    {"app": "deckcraft", "repo": "deckcraft", "shot": "docs/images/sample-deck.png"},
    {"app": "soundcraft", "repo": "soundcraft", "shot": "docs/images/mix.png"},
    {"app": "figcraft", "repo": "figcraft", "shot": "docs/images/shot-1-hero.png"},
    {"app": "craft-launcher", "repo": "craft-launcher",
     "shot": "docs/screenshots/artcraft-launcher-grid.png"},
]
# 单品的 DMG 文件名前缀（用于在 out/artcraft-suite/<app>/ 里找包）
DMG_HINT = {
    "artcraft": "ArtCraft_", "craft-launcher": "artcraft-launcher-",
}


def with_mirror(u):
    if not MIRROR or u.startswith(MIRROR) or "gh-proxy.com" in u:
        return u
    if "github.com" in u or "githubusercontent.com" in u:
        return MIRROR + u
    return u


def sh(args, timeout=180, check=False):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise RuntimeError(f"{args[0]} 失败: {r.stderr[:200]}")
    return r


def find_dmg(app):
    d = os.path.join(SUITE, app)
    if not os.path.isdir(d):
        return None
    hint = DMG_HINT.get(app, f"{app}-")
    cands = [f for f in os.listdir(d) if f.lower().endswith(".dmg") and f.startswith(hint)]
    if not cands:  # 退化为「目录下唯一/任意 dmg」
        cands = [f for f in os.listdir(d) if f.lower().endswith(".dmg")]
    return os.path.join(d, cands[0]) if cands else None


def extract_icon(app, outdir):
    """挂 DMG → 找 .app → 提 .icns → sips 转 512 PNG。返回 (ok, note)。"""
    dmg = find_dmg(app)
    if not dmg:
        return False, "找不到本地 dmg"
    mnt = tempfile.mkdtemp(prefix=f"acmnt-{app}-")
    try:
        r = sh(["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify",
                "-mountpoint", mnt, dmg], timeout=180)
        if r.returncode != 0:
            return False, f"挂载失败: {r.stderr.strip()[:120]}"
        apps = [x for x in os.listdir(mnt) if x.endswith(".app")]
        if not apps:
            return False, "DMG 内没有 .app"
        res = os.path.join(mnt, apps[0], "Contents", "Resources")
        if not os.path.isdir(res):
            return False, ".app 无 Resources"
        icns = [f for f in os.listdir(res) if f.lower().endswith(".icns")]
        if not icns:
            return False, "Resources 里没有 .icns"
        # 优先与应用同名的那个
        stem = apps[0][:-4].lower().replace(" ", "")
        icns.sort(key=lambda f: (stem not in f.lower().replace(" ", "").replace("-", ""), len(f)))
        src = os.path.join(res, icns[0])
        os.makedirs(outdir, exist_ok=True)
        dst = os.path.join(outdir, "icon.png")
        c = sh(["sips", "-s", "format", "png", "--resampleHeightWidthMax", "512",
                src, "--out", dst], timeout=90)
        if c.returncode != 0 or not os.path.exists(dst):
            return False, f"sips 转换失败: {c.stderr.strip()[:120]}"
        return True, f"{apps[0]} / {icns[0]}"
    finally:
        sh(["hdiutil", "detach", mnt, "-force"], timeout=90)


def fetch_shot(app_cfg, outdir):
    """抓官方截图。artcraft 走绝对 URL（README attachments），其余走仓库相对路径。"""
    repo = app_cfg["repo"]
    if app_cfg.get("shot_url"):
        url = app_cfg["shot_url"]
        name = "shot.png"
    else:
        rel = app_cfg["shot"]
        url = f"https://raw.githubusercontent.com/storytold/{repo}/main/{rel}"
        name = "shot" + os.path.splitext(rel)[1]
    os.makedirs(outdir, exist_ok=True)
    dst = os.path.join(outdir, name)
    r = sh(["curl", "-sL", "--max-time", "120", "-o", dst, with_mirror(url)], timeout=150)
    if r.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 4096:
        if os.path.exists(dst):
            os.remove(dst)
        return False, f"下载失败/过小（{r.returncode}）", url
    # 确认真是图片而非 HTML 错误页
    head = open(dst, "rb").read(12)
    if head[:4] not in (b"\x89PNG", b"GIF8", b"RIFF") and head[:2] != b"\xff\xd8":
        os.remove(dst)
        return False, "返回的不是图片（可能是 404 页面）", url
    return True, f"{os.path.getsize(dst)//1024} KB", url


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    only_icons = "--icons" in sys.argv
    only_shots = "--shots" in sys.argv
    do_icons = only_icons or not only_shots
    do_shots = only_shots or not only_icons

    picked = [a for a in APPS if not argv or a["app"] in argv]
    if not picked:
        print("没匹配到 app"); sys.exit(1)

    manifest_path = os.path.join(DEST, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        manifest = json.load(open(manifest_path, encoding="utf-8"))

    ok = fail = 0
    for a in picked:
        app = a["app"]
        outdir = os.path.join(DEST, app)
        rec = manifest.setdefault(app, {"repo": a["repo"],
                                        "license": "MIT OR Apache-2.0（storytold org）"})
        print(f"\n[{app}]")
        if do_icons:
            good, note = extract_icon(app, outdir)
            rec["icon"] = {"ok": good, "note": note,
                           "source": os.path.relpath(find_dmg(app) or "", ROOT)}
            print(f"  {'✅' if good else '❌'} 图标  {note}")
            ok += good; fail += (not good)
        if do_shots:
            good, note, url = fetch_shot(a, outdir)
            rec["shot"] = {"ok": good, "note": note, "source": url}
            print(f"  {'✅' if good else '❌'} 截图  {note}  {url}")
            ok += good; fail += (not good)

    os.makedirs(DEST, exist_ok=True)
    json.dump(manifest, open(manifest_path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"\n合计 ✅{ok}  ❌{fail}　→ {os.path.relpath(DEST, ROOT)}/  （来源与许可记在 manifest.json）")


if __name__ == "__main__":
    main()
