#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 ArtCraft 套件生成中文说明文件（每个应用一份 + 顶层总览）。

为什么要生成：
  · **合规**：Apache-2.0 要求分发时随附许可证说明与出处；
  · **增值**：这批软件全是英文界面、且官网在 GitHub，中文用户拿到手往往不会装；
  · **免责**：写明「安装包原样来自官方、未做修改」，以及 ArtCraft 的 AI 额度另计。
"""
import os

ROOT = "/Users/noonebook/WorkBuddy/百度网盘mcp"
DEST = os.path.join(ROOT, "out", "artcraft-suite")

# repo -> (中文名, 一句话定位, 官网路径, 版本)
APPS = {
    "artcraft":      ("ArtCraft",      "AI 创作工作台：可先在 2D/3D 画布搭场景、摆机位与姿势，再让 AI 出图/出视频", "/", "v0.41.0"),
    "photocraft":    ("PhotoCraft",    "开源照片编辑器（修图、图层、滤镜）", "/apps/photocraft", "v0.9.0"),
    "pdfcraft":      ("PdfCraft",      "开源 PDF 阅读与编辑器（批注、合并、拆分）", "/apps/pdfcraft", "v0.8.0"),
    "lightcraft":    ("LightCraft",    "开源无损照片编辑器（调色、批量处理，修改可随时回退）", "/apps/lightcraft", "v0.8.0"),
    "wordcraft":     ("WordCraft",     "开源文字处理软件（文档排版、打印）", "/apps/wordcraft", "v0.7.0"),
    "vectorcraft":   ("VectorCraft",   "开源矢量绘图工具（SVG、路径、图标设计）", "/apps/vectorcraft", "v0.11.0"),
    "effectcraft":   ("EffectCraft",   "开源动效与合成工具（时间轴、合成、特效）", "/apps/effectcraft", "v0.10.0"),
    "cadcraft":      ("CADCraft",      "开源 CAD 制图工具（二维绘图与标注）", "/apps/cadcraft", "v0.7.0"),
    "designcraft":   ("DesignCraft",   "开排版面设计工具（多页文档、印刷排版）", "/apps/designcraft", "v0.8.0"),
    "deckcraft":     ("DeckCraft",     "开源演示文稿工具（幻灯片制作）", "/apps/deckcraft", "v0.7.0"),
    "soundcraft":    ("SoundCraft",    "开源音频工作站（多轨录音、剪辑混音）", "/apps/soundcraft", "v0.7.0"),
    "figcraft":      ("FigCraft",      "开源界面设计与原型工具（UI 稿、协作）", "/apps/figcraft", "v0.6.0"),
    "craft-launcher": ("Craft Launcher", "Craft 全家桶的启动器（一个入口管理上面这些应用）", "/apps", "v0.4.1"),
}

LINE = "═" * 62


def install_block(repo, win_pkg, mac_pkg):
    w = f"    · 双击 {win_pkg} 一路「下一步」即可" if win_pkg.endswith(".msi") \
        else f"    · 双击 {win_pkg} 按提示安装"
    return f"""【安装方法】
  Windows（建议 64 位）
{w}
    · 若想免安装：解压同目录的 windows-x64-portable.zip，直接运行里面的 exe
  macOS
    · 双击 {mac_pkg}，把图标拖进「应用程序」

  ⚠️ 首次运行可能被系统拦一下，属正常现象：
     Windows：点「更多信息 → 仍要运行」
     macOS：到「系统设置 → 隐私与安全性」点「仍要打开」
"""


def main():
    files = {}
    for repo in APPS:
        d = os.path.join(DEST, repo)
        if not os.path.isdir(d):
            continue
        files[repo] = sorted(os.listdir(d))

    for repo, (cn, desc, path, ver) in APPS.items():
        if repo not in files:
            continue
        # ⚠️ 必须在这里重新算 d —— 否则会沿用上面那个循环残留的 d（= 最后一个目录），
        #    结果 13 份说明文件全写进同一个目录里，而日志照样打印 ✅。
        d = os.path.join(DEST, repo)
        ls = files[repo]
        win = next((f for f in ls if f.endswith(".msi") or f.endswith("-setup.exe")), "")
        mac = next((f for f in ls if f.endswith(".dmg")), "")
        has_sums = "SHA256SUMS.txt" in ls

        extra = ""
        if repo == "artcraft":
            extra = """
【关于 AI 生成额度（重要）】
  本软件本身**免费开源**。但其中的 AI 生图 / 生视频功能需要连接模型服务：
    · 你可以填入自己的 API Key（BYO Key，软件支持自带密钥），或
    · 到官网购买点数（credits）
  **安装包内不含任何 AI 额度**，请知悉后再决定是否需要。
"""
        verify = """【校验文件完整性（可选）】
  安装包是官方原版，可用同目录 SHA256SUMS.txt 里的值核对：
    Windows：certutil -hashfile <文件名> SHA256
    macOS：  shasum -a 256 <文件名>
""" if has_sums else """【校验文件完整性（可选）】
  本应用官方 release 未提供 SHA256SUMS 文件；安装包按官方原始文件原样保存。
"""

        txt = f"""{LINE}
  ArtCraft · 开源创作套件
  {cn} —— {desc}
  版本 {ver}
{LINE}

【这是什么】
  {desc}
  项目官网：https://getartcraft.com{path}
  源码仓库：https://github.com/storytold/{repo}

【许可证】
  Apache License 2.0（详见同目录 LICENSE 文件）
  —— 免费、开源，可自由使用与分发；保留版权声明即可。

{install_block(repo, win, mac)}
{verify}{extra}
【来源说明】
  本目录内的安装包**均下载自官方 GitHub Releases 原文件，未做任何修改或封装**。
  打包整理日期：2026-10-15
{LINE}
"""
        with open(os.path.join(d, "安装说明.txt"), "w", encoding="utf-8") as f:
            f.write(txt)
        print(f"  ✅ {repo}/安装说明.txt")

    # 顶层总览
    rows = []
    for repo, (cn, desc, path, ver) in APPS.items():
        if repo in files:
            mb = sum(os.path.getsize(os.path.join(DEST, repo, f)) for f in files[repo]) / 1048576
            rows.append(f"  {cn:<16}{ver:<10}{mb:6.0f} MB   {desc[:34]}")
    overview = f"""{LINE}
  ArtCraft · 开源创作套件（共 {len(rows)} 个应用）
{LINE}

  这是一整套开源创作软件，全部为 Apache-2.0 许可 —— 免费、可自由使用与分发。
  每个应用一个子目录，内含：
    · Windows 安装版（.msi）+ 免安装版（.zip）
    · macOS 安装版（.dmg）
    · LICENSE（开源许可证）与 安装说明.txt

{chr(10).join(rows)}

【重要提示】
  · 这些软件全部可在官网免费下载（https://getartcraft.com）。本目录只是把
    各平台的官方安装包集中整理、附上中文安装说明，方便一次性获取。
  · 其中 **ArtCraft** 的 AI 生图 / 生视频需要自备 API Key 或购买官方点数，
    安装包内不含任何 AI 额度。
  · 所有安装包均为官方原版，未做任何修改；出处见各目录的「安装说明.txt」。

  整理日期：2026-10-15
{LINE}
"""
    with open(os.path.join(DEST, "总览-必读.txt"), "w", encoding="utf-8") as f:
        f.write(overview)
    print(f"  ✅ 总览-必读.txt（{len(rows)} 个应用）")


if __name__ == "__main__":
    main()
