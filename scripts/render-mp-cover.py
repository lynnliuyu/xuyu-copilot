#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
公众号封面渲染器

产出（公众号实际要用的规格）：
  首图 900×383   —— 头条封面，2.35:1
  首图 @2x 1800×766 —— 上传用（公众号会压缩，给 2 倍图更保险）
  方图 900×900   —— 次条封面 / 分享小图，1:1

⚠️ 一个很容易踩的坑：公众号封面在**不同位置裁切方式不同**——
   订阅号消息列表里是 2.35:1 横幅，但转发到聊天/朋友圈时按 **1:1 居中裁切**。
   所以标题必须**水平居中**，并且尽量落在中间 383px 宽的方形区域内，
   否则分享出去就是断头字。（这条是设计约束，不是审美偏好。）

视觉体系与卡片/封面模板同源（直接从 render-video-cards.py 取色板和字体，
避免两处各写一套导致跑偏）。

用法：python3 scripts/render-mp-cover.py <spec.json>
"""

import importlib.util
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_common():
    """复用卡片渲染器里的色板与字体工厂 —— 单一来源，防止视觉漂移。"""
    spec = importlib.util.spec_from_file_location(
        "rvc", os.path.join(ROOT, "scripts", "render-video-cards.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


C = load_common()
F = C.F
ACID, BG, GRAY, WHITE = C.ACID, C.BG, C.GRAY, C.WHITE
CARD_LINE = C.CARD_LINE
fit_font, wrap = C.fit_font, C.wrap

CHIP_BG = (44, 55, 28)


def glow(size, spots):
    """按尺寸生成柔光。spots = [(cx, cy, rx, ry, alpha)]，坐标按画布宽高比例给。"""
    w, h = size
    gw, gh = max(1, w // 4), max(1, h // 4)
    ov = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    for cx, cy, rx, ry, al in spots:
        od.ellipse([(cx - rx) * gw, (cy - ry) * gh, (cx + rx) * gw, (cy + ry) * gh],
                   fill=(*ACID, al))
    ov = ov.filter(ImageFilter.GaussianBlur(max(20, gw // 12)))
    return ov.resize(size, Image.LANCZOS)


def new_canvas(size, spots):
    img = Image.new("RGBA", size, (*BG, 255))
    img = Image.alpha_composite(img, glow(size, spots)).convert("RGB")
    return img, ImageDraw.Draw(img)


def center_text(d, cx, y, text, font, fill):
    d.text((cx - font.getlength(text) / 2, y), text, font=font, fill=fill)


def pill(d, cx, y, text, size, weight, fg, bg, border=None):
    f = F(size, weight)
    px, py = int(size * 0.95), int(size * 0.55)
    w = f.getlength(text) + px * 2
    h = size + py * 2
    x0, y0 = cx - w / 2, y
    kw = {"radius": h // 2}
    if border:
        kw["outline"] = border
        kw["width"] = 2
    else:
        kw["fill"] = bg
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], **kw)
    d.text((x0 + px, y0 + py - 1), text, font=f, fill=fg)
    return y0 + h


def SAFE_SQ(W=900):
    """横版封面里 1:1 裁切能看到的居中方形宽度。

    标题按这个宽度来定字号 —— 宁可字小一点，也不要分享出去是断头字。
    """
    return 383


# ── 横版首图 900×383 ────────────────────────────────────────────────
def render_wide(spec):
    W, H = 900, 383
    img, d = new_canvas((W, H), [(0.86, -0.25, 0.30, 0.55, 34), (0.12, 1.25, 0.32, 0.55, 20)])
    cx = W / 2

    y = pill(d, cx, 24, spec["kicker"], 23, 700, ACID, CHIP_BG)
    y += 22

    # ⚠️ 上限取「1:1 安全区」而不是画布宽度 —— 保证居中裁切不切字
    f = fit_font(max(spec["titleLines"], key=len), SAFE_SQ(W), 60, 40, 900)
    for i, line in enumerate(spec["titleLines"]):
        center_text(d, cx, y, line, f, ACID if i == len(spec["titleLines"]) - 1 else WHITE)
        y += int(f.size * 1.16)

    y += 10
    fs = F(21, 400)
    for line in wrap(spec["sub"], fs, W - 88):
        center_text(d, cx, y, line, fs, GRAY)
        y += 30

    fa = F(21, 700)
    fy = H - 42
    d.text((44, fy), spec["account"], font=fa, fill=WHITE)
    if spec.get("badge"):
        fb = F(18, 700)
        bw = fb.getlength(spec["badge"]) + 28
        d.rounded_rectangle([W - 44 - bw, fy - 6, W - 44, fy + 30], radius=18,
                            outline=ACID, width=2)
        d.text((W - 44 - bw + 14, fy - 1), spec["badge"], font=fb, fill=ACID)
    return img, f


# ── 方图 900×900 ────────────────────────────────────────────────────
def render_square(spec):
    W = H = 900
    img, d = new_canvas((W, H), [(0.84, -0.05, 0.34, 0.34, 34), (0.10, 1.05, 0.36, 0.34, 18)])
    cx = W / 2

    y = pill(d, cx, 96, spec["kicker"], 30, 700, ACID, CHIP_BG)
    y += 60

    f = fit_font(max(spec["titleLines"], key=len), W - 120, 104, 60, 900)
    for i, line in enumerate(spec["titleLines"]):
        center_text(d, cx, y, line, f, ACID if i == len(spec["titleLines"]) - 1 else WHITE)
        y += int(f.size * 1.16)

    y += 26
    fs = F(30, 400)
    for line in wrap(spec["sub"], fs, W - 140):
        center_text(d, cx, y, line, fs, GRAY)
        y += 46

    fa = F(30, 700)
    fy = H - 92
    d.text((70, fy), spec["account"], font=fa, fill=WHITE)
    if spec.get("badge"):
        fb = F(25, 700)
        bw = fb.getlength(spec["badge"]) + 38
        d.rounded_rectangle([W - 70 - bw, fy - 10, W - 70, fy + 44], radius=27,
                            outline=ACID, width=2)
        d.text((W - 70 - bw + 19, fy - 1), spec["badge"], font=fb, fill=ACID)
    return img


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    spec_path = sys.argv[1]
    spec = json.load(open(spec_path, encoding="utf-8"))
    out_dir = spec.get("out") or os.path.join("out", "mp", spec["id"])
    os.makedirs(out_dir, exist_ok=True)

    # 2.35:1 里居中那段（x 258~641）是 1:1 裁切能看到的区域，量一下标题有没有超出去
    wide, wf = render_wide(spec)
    wide.save(os.path.join(out_dir, "首图-900x383.png"))
    wide.resize((1800, 766), Image.LANCZOS).save(os.path.join(out_dir, "首图-1800x766@2x.png"))

    sq = render_square(spec)
    sq.save(os.path.join(out_dir, "方图-900x900.png"))

    widest = max(wf.getlength(l) for l in spec["titleLines"])
    zone = SAFE_SQ()
    print("  ✅ 首图-900x383.png")
    print("  ✅ 首图-1800x766@2x.png")
    print("  ✅ 方图-900x900.png")
    print(f"\n  标题字号 {wf.size}px ／ 最宽 {widest:.0f}px ／ 1:1 安全区 {zone}px")
    print(f"  → {'✅ 居中裁切不会切字' if widest <= zone else f'⚠️ 超出 {widest - zone:.0f}px'}")
    print(f"  产出目录：{out_dir}")


if __name__ == "__main__":
    main()
