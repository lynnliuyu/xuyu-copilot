#!/usr/bin/env python3
"""
修掉 bdpan upload 的**重名副作用**。

坑
--
`bdpan upload <local> <remote>` **不覆盖**同名文件：远端已存在时，新传上去的
会存成 `<名字>(1).<后缀>`。结果就是每个目录里新旧两份并存，而**旧的那份还带着
错误的许可证表述**（买家可能点开的就是旧的）。

修法（顺序不能反）
------------------
先 `rm -f` 掉旧的，再 `rename` 新的 `(1)` 文件为正式名字。
⚠️ 反过来做会被再追加一次 `(1)`。

用法：python3 scripts/_fix-netdisk-dupnames.py [--dry]
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import time

BDPAN = pathlib.Path.home() / ".local" / "bin" / "bdpan"
REMOTE = "软件/ArtCraft 开源套件"
DRY = "--dry" in sys.argv

APPS = [
    "artcraft", "photocraft", "pdfcraft", "lightcraft", "wordcraft", "vectorcraft",
    "effectcraft", "cadcraft", "designcraft", "deckcraft", "soundcraft", "figcraft",
    "craft-launcher",
]

# (目录, 新文件名带 (1), 正式文件名)
JOBS: list[tuple[str, str, str]] = [
    (f"{REMOTE}/{a}", "安装说明(1).txt", "安装说明.txt") for a in APPS
]
JOBS += [
    (REMOTE, "总览-必读(1).txt", "总览-必读.txt"),
    (REMOTE, "MANIFEST(1).json", "MANIFEST.json"),
]

ok = failed = 0
problems: list[str] = []


def run(*args: str) -> tuple[bool, str]:
    if DRY:
        print("   ·", " ".join(args[1:]))
        return True, ""
    try:
        p = subprocess.run([str(BDPAN), *args], capture_output=True, text=True, timeout=120)
        return p.returncode == 0, (p.stdout + p.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:100]


for d, dup, real in JOBS:
    label = d.replace(REMOTE, "") or "/"
    print(f"══ {label} ══")
    good, out = run("rm", "-f", f"{d}/{real}")
    if good:
        print(f"  ✅ 删除旧的 {real}")
    else:
        print(f"  ⚠ 删除 {real} 失败：{out[:100]}")

    good, out = run("rename", f"{d}/{dup}", real)
    if good:
        print(f"  ✅ {dup} → {real}")
        ok += 1
    else:
        print(f"  ✗ 改名失败：{out[:120]}")
        problems.append(f"{d}/{dup}：{out[:100]}")
        failed += 1
    time.sleep(0.3)

print("\n" + "=" * 60)
print(f"{'🔍 预演' if DRY else '✅ 完成'}　改名 {ok}　失败 {failed}")
if problems:
    print("⚠️ 问题：")
    for p in problems:
        print("  ·", p)
sys.exit(0 if failed == 0 else 1)
