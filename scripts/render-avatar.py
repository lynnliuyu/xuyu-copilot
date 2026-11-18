#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
渲染公众号头像候选（繁梦开源小仓库 / 繁星软件安装管家 均可用）。

── 三条硬约束（都来自微信的真实显示方式，不是审美问题）
1. **圆形安全区**：公众号头像在会话列表、资料页**按圆形显示** → 核心图形必须落在
   内切圆里。做成方形铺满 + 图形居中内缩，这样"按圆显示"和"按圆角方形显示"都不会切到内容。
   经验值：图形外接椭圆的半径 ≤ 0.46 × 边长。
2. **40px 可辨**：手机信息流里头像只有 ~40px 高。七个字必糊，所以**只放一个字或一个图形**。
   单字边长取 0.57 × 边长 —— 大字径是小尺寸下唯一能救命的杠杆。
3. **深底铺满**：白底头像在微信里一排都是浅色，深底天然跳出来；而且是同一套封面视觉。

── 用法
  python3 scripts/render-avatar.py                     # 出全部候选
  python3 scripts/render-avatar.py --only 01           # 只出某一个

产物：out/mp/avatar/
  01-仓字标.png / 02-星字标.png / 03-开箱图形.png   （各 300 + 600 两档）
  _对照.png        三候选并排，含「圆形裁切」与「40px 实际大小」两行预览
"""
import os
import sys
import math

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_VF = os.path.join(ROOT, '.cache', 'fonts', 'NotoSansSC-VF.ttf')
OUT_DIR = os.path.join(ROOT, 'out', 'mp', 'avatar')

# 与封面模板同一套视觉
BG = (14, 17, 22)        # #0E1116 近黑
ACID = (200, 255, 61)    # #C8FF3D 酸绿
DIM = (60, 66, 78)       # 暗部（图形内部的次要笔画）

SIZES = (300, 600)       # 300 是微信建议档，600 供以后换地方用
SAFE_R = 0.46            # 内切圆安全半径系数（相对边长）


def font(size, weight=900):
    f = ImageFont.truetype(FONT_VF, size)
    try:
        f.set_variation_by_axes([weight])   # 可变字重：900 = Heavy
    except Exception:
        pass
    return f


def base_canvas(S):
    """近黑铺满 + 中心极淡酸绿辉光（给纯色底一点纵深，别做成死板色块）"""
    img = Image.new('RGB', (S, S), BG)

    glow_r = int(S * 0.62)
    m = Image.new('L', (S, S), 0)
    # 辉光刻意压到极淡：头像在 40px 下只剩十几个像素可用，
    # 任何装饰都在抢对比度。这里只为避免"死平色块"，不是为了好看。
    ImageDraw.Draw(m).ellipse(
        [S / 2 - glow_r, S / 2 - glow_r, S / 2 + glow_r, S / 2 + glow_r], fill=26)
    m = m.filter(ImageFilter.GaussianBlur(glow_r * 0.55))
    img.paste(Image.new('RGB', (S, S), ACID), (0, 0), m)
    return img


def mark_glyph(spec, S):
    """单字标：一个汉字，居中。返回 (图层, 墨迹 bbox)"""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 0.57 × 边长 —— 在内切圆里放得下的上限附近，小尺寸下最清晰
    f = font(int(S * 0.57), weight=spec.get('weight', 900))
    ch = spec['char']

    l, t, r, bo = d.textbbox((0, 0), ch, font=f)
    d.text(((S - (r - l)) / 2 - l, (S - (bo - t)) / 2 - t), ch,
           font=f, fill=spec.get('color', ACID) + (255,))
    return img, (l + (S - (r - l)) / 2 - l, t + (S - (bo - t)) / 2 - t,
                 r + (S - (r - l)) / 2 - l, bo + (S - (bo - t)) / 2 - t)


def mark_box(spec, S):
    """箱子图形：圆角方 + 箱盖横线 + 封口竖线。识别度靠"方＋十字分割"这个老符号。"""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    side = S * 0.42
    x0, y0 = (S - side) / 2, (S - side) / 2
    x1, y1 = x0 + side, y0 + side
    w = max(2, int(S * 0.036))          # 笔画宽：40px 下约 1.5px，是能看清的下限
    lid = y0 + side * 0.32              # 箱盖线位置

    d.rounded_rectangle([x0, y0, x1, y1], radius=side * 0.16, outline=ACID + (255,), width=w)
    d.line([x0, lid, x1, lid], fill=ACID + (255,), width=w)
    # 封口：从顶边到箱盖线的短竖线（偏左，比居中更像"封条压住的一角"）
    tx = x0 + side * 0.30
    d.line([tx, y0, tx, lid], fill=ACID + (255,), width=w)
    # 内部左侧再加一笔暗色，避免大字号下图形显得空
    d.rounded_rectangle([x0 + side * 0.14, lid + side * 0.14, x1 - side * 0.14, y1 - side * 0.12],
                        radius=side * 0.08, outline=DIM + (255,), width=max(1, int(w * 0.6)))

    return img, (x0 - w, y0 - w, x1 + w, y1 + w)


def mark_crate(spec, S):
    """开箱/下载托架：上方向下的箭头 + 底部托盘。语义直白，40px 也认得出。"""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    w = max(2, int(S * 0.042))
    cx = S / 2
    top = S * 0.28
    bot = S * 0.60

    d.line([cx, top, cx, bot], fill=ACID + (255,), width=w)                     # 箭杆
    aw = S * 0.075
    d.line([cx - aw, bot - aw * 1.35, cx, bot], fill=ACID + (255,), width=w)    # 左翼
    d.line([cx + aw, bot - aw * 1.35, cx, bot], fill=ACID + (255,), width=w)    # 右翼

    ty = S * 0.68          # 托盘
    tw = S * 0.16
    d.line([cx - tw, ty, cx - tw, ty + w * 0.9], fill=ACID + (255,), width=w)
    d.line([cx + tw, ty, cx + tw, ty + w * 0.9], fill=ACID + (255,), width=w)
    d.line([cx - tw, ty + w * 0.45, cx + tw, ty + w * 0.45], fill=ACID + (255,), width=w)

    return img, (cx - tw - w, top - w, cx + tw + w, ty + w * 1.9)


CANDIDATES = [
    {'id': '01', 'name': '仓字标', 'fn': mark_glyph, 'char': '仓',
     'use': '名字里带「仓库」时最贴。单字最好认，40px 下依然清楚'},
    {'id': '02', 'name': '星字标', 'fn': mark_glyph, 'char': '星',
     'use': '若保留「繁星」前缀就用这个；和封面那套酸绿同一视觉'},
    {'id': '03', 'name': '箱子图形', 'fn': mark_box,
     'use': '不带字，与名字无关 —— 万一以后还要改名，不用重新做头像'},
    {'id': '04', 'name': '下载托架', 'fn': mark_crate,
     'use': '「给下载」这件事最直白；图形语义强，但不如单字有身份感'},
]


def render(spec, S):
    c = base_canvas(S)
    mark, bbox = spec['fn'](spec, S)
    c = c.convert('RGBA')
    c.alpha_composite(mark)
    return c.convert('RGB'), bbox


def check(spec, S, bbox):
    """程序化验收：我这边看不了图，所以把"能不能用"写成断言。"""
    cx = cy = S / 2
    l, t, r, b = bbox
    # ① 安全区：墨迹四角到中心的距离都要 ≤ 内切圆安全半径
    corners = [(l, t), (r, t), (l, b), (r, b)]
    far = max(math.hypot(x - cx, y - cy) for x, y in corners)
    safe = S * SAFE_R
    ok_circle = far <= safe
    # ② 墨迹占比：太大顶到边、太小在 40px 下消失
    area_ratio = ((r - l) * (b - t)) / (S * S)
    # ③ 40px 实测：缩下去后前景像素还占多少
    small, _ = render(spec, 40)
    base = base_canvas(S).resize((40, 40), Image.LANCZOS)
    px, pb = small.load(), base.load()

    def lum(c):
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

    # ⚠️ 判据必须是「与**同一位置**的底色之差」。踩过两次：
    #    ① 按颜色阈值 → 细线条被抗锯齿摊成中间色，误报 0%；
    #    ② 与纯背景色比 → 底色上那层辉光全被算成前景，误报 100%。
    #    只有跟"没有图形的同一张底"逐像素比，才是真正的墨迹。
    deltas = [abs(lum(px[x, y]) - lum(pb[x, y])) for y in range(40) for x in range(40)]
    fg = sum(1 for d in deltas if d > 18)
    peak = sorted(deltas)[-1] if deltas else 0
    return {
        'small_peak': peak,
        'circle_ok': ok_circle, 'far': far, 'safe': safe,
        'area': area_ratio, 'small_fg': fg / (40 * 40),
        'margins': (l / S, t / S, 1 - r / S, 1 - b / S),
    }


def contact_sheet(rendered):
    """并排对照：上行原图（外加圆形裁切预览），下行缩到 40px 的"真实大小"。"""
    cell, gap, pad = 300, 26, 34
    cols = len(rendered)
    W = pad * 2 + cols * cell + (cols - 1) * gap
    H = pad * 2 + cell + 40 + 96 + 34
    sheet = Image.new('RGB', (W, H), (8, 10, 13))
    d = ImageDraw.Draw(sheet)

    f_lab = font(22, 700)
    f_s = font(17, 400)

    for i, (spec, img, _) in enumerate(rendered):
        x = pad + i * (cell + gap)

        # 上行左：原图；右：圆形裁切（微信实际显示形态）
        half = (cell - 18) // 2
        sheet.paste(img.resize((half, half), Image.LANCZOS), (x, pad))
        circ = Image.new('RGB', (half, half), (8, 10, 13))
        m = Image.new('L', (half, half), 0)
        ImageDraw.Draw(m).ellipse([0, 0, half - 1, half - 1], fill=255)
        circ.paste(img.resize((half, half), Image.LANCZOS), (0, 0), m)
        sheet.paste(circ, (x + half + 18, pad))

        ty = pad + half + 16
        d.text((x, ty), f"{spec['id']} {spec['name']}", font=f_lab, fill=(255, 255, 255))
        d.text((x, ty + 30), spec['use'], font=f_s, fill=(150, 158, 172))

        # 下行：40px 真实大小
        sy = H - pad - 56
        d.text((x, sy - 26), '信息流里的真实大小（40px）', font=f_s, fill=(110, 118, 132))
        s40 = img.resize((40, 40), Image.LANCZOS)
        m40 = Image.new('L', (40, 40), 0)
        ImageDraw.Draw(m40).ellipse([0, 0, 39, 39], fill=255)
        c40 = Image.new('RGB', (40, 40), (240, 240, 240))
        c40.paste(s40, (0, 0), m40)
        sheet.paste(c40, (x, sy))

    return sheet


def main():
    only = []
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1].split(',')

    os.makedirs(OUT_DIR, exist_ok=True)
    rendered = []

    print('')
    print('══════ 公众号头像候选 ══════')
    print(f'  字体 {os.path.relpath(FONT_VF, ROOT)}（Noto Sans SC 可变字重 / SIL OFL）')
    print('')

    for spec in CANDIDATES:
        if only and spec['id'] not in only:
            continue
        img, bbox = render(spec, SIZES[0])
        for S in SIZES:
            im, _ = render(spec, S)
            suffix = '' if S == SIZES[0] else f'-{S}'
            im.save(os.path.join(OUT_DIR, f"{spec['id']}-{spec['name']}{suffix}.png"))

        chk = check(spec, SIZES[0], bbox)
        bad = []
        if not chk['circle_ok']:
            bad.append('超出圆形安全区')
        if chk['small_fg'] < 0.022:
            bad.append('40px 下笔画偏细')
        verdict = '✅' if not bad else '⚠️ ' + '、'.join(bad)
        print(f"  {spec['id']} {spec['name']:<6} "
              f"圆形安全区 {'✅' if chk['circle_ok'] else '❌'}"
              f"（外接 {chk['far']:.0f}px ≤ {chk['safe']:.0f}px）　"
              f"墨迹占比 {chk['area'] * 100:.1f}%　"
              f"40px 前景 {chk['small_fg'] * 100:.1f}%　{verdict}")
        rendered.append((spec, img, chk))

    if rendered:
        sheet = contact_sheet(rendered)
        p = os.path.join(OUT_DIR, '_对照.png')
        sheet.save(p)
        print('')
        print(f'  对照图：{os.path.relpath(p, ROOT)}')
        print(f'  单图：{os.path.relpath(OUT_DIR, ROOT)}/<编号>-<名称>.png（300 与 600 两档）')
    print('')


if __name__ == '__main__':
    main()
