#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卡片排版自动核验（不靠肉眼）

做法：把「背景 + 光晕」当成基准图，和实际卡片求差 → 差出来的就是内容像素。
然后按安全区规则逐项断言：
  ① 内容不得越出左右安全边距
  ② 顶部 40px 内不得有内容
  ③ 内容不得压到底部页脚 / 进度条
  ④ 每张卡必须有内容（防止渲染空了）

用法：python3 scripts/verify-video-cards.py <卡片目录>
退出码：0 全过；1 有问题
"""
import importlib.util
import os
import sys

from PIL import Image, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_renderer():
    spec = importlib.util.spec_from_file_location(
        "rvc", os.path.join(ROOT, "scripts", "render-video-cards.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    cards_dir = sys.argv[1] if len(sys.argv) > 1 else "out/video-maccy/cards"
    m = load_renderer()

    W, H, PAD = m.W, m.H, m.PAD
    PROGRESS_H = 24                  # 底部进度条高度，核验时先裁掉
    FOOTER_TEXT_TOP = H - PAD - 46   # 页脚文字顶边（页脚本身不算"侵入"）
    MIN_GAP = 40                     # 正文底边与页脚之间至少要留的间距
    TOP_GUARD = 40                   # 顶部禁区高度

    bg = Image.new("RGB", (W, H), m.BG)
    bg = Image.alpha_composite(bg.convert("RGBA"), m.GLOW).convert("RGB")
    bg_core = bg.crop((0, 0, W, H - PROGRESS_H))

    files = sorted(
        f for f in os.listdir(cards_dir)
        if f.startswith("card-") and f.endswith(".png"))
    if not files:
        print(f"❌ {cards_dir} 里没有卡片")
        return 1

    problems, rows = [], []
    for f in files:
        p = os.path.join(cards_dir, f)
        im = Image.open(p).convert("RGB").crop((0, 0, W, H - PROGRESS_H))
        diff = ImageChops.difference(im, bg_core).convert("L")
        mask = diff.point(lambda v: 255 if v > 26 else 0)
        bbox = mask.getbbox()

        if not bbox:
            problems.append(f"{f}: 整张空白，没有任何内容")
            continue
        x0, y0, x1, y1 = bbox

        # ①② 边距
        if x0 < 60:
            problems.append(f"{f}: 内容左越界 x0={x0}（安全边距 60）")
        if x1 > W - 60:
            problems.append(f"{f}: 内容右越界 x1={x1}（安全上限 {W - 60}）")
        if y0 < 40:
            problems.append(f"{f}: 顶部 40px 内有内容 y0={y0}")

        # ② 顶部禁区
        top_band = mask.crop((0, 0, W, TOP_GUARD))
        if top_band.getbbox():
            problems.append(f"{f}: 顶部 {TOP_GUARD}px 内有内容")

        # ③ 正文不得压到页脚（页脚文字区间之外只允许页脚自己存在）
        body = mask.crop((0, 0, W, FOOTER_TEXT_TOP))
        bb = body.getbbox()
        content_bottom = bb[3] if bb else 0
        gap = FOOTER_TEXT_TOP - content_bottom
        if gap < MIN_GAP:
            problems.append(
                f"{f}: 正文底边 {content_bottom} 距页脚仅 {gap}px（需 ≥{MIN_GAP}）")

        rows.append((f, x0, x1, y0, y1, content_bottom))

    print(f"{'文件':<14}{'左':>5}{'右':>6}{'顶':>6}{'底':>6}{'正文底':>8}  页脚间距")
    print("-" * 62)
    for f, x0, x1, y0, y1, cb in rows:
        slack = FOOTER_TEXT_TOP - cb
        # 两头都算问题：太紧是压页脚，太松是"没做完"。
        # ⭐ 视频卡留白 ≠ 图文卡的呼吸感 —— 画面空着，观众会以为没加载出来。
        # 阈值 320px（约 1/6 卡高）是经验值：超过就该靠**放大字号**填，不是拉行距。
        if slack < 40:
            flag = "  ⚠️ 紧"
        elif slack > 320:
            flag = "  ⚠️ 空（内容没撑满）"
        else:
            flag = ""
        print(f"{f:<14}{x0:>5}{x1:>6}{y0:>6}{y1:>6}{cb:>8}  {slack:>3}px{flag}")

    print()
    if problems:
        print("❌ 发现排版问题：")
        for p in problems:
            print("   -", p)
        return 1
    print(f"✅ 全部通过：{len(files)} 张卡片，无越界 / 无侵入禁区")
    return 0


if __name__ == "__main__":
    sys.exit(main())
