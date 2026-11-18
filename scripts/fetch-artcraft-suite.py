#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
下载 ArtCraft 全家桶的**官方**安装包（每个应用只取 Windows x64 + macOS）。

设计要点（对应项目既往踩过的坑）：
  · 来源只认 GitHub Release 官方 assets，**不用任何第三方打包**；
  · 每个文件用 *官方 digest*（release API 里的 sha256）校验，不匹配就报错；
  · 续传只用 `curl -C -`（⚠️ 绝不叠加显式 `-r` —— 那是追加语义，会把文件撑坏）；
  · 落盘在 `out/`（已被 .gitignore 忽略，3GB 不会进仓库）；
  · 顺带把各仓库的 LICENSE 拉下来（Apache-2.0 分发时**必须**随附）。
"""
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = "/Users/noonebook/WorkBuddy/百度网盘mcp"
DEST = os.path.join(ROOT, "out", "artcraft-suite")
REPOS = [
    "artcraft", "photocraft", "pdfcraft", "lightcraft", "wordcraft", "vectorcraft",
    "effectcraft", "cadcraft", "designcraft", "deckcraft", "soundcraft", "figcraft",
    "craft-launcher",
]
CONC = int(os.environ.get("CONC", "2"))
TIMEOUT = 2700
# ⚠️ 实测（2026-10-15）：GitHub 直连对**并发**惩罚极重 ——
#    4 并发总共只有 460 KB/s，而**单线程**直连有 3.9 MB/s、走 gh-proxy 有 6.9 MB/s。
#    → 所以这里默认「低并发 + 镜像」，切勿再调高 CONC。
MIRROR = os.environ.get("MIRROR", "https://gh-proxy.com/")


def with_mirror(u):
    """把 github 系域名套上镜像前缀（已经是镜像地址的不重复加）。"""
    if not MIRROR or u.startswith(MIRROR):
        return u
    if "github.com" in u or "githubusercontent.com" in u:
        return MIRROR + u
    return u


def sh(args, timeout=120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def sha256(path, buf=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(buf), b""):
            h.update(chunk)
    return h.hexdigest()


def api(url):
    for _ in range(3):
        try:
            r = sh(["curl", "-sL", "--max-time", "30", url], timeout=60)
            return json.loads(r.stdout)
        except Exception:
            time.sleep(2)
    return {}


def wanted(name):
    """只要 Windows x64 与 macOS 的包；Linux/32位/ARM/CLI/Web 全部排除。"""
    n = name.lower()
    if n == "sha256sums.txt":
        return True
    if any(k in n for k in ("linux", "freebsd", "riscv", "aarch64", ".zsync",
                            "-web-", "-cli-", "-server-")):
        return False
    if "arm64" in n:
        return False
    if "-x86." in n or "x86-portable" in n:          # 32 位
        return False
    return (
        n.endswith("windows-x64.msi")
        or n.endswith("windows-x64-portable.zip")
        or n.endswith("macos-universal.dmg")
        or n.endswith("_universal.dmg")                # artcraft 的命名
        or n.endswith("x64-setup.exe")                 # artcraft
        or n.endswith("x64_en-us.msi")                 # artcraft
    )


def download(url, path, expect_sha, label):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and expect_sha:
        try:
            if sha256(path) == expect_sha:
                return {"label": label, "status": "skip", "bytes": os.path.getsize(path)}
        except Exception:
            pass
    args = ["curl", "-L", "-C", "-", "--retry", "3", "--retry-delay", "3",
            "--max-time", str(TIMEOUT), "-s", "-o", path, with_mirror(url)]
    try:
        sh(args, timeout=TIMEOUT + 180)
    except Exception as e:
        return {"label": label, "status": "fail", "err": str(e)[:80]}
    if not os.path.exists(path):
        return {"label": label, "status": "fail", "err": "文件未生成"}
    size = os.path.getsize(path)
    if expect_sha:
        got = sha256(path)
        if got != expect_sha:
            return {"label": label, "status": "SHA-不匹配", "got": got[:16],
                    "want": expect_sha[:16], "bytes": size}
    return {"label": label, "status": "ok", "bytes": size}


def main():
    os.makedirs(DEST, exist_ok=True)
    jobs, manifest = [], []

    print("=== 拉取各仓库最新 release 的官方信息 ===", flush=True)
    for repo in REPOS:
        d = api(f"https://api.github.com/repos/storytold/{repo}/releases/latest")
        tag = d.get("tag_name")
        if not tag:
            print(f"  ⚠️ {repo}: 拿不到 release", flush=True)
            continue
        picked = []
        for a in d.get("assets") or []:
            if not wanted(a["name"]):
                continue
            picked.append(a["name"])
            jobs.append({
                "repo": repo, "tag": tag, "name": a["name"],
                "url": a["browser_download_url"],
                "sha": (a.get("digest") or "").replace("sha256:", ""),
                "size": a.get("size", 0),
                "dir": os.path.join(DEST, repo),
            })
        # LICENSE（Apache-2.0 分发时必须随附）
        for fn in ("LICENSE", "LICENSE.txt"):
            jobs.append({
                "repo": repo, "tag": tag, "name": fn,
                "url": f"https://raw.githubusercontent.com/storytold/{repo}/main/{fn}",
                "sha": "", "size": 0, "dir": os.path.join(DEST, repo), "optional": True,
            })
            break
        mb = sum(j["size"] for j in jobs if j["repo"] == repo) / 1048576
        print(f"  {repo:<14} {tag:<20} {len(picked):>2} 个包 / {mb:6.1f} MB", flush=True)
        time.sleep(0.25)

    total_mb = sum(j["size"] for j in jobs) / 1048576
    print(f"\n=== 共 {len(jobs)} 个文件 / 约 {total_mb:.0f} MB，开始下载（并发 {CONC}）===", flush=True)

    done_n = 0
    results = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=CONC) as ex:
        futs = {}
        for j in jobs:
            path = os.path.join(j["dir"], j["name"])
            futs[ex.submit(download, j["url"], path, j["sha"], f'{j["repo"]}/{j["name"]}')] = j
        for fut in as_completed(futs):
            j = futs[fut]
            try:
                r = fut.result()
            except Exception as e:
                r = {"label": f'{j["repo"]}/{j["name"]}', "status": "fail", "err": str(e)[:80]}
            done_n += 1
            results.append({**j, **r})
            flag = {"ok": "✅", "skip": "✅(已存在)", "fail": "❌"}.get(r["status"], "⚠️")
            mb = r.get("bytes", 0) / 1048576
            print(f'  [{done_n:>3}/{len(jobs)}] {flag} {r["label"]:<52} {mb:6.1f} MB '
                  f'{"" if r["status"] in ("ok","skip") else r}', flush=True)

    # 写清单
    ok = [r for r in results if r["status"] in ("ok", "skip")]
    bad = [r for r in results if r["status"] not in ("ok", "skip")]
    man = {
        "source": "github.com/storytold/* releases",
        "license": "Apache-2.0",
        "policy": "只取 Windows x64 与 macOS 官方安装包；不含 Linux/32位/ARM",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "files": [
            {"repo": r["repo"], "tag": r["tag"], "name": r["name"],
             "url": r["url"], "sha256": r.get("sha") or "",
             "bytes": r.get("bytes", 0), "status": r["status"]}
            for r in sorted(results, key=lambda x: (x["repo"], x["name"]))
        ],
    }
    with open(os.path.join(DEST, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=2)

    took = (time.time() - t0) / 60
    print(f"\n=== 完成：成功 {len(ok)} / 失败 {len(bad)}，用时 {took:.1f} 分钟 ===", flush=True)
    if bad:
        for r in bad:
            print(f'  ❌ {r["label"]}  {r}', flush=True)
    print(f"目录：{DEST}", flush=True)


if __name__ == "__main__":
    main()
