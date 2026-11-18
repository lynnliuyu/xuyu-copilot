#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
视频抽帧回比验收（不需要肉眼看）

每张卡在成片里的中点位置抽一帧，然后跟 6 张原卡做相似度比对：
  ① 该帧必须最像"它自己那张卡"（防串位 / 防丢段）
  ② 该帧必须有内容（防抽到黑场或转场空档）

用法：python3 scripts/verify-video-frames.py <mp4> [卡片目录] [spec.json]
退出码：0 全过；1 有问题
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.environ.get("FFMPEG") or os.path.join(
    os.path.expanduser("~"),
    ".workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg")
XFADE = 0.6
SIG = (54, 96)          # 比对用的低分辨率指纹


def extract(mp4, t, out):
    subprocess.run(
        [FFMPEG, "-y", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1", out],
        check=True, capture_output=True)


def signature(path):
    """转成低分辨率灰度指纹（用 tobytes 而不是 getdata，快且不触发弃用警告）"""
    im = Image.open(path).convert("L").resize(SIG, Image.LANCZOS)
    return im.tobytes()


def mad(a, b):
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    mp4 = sys.argv[1]
    cards_dir = sys.argv[2] if len(sys.argv) > 2 else "out/video-maccy/cards"
    spec_path = sys.argv[3] if len(sys.argv) > 3 else "assets/video-specs/maccy.json"

    spec = json.load(open(spec_path, encoding="utf-8"))
    cards = spec["cards"]
    n = len(cards)

    card_files = sorted(
        f for f in os.listdir(cards_dir)
        if f.startswith("card-") and f.endswith(".png"))
    card_sigs = [signature(os.path.join(cards_dir, f)) for f in card_files]

    # 每段在成片里的起点：前 i 段累计时长 − i×交叉溶解
    starts, cum = [], 0.0
    for i, c in enumerate(cards):
        starts.append(cum - i * XFADE)
        cum += float(c.get("dur", 5))

    problems, rows = [], []
    with tempfile.TemporaryDirectory() as td:
        for i, c in enumerate(cards):
            t = starts[i] + float(c.get("dur", 5)) / 2
            p = os.path.join(td, f"f{i}.png")
            extract(mp4, t, p)

            stat = ImageStat.Stat(Image.open(p).convert("L"))
            stddev = stat.stddev[0]

            sig = signature(p)
            dists = [mad(sig, cs) for cs in card_sigs]
            best = dists.index(min(dists))
            rows.append((i + 1, c["type"], t, best + 1, min(dists), stddev))

            if stddev < 10:
                problems.append(f"第 {i + 1} 段（t={t:.1f}s）画面近乎纯色，可能是黑场/空档")
            if best != i:
                problems.append(
                    f"第 {i + 1} 段（t={t:.1f}s）最像第 {best + 1} 张卡（{card_files[best]}），疑似串位")

    print(f"{'段':<4}{'版式':<10}{'抽帧时刻':>9}{'最像第N张':>10}{'差异':>8}{'对比度':>8}")
    print("-" * 52)
    for i, t_, tt, best, d, sd in rows:
        print(f"{i:<4}{t_:<10}{tt:>8.2f}s{best:>9}{d:>9.1f}{sd:>8.1f}")

    print()
    if problems:
        print("❌ 抽帧验收有问题：")
        for p in problems:
            print("   -", p)
        return 1
    print(f"✅ 抽帧验收通过：{n} 段全部对号入座，无黑场")
    return 0


if __name__ == "__main__":
    sys.exit(main())
