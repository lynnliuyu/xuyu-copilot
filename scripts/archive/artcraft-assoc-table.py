#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成「ArtCraft · 卡密仓库关联对照表」。

为什么需要：闲管家「卡密仓库 → 发货 → 关联商品」这一步**官方无 API**（46 个接口里
没有「把卡种/货源挂到具体闲鱼商品」的端点），只能在后台手工把「闲鱼商品」和「卡种」配对。
这份表就是照着配的清单 —— 卡种名与闲鱼商品标题**同名**，按名字选即可。

数据来源（都是本地真值）：
  out/artcraft-kami-kinds.json                 本脚本创建的卡种（kind_id / 库存）
  drafts/.listings.json                        上架台账（state / product_id / item_id）
  drafts/.resources.json                       资源条目（网盘分享链接 + 提取码）
  packages/xgj-gateway/data/catalog.json       网关货源商品（另一条发货链路的编号）
"""
import json
import os
import html
import time

ROOT = "/Users/noonebook/WorkBuddy/百度网盘mcp"
OUT = os.path.join(ROOT, "out", "artcraft-关联对照表.html")

CODES = [
    "BD-ARTCRAFT", "BD-PHOTOCRAFT", "BD-PDFCRAFT", "BD-LIGHTCRAFT", "BD-WORDCRAFT",
    "BD-VECTORCRAFT", "BD-EFFECTCRAFT", "BD-CADCRAFT", "BD-DESIGNCRAFT", "BD-DECKCRAFT",
    "BD-SOUNDCRAFT", "BD-FIGCRAFT", "BD-CRAFT-LAUNCHER", "BD-ARTCRAFT-FULLSET",
]

STATE_LABEL = {
    "on_sale": ("在售", "#0a7d32", "#e7f7ec"),
    "pending_review": ("上架处理中", "#8a6d00", "#fff8e1"),
    "draft": ("草稿", "#6b7280", "#f1f2f4"),
    "down_shelved": ("已下架", "#a33", "#fdeaea"),
    "unknown": ("未知", "#6b7280", "#f1f2f4"),
}


def load(p, dft=None):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return dft if dft is not None else {}


def main():
    res = load(os.path.join(ROOT, "drafts/.resources.json"))
    lst = load(os.path.join(ROOT, "drafts/.listings.json"))
    kami = load(os.path.join(ROOT, "out/artcraft-kami-kinds.json"))

    rows = []
    for c in CODES:
        rid = c[3:].lower()
        r = res.get(rid) or {}
        d = lst.get(c) or {}
        k = kami.get(c) or {}
        st, fg, bg = STATE_LABEL.get(d.get("state", ""), STATE_LABEL["unknown"])
        name = str(r.get("display_name") or k.get("name") or c).replace(
            "ArtCraft AI创作工作台", "ArtCraft 开源创作工作台")
        b = r.get("baidu") or {}
        rows.append({
            "code": c,
            "title": d.get("title") or name,
            "kind_name": k.get("name") or name,
            "kind_id": k.get("kind_id", ""),
            "stock": k.get("stock", 0),
            "state": st, "fg": fg, "bg": bg,
            "url": b.get("share_url", ""),
            "pwd": b.get("pwd", ""),
            "item_id": d.get("item_id", ""),
        })

    on_sale = sum(1 for r in rows if r["state"] == "在售")
    kinds_ok = sum(1 for r in rows if r["kind_id"])
    e = html.escape
    tr = []
    for r in rows:
        pwd = f'　提取码 <code>{e(str(r["pwd"]))}</code>' if r["pwd"] else ""
        link = (f'<a href="{e(r["url"])}" target="_blank" rel="noopener">打开分享页</a>' if r["url"]
                else '<span class="muted">—</span>')
        kid = f'<code>{e(str(r["kind_id"]))}</code>' if r["kind_id"] else '<span class="warn">未建</span>'
        stk = f'{r["stock"]}' if r["kind_id"] else '<span class="warn">—</span>'
        tr.append(f"""      <tr>
        <td class="t">{e(r['title'])}</td>
        <td class="t">{e(r['kind_name'])}</td>
        <td class="mono">{kid}</td>
        <td class="num">{stk}</td>
        <td class="ctr"><span class="pill" style="color:{r['fg']};background:{r['bg']}">{r['state']}</span></td>
        <td class="link">{link}{pwd}</td>
      </tr>""")

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ArtCraft · 卡密仓库关联对照表</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:28px 22px 60px; background:#f6f7f9; color:#1c1f23;
         font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }}
  h1 {{ font-size:20px; margin:0 0 6px; }}
  .sub {{ color:#5b6470; font-size:13px; margin-bottom:18px; }}
  .card {{ background:#fff; border:1px solid #e3e6ea; border-radius:12px; overflow:hidden;
           box-shadow:0 1px 3px rgba(0,0,0,.04); }}
  table {{ width:100%; border-collapse:collapse; }}
  th, td {{ padding:9px 12px; border-bottom:1px solid #eef0f3; text-align:left; vertical-align:top; }}
  th {{ background:#fafbfc; font-weight:600; font-size:12.5px; color:#5b6470; white-space:nowrap; }}
  tr:last-child td {{ border-bottom:none; }}
  .mono {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; white-space:nowrap; }}
  .t {{ min-width:200px; }}
  .num {{ white-space:nowrap; font-variant-numeric: tabular-nums; }}
  .ctr {{ text-align:center; white-space:nowrap; }}
  .link {{ font-size:12.5px; white-space:nowrap; }}
  code {{ background:#f1f2f4; padding:1px 5px; border-radius:4px; font-size:12px; }}
  .pill {{ display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; }}
  .muted {{ color:#9aa3ad; }} .warn {{ color:#b45309; }}
  .note {{ margin-top:16px; padding:12px 14px; background:#fffbeb; border:1px solid #fde68a;
           border-radius:10px; font-size:13px; }}
  .note b {{ color:#92400e; }}
  .ok {{ background:#e7f7ec; border-color:#bfe6cb; }}
  .ok b {{ color:#0a7d32; }}
</style></head><body>
<h1>ArtCraft · 卡密仓库关联对照表</h1>
<div class="sub">共 {len(rows)} 条 · 已在售 {on_sale} 条 · 卡种已建 {kinds_ok}/{len(rows)} · 生成于 {time.strftime('%Y-%m-%d %H:%M:%S')}</div>
<div class="card"><table>
  <thead><tr><th>闲鱼商品标题（在管家按此匹配）</th><th>卡种名称</th><th>卡种 ID</th><th>卡密库存</th><th>上架</th><th>卡密内容（买家拿到）</th></tr></thead>
  <tbody>
{chr(10).join(tr)}
  </tbody>
</table></div>
<div class="note ok">
  <b>怎么用：</b>闲管家后台 →「卡密仓库」→ 发货 → <b>关联商品</b>：先选到刚上架的闲鱼商品，
  再在「卡种」下拉里选<b>同名</b>的那一个（卡种名与商品标题一致，见上表前两列）。
</div>
<div class="note">
  <b>为什么必须做：</b>这一步官方 **46 个接口里没有对应端点**（`product/edit`、`kami/kind/edit`、
  `kami/group/*` 都没有「商品 ID」字段），只能在后台点。不关联 = 商品在售但买家拍下
  <b>发不出货，且不会有任何报错</b>。<br>
  <b>另：</b>卡密内容已按「下载链接 + 提取码」灌好，每个卡种 999 条；买家下单后闲管家原生发卡密，
  <b>不依赖自建网关</b>。回滚：<code>npx tsx scripts/artcraft-kami.ts --rollback</code>
</div>
</body></html>
"""
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"已生成：{OUT}")
    print(f"  共 {len(rows)} 条，在售 {on_sale}，卡种已建 {kinds_ok}")


if __name__ == "__main__":
    main()
