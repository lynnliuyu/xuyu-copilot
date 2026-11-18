#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
竖版短视频卡片渲染器（1080×1920，9:16）

用途：把一份 JSON 规格渲染成一组卡片 PNG，供 make-video.mjs 装成 MP4。
换软件只需换 JSON —— 视觉体系锁定在代码里，不让每期跑偏。

视觉体系（与 docs/开源软件公众号-封面模板使用说明.md 一致）
  底色 #0E1116 ｜ 强调 #C8FF3D ｜ 辅助 #8B94A3 ｜ 正文 #FFFFFF
  字体 Noto Sans SC（可变字重 100–900，即思源黑体同源版本）
  ⚠️ 底线 28px，放不下就删字，不要缩字号

⚠️ 视频卡和图文卡不一样：图文卡可以留白，视频卡留白就是"空"。
   所以这里有一套自适应布局 —— 内容会按可用高度撑开（行高/间隔在合理区间内浮动），
   避免出现头重脚轻的大片空洞。

用法：
  python3 scripts/render-video-cards.py <spec.json> <输出目录>

依赖：Pillow；字体默认读 .cache/fonts/NotoSansSC-VF.ttf（可用 CARD_FONT 覆盖）
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── 画布与色板 ──────────────────────────────────────────────────────
W, H = 1080, 1920
PAD = 96
SAFE_W = W - PAD * 2

BG = (14, 17, 22)          # #0E1116
ACID = (200, 255, 61)      # #C8FF3D
GRAY = (139, 148, 163)     # #8B94A3
WHITE = (255, 255, 255)
DIM = (86, 94, 108)

CARD_BG = (20, 24, 31)
CARD_LINE = (38, 44, 54)

FOOTER_TEXT_TOP = H - PAD - 46          # 页脚文字顶边
REGION_BOTTOM = FOOTER_TEXT_TOP - 44    # 正文区底界（给页脚留出的呼吸）
GAP_AFTER_HEADER = 56

FONT_PATH = os.environ.get("CARD_FONT", ".cache/fonts/NotoSansSC-VF.ttf")

_font_cache = {}


def F(size, weight=400):
    """取字体。weight 走可变轴：400 常规 / 500 中等 / 700 粗 / 900 极粗。"""
    key = (size, weight)
    if key not in _font_cache:
        f = ImageFont.truetype(FONT_PATH, size)
        try:
            f.set_variation_by_axes([weight])
        except Exception:
            pass
        _font_cache[key] = f
    return _font_cache[key]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def fit_font(text, max_w, start, min_size, weight):
    """自动缩到能放下为止（下限 min_size，再小就说明该删字了）。"""
    s = start
    while s > min_size:
        f = F(s, weight)
        if f.getlength(text) <= max_w:
            return f
        s -= 4
    return F(min_size, weight)


def wrap(text, font, max_w):
    """按像素宽度折行（逐字符，适配中英混排）。"""
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if font.getlength(cur + ch) <= max_w:
            cur += ch
        else:
            lines.append(cur)
            cur = ch
    if cur:
        lines.append(cur)
    return lines


def distribute(heights, top, bottom, gap=56, gap_max_mult=3.4):
    """在 [top, bottom] 内垂直分布若干块，返回每块的 y 起点。

    间隔先取 gap；有余量就均匀放大（上限 gap×gap_max_mult）；仍有余量则整体居中。
    """
    n = len(heights)
    avail = bottom - top
    total = sum(heights)
    if n <= 1:
        return [top + max(0, (avail - total) / 2)]
    want = (avail - total) / (n - 1)
    g = clamp(want, gap, gap * gap_max_mult)
    need = total + g * (n - 1)
    y = top + max(0, (avail - need) / 2)
    ys = []
    for h in heights:
        ys.append(y)
        y += h + g
    return ys


# ── 背景光晕（只算一次，6 张卡复用）────────────────────────────────
def _build_glow():
    gw, gh = W // 4, H // 4
    ov = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
    od = ImageDraw.Draw(ov)
    od.ellipse([gw - 110, -100, gw + 135, 150], fill=(*ACID, 34))
    ov = ov.filter(ImageFilter.GaussianBlur(58))
    return ov.resize((W, H), Image.LANCZOS)


GLOW = _build_glow()


def canvas_pair():
    img = Image.new("RGBA", (W, H), (*BG, 255))
    img = Image.alpha_composite(img, GLOW).convert("RGB")
    return img, ImageDraw.Draw(img)


# ── 通用元件 ────────────────────────────────────────────────────────
def chip(d, y, text, size=34, weight=700, color=ACID):
    f = F(size, weight)
    px, py = 28, 18
    x1 = PAD + f.getlength(text) + px * 2
    y1 = y + size + py * 2
    d.rounded_rectangle([PAD, y, x1, y1], radius=(y1 - y) // 2, fill=(44, 55, 28))
    d.text((PAD + px, y + py - 2), text, font=f, fill=color)
    return y1


def footer(d, name, right, idx, total):
    f_name, f_right = F(38, 700), F(32, 400)
    y = FOOTER_TEXT_TOP
    d.text((PAD, y), name, font=f_name, fill=WHITE)
    d.text((W - PAD - f_right.getlength(right), y + 5), right, font=f_right, fill=GRAY)

    py = H - 16
    d.rectangle([0, py, W, H], fill=(22, 26, 33))
    seg = W / total
    d.rectangle([idx * seg, py, (idx + 1) * seg, H], fill=ACID)


def check(d, cx, cy, r, color=ACID):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=max(3, r // 7))
    w = max(3, int(r * 0.24))
    d.line([(cx - r * 0.44, cy + r * 0.02), (cx - r * 0.10, cy + r * 0.36)], fill=color, width=w)
    d.line([(cx - r * 0.10, cy + r * 0.36), (cx + r * 0.48, cy - r * 0.36)], fill=color, width=w)


def num_badge(d, cx, cy, r, n):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACID)
    f = F(int(r * 1.15), 900)
    tw = f.getlength(str(n))
    d.text((cx - tw / 2, cy - r * 0.72), str(n), font=f, fill=(16, 20, 14))


# ── 各版式 ──────────────────────────────────────────────────────────
def card_hook(c, idx, total):
    """封面：标题在上，大数字面板钉在页脚上方（这一张不需要自适应，本来就撑满）。"""
    img, d = canvas_pair()
    y = chip(d, PAD, c["kicker"])
    y += 70

    f = F(126, 900)
    lines = c["titleLines"]
    for i, line in enumerate(lines):
        d.text((PAD, y), line, font=f, fill=(ACID if i == len(lines) - 1 else WHITE))
        y += int(126 * 1.17)

    y += 18
    fsub = F(38, 400)
    for line in wrap(c["sub"], fsub, SAFE_W):
        d.text((PAD, y), line, font=fsub, fill=GRAY)
        y += 56

    st = c["stat"]
    bh = 430
    by1 = REGION_BOTTOM
    by0 = by1 - bh
    d.rounded_rectangle([PAD, by0, W - PAD, by1], radius=40, fill=CARD_BG,
                        outline=CARD_LINE, width=2)

    if c.get("badge"):
        fb = F(30, 700)
        bw = fb.getlength(c["badge"])
        bx1, by = W - PAD - 30, by0 + 30
        d.rounded_rectangle([bx1 - bw - 44, by, bx1, by + 62], radius=31,
                            outline=ACID, width=2)
        d.text((bx1 - bw - 22, by + 13), c["badge"], font=fb, fill=ACID)
        vy = by0 + 132
    else:
        vy = by0 + 118

    fv = fit_font(st["value"], SAFE_W - 140, 200, 96, 900)
    vw = fv.getlength(st["value"])
    d.text((PAD + (SAFE_W - vw) / 2, vy), st["value"], font=fv, fill=ACID)
    fl = F(36, 500)
    lw = fl.getlength(st["label"])
    d.text((PAD + (SAFE_W - lw) / 2, vy + fv.size + 42), st["label"], font=fl, fill=GRAY)

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


def card_pain(c, idx, total):
    """痛点：用三行"记录"示意剪贴板只留最后一次。"""
    img, d = canvas_pair()
    head = chip(d, PAD, c["kicker"])

    f_title = F(96, 900)
    title_h = int(96 * 1.2) * len(c["titleLines"])
    n_rows = len(c["rows"])
    note_lines = wrap(c["note"], F(38, 400), SAFE_W)
    note_h = len(note_lines) * 56

    top = head + GAP_AFTER_HEADER
    avail = REGION_BOTTOM - top
    # 行高动态：先扣掉标题、说明、行间基础间隔，余量给三行记录
    gap = 26
    base = title_h + note_h + 60 * 2 + gap * 2
    row_h = int(clamp((avail - base) / n_rows, 118, 200))

    heights = [title_h, row_h * n_rows + gap * (n_rows - 1), note_h]
    ys = distribute(heights, top, REGION_BOTTOM, gap=60)

    y = ys[0]
    for i, line in enumerate(c["titleLines"]):
        d.text((PAD, y), line, font=f_title,
               fill=(ACID if i == len(c["titleLines"]) - 1 else WHITE))
        y += int(96 * 1.2)

    y = ys[1]
    for i, r in enumerate(c["rows"]):
        live = i == 0
        d.rounded_rectangle([PAD, y, W - PAD, y + row_h], radius=28,
                            fill=(28, 36, 22) if live else (18, 21, 27),
                            outline=ACID if live else CARD_LINE, width=3 if live else 2)
        ft = F(44, 700 if live else 500)
        d.text((PAD + 40, y + (row_h - 44) / 2 - 6), r["text"], font=ft,
               fill=WHITE if live else DIM)
        fg = F(32, 700 if live else 400)
        d.text((W - PAD - 40 - fg.getlength(r["tag"]), y + (row_h - 32) / 2 - 4), r["tag"],
               font=fg, fill=ACID if live else (72, 79, 92))
        y += row_h + gap

    fn = F(38, 400)
    y = ys[2]
    for line in note_lines:
        d.text((PAD, y), line, font=fn, fill=GRAY)
        y += 56

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


def card_features(c, idx, total):
    """功能清单：行高随可用高度浮动，避免下方大片空洞。"""
    img, d = canvas_pair()
    head = chip(d, PAD, c["kicker"])

    f_title = F(84, 900)
    title_h = int(84 * 1.2)
    items = c["items"]
    n = len(items)

    top = head + GAP_AFTER_HEADER
    gap = 56
    # 条目少（≤3）时把字号提上去：条目少了靠"拉大行距"填不满，只会把空白挪到行内，
    # 卡片看着还是空。字号按最长那条自适应，避免放大后横向溢出安全区。
    r = 40 if n <= 3 else 34
    f_item = fit_font(max(items, key=len), SAFE_W - (r * 2 + 36), 66 if n <= 3 else 50, 38, 500)
    row_h = int(clamp((REGION_BOTTOM - top - title_h - gap * n) / n, 108, 280 if n <= 3 else 190))

    heights = [title_h] + [row_h] * n
    ys = distribute(heights, top, REGION_BOTTOM, gap=gap, gap_max_mult=4.0 if n <= 3 else 3.0)

    d.text((PAD, ys[0]), c["title"], font=f_title, fill=WHITE)
    for i, item in enumerate(items):
        y = ys[i + 1]
        cy = y + row_h / 2 - 8
        check(d, PAD + r, cy, r)
        d.text((PAD + r * 2 + 36, cy - int(f_item.size * 0.6)), item, font=f_item, fill=WHITE)

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


def card_facts(c, idx, total):
    """实测事实。默认 2×2 格子；**只剩 1~2 条时改单列整行** ——
    条数一少，2 列格子就撑不满，底部留白在视频里就是"没做完"。单列既能填满，
    又顺手把字号提上去（竖屏小字本来就是最难读的）。"""
    img, d = canvas_pair()
    head = chip(d, PAD, c["kicker"])

    f_title = F(84, 900)
    title_h = int(84 * 1.2)
    facts = c["facts"]
    gap = 26
    note_lines = wrap(c["note"], F(32, 400), SAFE_W)
    note_h = len(note_lines) * 48

    single = len(facts) <= 2
    cols = 1 if single else 2
    rows_n = (len(facts) + cols - 1) // cols
    cw = SAFE_W if single else (SAFE_W - gap) // 2

    top = head + GAP_AFTER_HEADER
    avail = REGION_BOTTOM - top
    tile_h = int(clamp((avail - title_h - note_h - gap * 2 - 70) / rows_n,
                       240, 560 if single else 420))

    heights = [title_h, tile_h * rows_n + gap * (rows_n - 1), note_h]
    ys = distribute(heights, top, REGION_BOTTOM, gap=70)

    d.text((PAD, ys[0]), c["title"], font=f_title, fill=WHITE)

    # 单列时整行居中（否则右侧空一大片）；双列时左对齐
    val_max = 150 if single else 76
    for i, fact in enumerate(facts):
        cx = PAD + (i % cols) * (cw + gap)
        cy = ys[1] + (i // cols) * (tile_h + gap)
        d.rounded_rectangle([cx, cy, cx + cw, cy + tile_h], radius=32,
                            fill=CARD_BG, outline=CARD_LINE, width=2)

        inner = cw - 128
        fv = fit_font(fact["value"], inner, val_max, 40, 900)
        fl = F(30, 400)
        lab_lines = wrap(fact["label"], fl, inner)

        block = fv.size + 22 + len(lab_lines) * 42
        ty = cy + (tile_h - block) / 2

        def put(text, fnt, y, color, _cx=cx, _cw=cw):
            x = _cx + (_cw - fnt.getlength(text)) / 2 if single else _cx + 64
            d.text((x, y), text, font=fnt, fill=color)

        put(fact["value"], fv, ty, ACID)
        ly = ty + fv.size + 22
        for line in lab_lines:
            put(line, fl, ly, GRAY)
            ly += 42

    fn = F(32, 400)
    y = ys[2]
    for line in note_lines:
        d.text((PAD, y), line, font=fn, fill=GRAY)
        y += 48

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


def card_steps(c, idx, total):
    """安装步骤：块高随可用高度浮动。"""
    img, d = canvas_pair()
    head = chip(d, PAD, c["kicker"])

    f_title = F(84, 900)
    title_h = int(84 * 1.2)
    fd = F(34, 400)

    steps = c["steps"]
    lines = [wrap(s["d"], fd, SAFE_W - 100) for s in steps]
    base_h = [62 + len(l) * 48 for l in lines]
    gap = 56

    top = head + GAP_AFTER_HEADER
    avail = REGION_BOTTOM - top
    slack = avail - title_h - sum(base_h) - gap * len(steps)
    # 上限放宽到 160：步骤少时原来的 104 会把空白全堆在最后一块下面，看着像没做完
    pad_each = int(clamp(slack / len(steps), 0, 160))
    heights = [title_h] + [h + pad_each for h in base_h]
    ys = distribute(heights, top, REGION_BOTTOM, gap=gap)

    d.text((PAD, ys[0]), c["title"], font=f_title, fill=WHITE)

    for i, step in enumerate(steps):
        y = ys[i + 1]
        num_badge(d, PAD + 34, y + 34, 34, i + 1)
        d.text((PAD + 100, y), step["t"], font=F(50, 700), fill=WHITE)
        dy = y + 66
        for line in lines[i]:
            d.text((PAD + 100, dy), line, font=fd, fill=GRAY)
            dy += 48

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


def card_cta(c, idx, total):
    """引导：账号名大牌 + 关键词。"""
    img, d = canvas_pair()
    head = chip(d, PAD, c["kicker"])

    f_title = F(88, 900)
    title_h = int(88 * 1.2) * len(c["titleLines"])

    fn = fit_font(c["account"], SAFE_W - 80, 104, 56, 900)
    name_h = fn.size + 110

    kw_label_h = 64
    kw_h = 132

    note_lines = wrap(c["note"], F(34, 400), SAFE_W)
    note_h = len(note_lines) * 48

    top = head + GAP_AFTER_HEADER
    heights = [title_h, name_h, kw_label_h + kw_h, note_h]
    ys = distribute(heights, top, REGION_BOTTOM, gap=64)

    y = ys[0]
    for i, line in enumerate(c["titleLines"]):
        d.text((PAD, y), line, font=f_title,
               fill=(ACID if i == len(c["titleLines"]) - 1 else WHITE))
        y += int(88 * 1.2)

    y = ys[1]
    d.rounded_rectangle([PAD, y, W - PAD, y + name_h], radius=40, fill=(28, 36, 22),
                        outline=ACID, width=3)
    aw = fn.getlength(c["account"])
    d.text((PAD + (SAFE_W - aw) / 2, y + 54), c["account"], font=fn, fill=ACID)

    y = ys[2]
    d.text((PAD, y), "后台回复关键词", font=F(38, 400), fill=GRAY)
    y += kw_label_h
    fkw = F(72, 900)
    kw_w = fkw.getlength(c["keyword"])
    d.rounded_rectangle([PAD, y, PAD + kw_w + 76, y + kw_h], radius=30,
                        fill=CARD_BG, outline=CARD_LINE, width=2)
    d.text((PAD + 38, y + 18), c["keyword"], font=fkw, fill=WHITE)

    y = ys[3]
    fn2 = F(34, 400)
    for line in note_lines:
        d.text((PAD, y), line, font=fn2, fill=GRAY)
        y += 48

    footer(d, c["account"], c["footerRight"], idx, total)
    return img


RENDERERS = {
    "hook": card_hook,
    "pain": card_pain,
    "features": card_features,
    "facts": card_facts,
    "steps": card_steps,
    "cta": card_cta,
}


def contact_sheet(paths, out_path, cols=3):
    th = 640
    tw = int(th * W / H)
    sheet = Image.new("RGB", (cols * tw + (cols + 1) * 16, 2 * th + 3 * 16), (8, 9, 12))
    for i, p in enumerate(paths):
        im = Image.open(p).resize((tw, th), Image.LANCZOS)
        sheet.paste(im, (16 + (i % cols) * (tw + 16), 16 + (i // cols) * (th + 16)))
    sheet.save(out_path)
    return out_path


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    spec_path, out_dir = sys.argv[1], sys.argv[2]
    spec = json.load(open(spec_path, encoding="utf-8"))
    os.makedirs(out_dir, exist_ok=True)

    cards = spec["cards"]
    total = len(cards)
    paths = []
    for i, c in enumerate(cards):
        render = RENDERERS.get(c["type"])
        if not render:
            raise SystemExit(f"未知版式: {c['type']}")
        c.setdefault("account", spec["account"])
        c.setdefault("footerRight", spec.get("footerRight", ""))
        img = render(c, i, total)
        p = os.path.join(out_dir, f"card-{i + 1:02d}.png")
        img.save(p)
        paths.append(p)
        print(f"  ✅ {os.path.basename(p)}  {c['type']:<9} {img.size[0]}×{img.size[1]}")

    sheet = contact_sheet(paths, os.path.join(out_dir, "_总览.png"))
    print(f"  ✅ {os.path.basename(sheet)}  （6 张总览，验收用）")
    print(f"\n产出目录：{out_dir}")


if __name__ == "__main__":
    main()
