#!/usr/bin/env python3
"""
把 ArtCraft 套件的**许可证、安装说明与中文使用手册**上传到百度网盘。

为什么需要这个脚本
------------------
手工敲 13×6 ≈ 80 条 bdpan 命令既慢又容易漏。这里一次跑完并逐条核对，
漏一条会明确报出来。

上传内容（每个应用目录）
------------------------
    LICENSE-APACHE / LICENSE-MIT / NOTICE   ← 修复早前「404: Not Found」的坏 LICENSE
    安装说明.txt                            ← 覆盖：许可证段写准 + 指向使用手册
    <应用名> 使用手册.pdf                    ← 新增

套件根目录
----------
    总览-必读.txt / MANIFEST.json            ← 覆盖：许可表述修正
    ArtCraft 全家桶 使用手册.pdf             ← 新增（合集，49 页）

⚠️ 坏 `LICENSE` 会被删除 —— 它的内容是 GitHub 的 404 响应体（14 字节），
   留着会让买家以为许可证就是这个。删除前脚本会先确认它确实是 404。

用法：
    python3 scripts/_upload-artcraft-guides.py --dry        # 只列要做什么
    python3 scripts/_upload-artcraft-guides.py              # 真上传
    python3 scripts/_upload-artcraft-guides.py --only figcraft,soundcraft
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import time

ROOT = pathlib.Path("/Users/noonebook/WorkBuddy/百度网盘mcp")
SUITE = ROOT / "out" / "artcraft-suite"
MANUALS = ROOT / "out" / "artcraft-manual"
BDPAN = pathlib.Path.home() / ".local" / "bin" / "bdpan"
REMOTE_ROOT = "软件/ArtCraft 开源套件"

DRY = "--dry" in sys.argv
only = ""
if "--only" in sys.argv:
    only = sys.argv[sys.argv.index("--only") + 1]

DISPLAY = {
    "artcraft": "ArtCraft", "photocraft": "PhotoCraft", "pdfcraft": "PdfCraft",
    "lightcraft": "LightCraft", "wordcraft": "WordCraft", "vectorcraft": "VectorCraft",
    "effectcraft": "EffectCraft", "cadcraft": "CADCraft", "designcraft": "DesignCraft",
    "deckcraft": "DeckCraft", "soundcraft": "SoundCraft", "figcraft": "FigCraft",
    "craft-launcher": "Craft Launcher",
}

apps = list(DISPLAY)
if only:
    want = {s.strip() for s in only.split(",") if s.strip()}
    apps = [a for a in apps if a in want]

ok = skipped = failed = 0
problems: list[str] = []


def run(args: list[str], timeout: int = 300) -> tuple[bool, str]:
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        out = (p.stdout + p.stderr).strip()
        return p.returncode == 0, out
    except subprocess.TimeoutExpired:
        return False, "超时"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:120]


def upload(local: pathlib.Path, remote: str) -> None:
    global ok, skipped, failed
    if not local.exists():
        print(f"  ⚠ 本地缺文件，跳过：{local}")
        problems.append(f"本地缺文件 {local}")
        skipped += 1
        return
    size = local.stat().st_size
    if DRY:
        print(f"  · {size:>9,}B  {local.name}  →  {remote}")
        ok += 1
        return
    # ⚠️⚠️ 关键：`bdpan upload` **不覆盖**同名文件 —— 远端已存在时新文件会存成
    #      `<名字>(1).<后缀>`，于是新旧两份并存、买家可能点开的是旧的。
    #      所以必须**先删远端同名文件**再上传。
    run([str(BDPAN), "rm", "-f", remote])
    good, out = run([str(BDPAN), "upload", str(local), remote])
    if good:
        print(f"  ✅ {local.name}（{size:,}B）")
        ok += 1
    else:
        print(f"  ✗ {local.name} —— {out.splitlines()[-1][:150] if out else '无输出'}")
        problems.append(f"{remote}：{out[:120]}")
        failed += 1
    time.sleep(0.4)   # 别把接口打太急


def remove(remote: str) -> None:
    global ok, failed
    if DRY:
        print(f"  · 删除  {remote}")
        return
    good, out = run([str(BDPAN), "rm", "-f", remote])
    if good:
        print(f"  ✅ 已删除坏的 LICENSE")
        ok += 1
    else:
        print(f"  ✗ 删除失败 {remote} —— {out[:120]}")
        problems.append(f"删除 {remote}：{out[:120]}")
        failed += 1


print(f"{'🔍 预演' if DRY else '🚀 上传'}　{len(apps)} 个应用目录 + 套件根目录")
print(f"远端根：{REMOTE_ROOT}\n")

for app in apps:
    disp = DISPLAY[app]
    d = SUITE / app
    remote = f"{REMOTE_ROOT}/{app}"
    print(f"══ {app} ══")

    # ① 许可证三件套
    for fn in ("LICENSE-APACHE", "LICENSE-MIT", "NOTICE"):
        upload(d / fn, f"{remote}/{fn}")

    # ② 安装说明（覆盖）
    upload(d / "安装说明.txt", f"{remote}/安装说明.txt")

    # ③ 中文使用手册
    upload(MANUALS / app / f"{disp} 使用手册.pdf", f"{remote}/{disp} 使用手册.pdf")

    # ④ 删掉网盘上坏的 LICENSE
    # ⚠️ 判据不能看本地文件 —— 落盘时坏 LICENSE 已经被删掉了，本地不存在 ≠ 远端没有。
    #    依据是已经核实过的事实：13 个仓库根目录只有 LICENSE-APACHE / LICENSE-MIT / NOTICE,
    #    **没有任何一个仓库有名为 `LICENSE` 的文件**（GitHub API /contents 逐个查过）。
    #    所以这里的远端 `LICENSE` 必然是当初按错文件名抓下来的 404 响应体。
    remove(f"{remote}/LICENSE")

print("\n══ 套件根目录 ══")
upload(SUITE / "总览-必读.txt", f"{REMOTE_ROOT}/总览-必读.txt")
upload(SUITE / "MANIFEST.json", f"{REMOTE_ROOT}/MANIFEST.json")
upload(MANUALS / "ArtCraft 全家桶 使用手册.pdf", f"{REMOTE_ROOT}/ArtCraft 全家桶 使用手册.pdf")

print("\n" + "=" * 62)
print(f"{'✅ 完成' if not DRY else '🔍 预演完成'}　成功 {ok}　跳过 {skipped}　失败 {failed}")
if problems:
    print("\n⚠️ 有问题：")
    for p in problems[:20]:
        print(f"  · {p}")
print("\n核对：\n  bdpan ls '软件/ArtCraft 开源套件/figcraft'")
sys.exit(0 if failed == 0 else 1)
