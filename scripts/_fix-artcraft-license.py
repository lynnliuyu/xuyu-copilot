#!/usr/bin/env python3
"""
修复 ArtCraft 套件的**许可证文件**（2026-10-16）。

背景（务必先读）
----------------
打包脚本 `fetch-artcraft-official.py` 当时假设许可证文件名是 `LICENSE`，并按
`raw.githubusercontent.com/storytold/<repo>/main/LICENSE` 去抓 —— 实际仓库里叫
`LICENSE-APACHE`，于是抓回来的是 GitHub 的 **404 响应体**（14 字节的
`404: Not Found`），却被当成许可证存了下来，还上传到了网盘、买家可见。

真实情况（实物证据，非推测）：
    · GitHub API `/repos/storytold/<repo>/license` → `spdx_id = Apache-2.0`
    · 但仓库根目录实际有：`LICENSE-APACHE` + `LICENSE-MIT` + `NOTICE`
      ⇒ 这是 Rust 生态的**双许可**惯例，正确写法是 `MIT OR Apache-2.0`
      （license API 只报单一 SPDX，所以不能只信它）
    · 13 个仓库全部如此，另有 vectorcraft / deckcraft 各带一个 `licenses/` 目录

本脚本做三件事：
  1. 下载真实的 LICENSE-APACHE / LICENSE-MIT / NOTICE（缺失时只下存在的）
  2. 删掉坏的 `LICENSE`，改写 `安装说明.txt` 的【许可证】段与【使用手册】段
  3. 修正套件根目录 `总览-必读.txt` 与 `MANIFEST.json` 的许可表述

用法：
    python3 scripts/_fix-artcraft-license.py            # 预演
    python3 scripts/_fix-artcraft-license.py --apply    # 落盘
⚠️ 上传网盘是另一步（见 --upload 提示），本脚本只动本地。
"""
from __future__ import annotations

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path("/Users/noonebook/WorkBuddy/百度网盘mcp")
SUITE = ROOT / "out" / "artcraft-suite"
APPLY = "--apply" in sys.argv

APPS = [
    "artcraft", "photocraft", "pdfcraft", "lightcraft", "wordcraft", "vectorcraft",
    "effectcraft", "cadcraft", "designcraft", "deckcraft", "soundcraft", "figcraft",
    "craft-launcher",
]

# 许可证相关文件：按优先级尝试，取第一个成功的
LIC_FILES = ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]
# ⚠️ 镜像顺序有讲究：实测本机**直连 raw.githubusercontent 被墙**（HTTP 000 卡满超时），
#    而 gh-proxy 镜像秒回 200。若把直连放前面，39 个文件会慢到不可用。
MIRRORS = [
    "https://gh-proxy.com/https://raw.githubusercontent.com/storytold/{repo}/main/{name}",
    "https://raw.githubusercontent.com/storytold/{repo}/main/{name}",
]
TIMEOUT = 15

NEW_LICENSE_BLOCK = """【许可证】
  MIT OR Apache-2.0 双许可 —— 开源，可自由使用、修改与再分发。
    · 同目录 LICENSE-APACHE（Apache License 2.0）
    · 同目录 LICENSE-MIT（MIT License）
    · 同目录 NOTICE（版权与署名要求）
  再分发时保留上述文件即可；软件按原样提供，不附带任何担保。"""

MANUAL_BLOCK = """【使用手册】
  同目录的《{name} 使用手册.pdf》是我们整理的中文图文手册，含：
  安装步骤、界面切换中文、快速上手、常用功能速查、常见问题与许可证说明。"""


def fetch(repo: str, name: str) -> bytes | None:
    for tpl in MIRRORS:
        url = tpl.format(repo=repo, name=name)
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
                body = r.read()
            # ⚠️ 关键防线：别再让 404 响应体冒充许可证
            if body[:1] == b"{" and b'"message"' in body[:200]:
                print(f"    ⚠ {name} 返回 JSON（多半是 404）：{body[:80]!r}")
                continue
            if b"404: Not Found" in body[:64] or b"404" == body[:3]:
                print(f"    ⚠ {name} 返回 404 文本")
                continue
            if len(body) < 100:
                print(f"    ⚠ {name} 只拿到 {len(body)} 字节，太小，跳过")
                continue
            return body
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:  # noqa: BLE001
            last = str(e)[:80]
    print(f"    ✗ {name} 三个镜像都没拿到（{last}）")
    return None


def main() -> int:
    ok = 0
    fail: list[str] = []

    for app in APPS:
        print(f"\n══ {app} ══")
        d = SUITE / app
        if not d.is_dir():
            print("  ✗ 目录不存在")
            fail.append(app)
            continue

        # ① 真实许可证文件
        got = []
        for fn in LIC_FILES:
            body = fetch(app, fn)
            if body is None:
                continue
            p = d / fn
            if APPLY:
                p.write_bytes(body)
            got.append(f"{fn}({len(body)}B)")
        if not got:
            fail.append(app)
            continue
        print(f"  ✓ 已获取：{', '.join(got)}")

        # ② 删掉坏的 LICENSE
        bad = d / "LICENSE"
        if bad.exists():
            content = bad.read_text("utf-8", "replace").strip()
            if "404" in content[:32] or len(content) < 40:
                print(f"  ✓ 删除坏的 LICENSE（内容为 {content[:32]!r}）")
                if APPLY:
                    bad.unlink()
            else:
                print(f"  ⚠ LICENSE 内容看着正常，保留：{content[:40]!r}")

        # ③ 改写 安装说明.txt
        note = d / "安装说明.txt"
        if note.exists():
            txt = note.read_text("utf-8")
            old_block = re.search(r"【许可证】\n(?:.*\n)*?\n(?=【)", txt)
            if old_block:
                print("  ✓ 替换【许可证】段")
                txt = txt[: old_block.start()] + NEW_LICENSE_BLOCK + "\n\n" + txt[old_block.end():]
            else:
                print("  ⚠ 没定位到【许可证】段，未改")

            if "【使用手册】" not in txt:
                anchor = "【校验文件完整性（可选）】"
                block = MANUAL_BLOCK.format(name=app_display(app)) + "\n\n"
                if anchor in txt:
                    txt = txt.replace(anchor, block + anchor, 1)
                else:
                    txt = txt.rstrip() + "\n\n" + block
                print("  ✓ 新增【使用手册】段")

            # 顺手把「免费、可自由使用与分发」这类措辞统一掉
            txt = txt.replace("—— 免费、开源，可自由使用与分发；保留版权声明即可。", "")
            if APPLY:
                note.write_text(txt, "utf-8")

        ok += 1

    # ④ 套件根目录：总览-必读.txt
    ov = SUITE / "总览-必读.txt"
    if ov.exists():
        t = ov.read_text("utf-8")
        before = t
        t = t.replace(
            "这是一整套开源创作软件，全部为 Apache-2.0 许可 —— 免费、可自由使用与分发。",
            "这是一整套开源创作软件，全部为 MIT OR Apache-2.0 双许可 —— 可自由使用与分发。",
        )
        t = t.replace(
            "    · LICENSE（开源许可证）与 安装说明.txt",
            "    · LICENSE-APACHE / LICENSE-MIT / NOTICE（许可证与署名）\n"
            "    · 安装说明.txt 与《<应用名> 使用手册.pdf》（中文）",
        )
        t = t.replace("开源版面设计工具（多页文档、印刷排版）", "开源版面设计工具（多页文档、印刷排版）")
        t = t.replace("开排版面设计工具", "开源版面设计工具")
        t = t.replace("整理日期：2026-10-15", "整理日期：2026-10-15（许可证与使用手册于 2026-10-16 补齐）")
        print("\n══ 总览-必读.txt ══")
        print("  ✓ 已更新" if t != before else "  · 无改动")
        if APPLY and t != before:
            ov.write_text(t, "utf-8")

    # ⑤ MANIFEST.json —— ⚠️ license 是**顶层字段**（不是每条文件记录里），别按列表遍历
    mf = SUITE / "MANIFEST.json"
    if mf.exists():
        m = json.loads(mf.read_text("utf-8"))
        print("\n══ MANIFEST.json ══")
        old = m.get("license")
        m["license"] = "MIT OR Apache-2.0"
        m["license_files"] = ["LICENSE-APACHE", "LICENSE-MIT", "NOTICE"]
        m["license_source"] = (
            "各仓库根目录实物：LICENSE-APACHE + LICENSE-MIT + NOTICE（GitHub API "
            "license.spdx_id 只报 Apache-2.0，不能只信该字段）"
        )
        m["guides"] = {a: f"{app_display(a)} 使用手册.pdf（中文）" for a in APPS}
        print(f"  ✓ license：{old!r} → 'MIT OR Apache-2.0'")
        print(f"  ✓ 新增 license_files / license_source / guides（13 份中文手册）")
        if APPLY:
            mf.write_text(json.dumps(m, ensure_ascii=False, indent=1), "utf-8")

    print(f"\n{'=' * 60}")
    print(f"{'✅ 已落盘' if APPLY else '🔍 预演完成（加 --apply 落盘）'}　成功 {ok}/{len(APPS)}　失败 {fail or '无'}")
    print("下一步：上传到网盘\n"
          "  bdpan upload out/artcraft-suite/<app>/LICENSE-APACHE '软件/ArtCraft 开源套件/<app>/LICENSE-APACHE'\n"
          "  bdpan rm '软件/ArtCraft 开源套件/<app>/LICENSE'   # 删掉坏的")
    return 0 if not fail else 1


def app_display(app: str) -> str:
    return {
        "artcraft": "ArtCraft", "photocraft": "PhotoCraft", "pdfcraft": "PdfCraft",
        "lightcraft": "LightCraft", "wordcraft": "WordCraft", "vectorcraft": "VectorCraft",
        "effectcraft": "EffectCraft", "cadcraft": "CADCraft", "designcraft": "DesignCraft",
        "deckcraft": "DeckCraft", "soundcraft": "SoundCraft", "figcraft": "FigCraft",
        "craft-launcher": "Craft Launcher",
    }[app]


if __name__ == "__main__":
    raise SystemExit(main())
