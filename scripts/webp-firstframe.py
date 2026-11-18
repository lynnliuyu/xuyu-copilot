#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从**动态 WebP** 里抽出指定帧，重组成静态 WebP / PNG。

为什么需要它
------------
GitHub README 上的官方演示图（`github.com/user-attachments/assets/...`）多半是
**动态 WebP**。它有两个坑：
  1. 本机 Pillow 只有静态 webp 解码能力，读动画文件会抛
     `OSError: could not create decoder object`（构建时缺 WebPAnimDecoder）；
  2. 无头 Chrome 在 `--disable-gpu` 下渲染不出这种图 —— 出图会是**一片空白**
     （2026-10-16 真实踩过：ArtCraft 商品图的截图区全黑）。
  3. 它的**第 0 帧常常是黑的**（动画有淡入），所以不能只取首帧。

办法：直接解析 RIFF 容器，把第 N 个 `ANMF` 帧里的 `ALPH`/`VP8 `/`VP8L` 子块
提升为顶层块，重组成一个**静态** WebP。Pillow 就能正常读，Chrome 也能正常显示。

用法：
  python3 scripts/webp-firstframe.py 输入.webp -o 输出.png --frame 20
  python3 scripts/webp-firstframe.py 输入.webp -o outdir/ --frame 20 --list
"""
import argparse
import os
import struct
import sys


def chunks(buf, start, end):
    """遍历 RIFF 子块，yield (fourcc, payload_offset, payload_size)。"""
    p = start
    while p + 8 <= end:
        fourcc = buf[p:p + 4]
        size = struct.unpack_from('<I', buf, p + 4)[0]
        yield fourcc, p + 8, size
        p += 8 + size + (size & 1)  # 块按偶数字节对齐


def frames(buf):
    """列出所有动画帧：(x, y, w, h, duration, [子块...])。"""
    out = []
    if len(buf) < 12 or buf[:4] != b'RIFF' or buf[8:12] != b'WEBP':
        raise SystemExit('不是 RIFF/WEBP 文件')
    riff_end = 8 + struct.unpack_from('<I', buf, 4)[0]
    for fourcc, off, size in chunks(buf, 12, min(riff_end, len(buf))):
        if fourcc != b'ANMF':
            continue
        x = int.from_bytes(buf[off:off + 3], 'little') * 2
        y = int.from_bytes(buf[off + 3:off + 6], 'little') * 2
        w = int.from_bytes(buf[off + 6:off + 9], 'little') + 1
        h = int.from_bytes(buf[off + 9:off + 12], 'little') + 1
        dur = int.from_bytes(buf[off + 12:off + 15], 'little')
        subs = []
        for fcc, soff, ssz in chunks(buf, off + 16, off + size):
            subs.append((fcc, buf[soff:soff + ssz]))
        out.append((x, y, w, h, dur, subs))
    return out


def build_still(fr):
    """把一帧的子块拼成一个静态 WebP（无 VP8X，Pillow/Chrome 都能读）。"""
    _, _, _, _, _, subs = fr
    body = b''
    for fcc, payload in subs:
        if fcc not in (b'ALPH', b'VP8 ', b'VP8L'):
            continue
        body += fcc + struct.pack('<I', len(payload)) + payload
        if len(payload) & 1:
            body += b'\x00'
    if not body:
        raise SystemExit('该帧里没有 VP8/VP8L 图像数据')
    # ⚠️ 必须补回 RIFF 头，否则 Pillow/Chrome 都不认（写成 WEBP+块 是不够的）
    riff = b'WEBP' + body
    return b'RIFF' + struct.pack('<I', len(riff)) + riff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('-o', '--out', required=True, help='输出文件；给目录则按 PNG 存')
    ap.add_argument('--frame', type=int, default=0, help='取第几帧（默认 0；动画首帧常是黑的，建议试 10~40）')
    ap.add_argument('--list', action='store_true', help='只打印帧信息')
    ap.add_argument('--survey', type=int, default=0, help='每隔 N 帧导出一张预览，用于挑帧')
    a = ap.parse_args()

    buf = open(a.src, 'rb').read()
    fr = frames(buf)
    if not fr:
        raise SystemExit('这不是动态 WebP（没有 ANMF 帧）—— 直接当静态图用即可')
    print(f'共 {len(fr)} 帧，画布帧尺寸示例 {fr[0][2]}x{fr[0][3]}')
    if a.list:
        for i, f in enumerate(fr[:40]):
            print(f'  #{i:<4} {f[2]}x{f[3]}  {f[4]}ms  子块={[s[0].decode() for s in f[5]]}')
        return

    from PIL import Image
    import io

    def frame_png(i):
        still = build_still(fr[i])
        im = Image.open(io.BytesIO(still))
        # ⚠️ 不要调 im.load()：某些帧 Pillow 会误走「取下一帧」分支报
        #    `failed to read next frame`。convert('RGB') 本身就完成解码。
        return im.convert('RGB')

    if a.survey:
        os.makedirs(a.out, exist_ok=True)
        idx = list(range(0, len(fr), a.survey))[:40]
        for i in idx:
            im = frame_png(i)
            p = os.path.join(a.out, f'frame-{i:03d}.png')
            im.save(p)
            print(f'  #{i:<4} {im.size}  -> {p}')
        return

    i = max(0, min(a.frame, len(fr) - 1))
    im = frame_png(i)
    out = a.out
    if os.path.isdir(out) or out.endswith(os.sep):
        os.makedirs(out, exist_ok=True)
        out = os.path.join(out, f'frame-{i:03d}.png')
    im.save(out)
    print(f'取第 {i} 帧 → {out}  {im.size}')


if __name__ == '__main__':
    main()
