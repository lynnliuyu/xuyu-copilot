#!/usr/bin/env node
/**
 * ArtCraft 套件 14 条商品的标题与描述（当前为 v3）。
 *
 * 迭代史
 * ------
 * v1（后台模板）：标题 = `FigCraft 界面设计工具 电脑软件 官方原版`；描述三段套话，
 *    13 个应用一字不差，买家看不出区别。
 * v2：逐条手写，讲清「平替谁 / 为什么好用 / 适合国人的原因」，并把「<商业软件>平替」
 *    写进标题（站内真实搜索词）。
 * v3（本次，用户 2026-10-16 反馈）：
 *    ⭐ 去掉「■ 适合国人的原因」「■ 相关搜索」两个小节 —— 用户明确说「这种词就不要
 *      带进去了」。前者有信息量的点**并入「为什么好用」**（不再单列、不改写措辞），
 *      后者是关键词堆砌，整段删除（既显廉价、也有被平台判堆词的风险）。
 *    ⭐ 按官方 README 补足真实卖点（LightCraft 的 RAW 机型覆盖、EffectCraft 的
 *      306 种效果、DeckCraft 的 150+ 形状、CADCraft 的完整命令集…）。
 *    ⭐ 补上会引发纠纷的**功能性限制**：EffectCraft 不能打开 .aep 工程、CADCraft
 *      尚不能读 SHX 字体（含 chineset.shx）。宁可少卖一单，不要「描述与实物不符」。
 *    ⭐ 许可证写准：**MIT OR Apache-2.0 双许可**，依据是仓库根目录实物存在
 *      `LICENSE-APACHE` + `LICENSE-MIT` + `NOTICE`（GitHub API license.spdx_id =
 *      Apache-2.0 只报单一值）。⚠️ 早前打包按 `LICENSE` 抓取 → 存下来的是
 *      「404: Not Found」，已单独修复。
 *    ⭐ 「■ 使用说明」改名为「■ 购买须知」：现在真有一份中文使用手册 PDF 随包，
 *      不能让小节名和手册撞车。
 * v4（2026-10-16 推送前自审，**抓到 3 处与实物不符**）：
 *    ⭐ VectorCraft 标题原写 `AI矢量绘图` —— 但 `vectorcraft.md` 全文**没有出现过 AI**，
 *      是我自己加的；矢量绘图 ≠ AI 绘图。改为 `VectorCraft Illustrator平替 插画`。
 *      ⚠️ 教训：**「AI」这个词不要顺手加**。加了要么是错的（本处），要么把商品推进
 *      平台敏感方向（词表里 `\bAI\b` 是 warn）—— ArtCraft 那条属实才留（README 原句
 *      "the IDE for interactive AI image and video creation"）。
 *    ⭐ 体积数字错了：原写 SoundCraft「47 MB」、Launcher「37 MB」，实为**三个安装包相加**。
 *      单个安装包实测：SoundCraft msi 10.9 / zip 14.3 / dmg 22.0 MB；
 *      Launcher msi 8.7 / zip 9.5 / dmg 18.5 MB。已改成按平台分别写。
 *    ⭐ 其余数字全部逐条回查 README 通过：EffectCraft 306 效果（含 AE 全部 298）、
 *      DeckCraft 150+ 形状 / 200+ 命令 / 11 种版式 / 8 套主题、LightCraft 18 内置预设、
 *      WordCraft 21 种语言、PhotoCraft 67 工具 / 16 调整图层 —— 均属实。
 *    ⚠️ 已知未改：官方 README 里这个启动器自称 **ArtCraft Launcher**（出现 17 次），
 *      但封面图、手册、网盘目录都叫 Craft Launcher。**改名要连封面与手册一起重做**，
 *      故本轮保持一致、暂不改名。
 * v4b（用户 2026-10-16 决定）：**ArtCraft 标题去掉 AI 词**。
 *    理由：词表点名的组合正落在它身上（`\bAI\b` 与「生成/绘画」连用），而账号曾因
 *    AI 相关图片被封控过一次。用户选「标题去掉 AI 词，正文保留」——
 *    即**标题**避开该组合，**正文仍完整写清它是 AI 创作工具**（规则允许
 *    「正常功能描述可用」），不隐瞒能力。新标题：
 *      `ArtCraft 场景搭建 3D合成 视频创作`（27）
 *    三个词都出自 README：Scene Blocking / 3D Image Compositing / video creation。
 *
 * ⚠️ 硬约束（两条都来自 packages/xgj-admin/src/keywords.ts）
 *   1. 标题权重上限 30：汉字/字母 = 1，**数字与特殊字符各 = 2**（空格也算特殊字符 = 2）。
 *   2. 雷区词：破解、免费、永久、全网最低、可商用、GPT —— **一律不出现**。
 *      「开源」可以说，「免费」不写。⚠️ ArtCraft 支持的模型里有 GPT 系，**不能写进文案**。
 *
 * 事实来源（不编造原则）
 *    · 定位/平替对象：各仓库 README 首屏原句（`clean-room reimplementation of X`）
 *    · 功能点：各仓库 README 的 Features 段
 *    · MCP：README 里确有 MCP server 的应用才写（artcraft / craft-launcher 没有，不写）
 *    · 界面语言：只在 README 里查到明确语言列表的应用才写简体中文
 *    · 安装包清单与体积：out/artcraft-suite/ 下**实际文件**（不是想当然）
 *    · 许可证：仓库根目录 LICENSE-APACHE / LICENSE-MIT / NOTICE 实物
 *
 * 用法：
 *   node scripts/artcraft-copy-v2.mjs           # 校验 + 输出
 *   node scripts/artcraft-copy-v2.mjs --check   # 只校验
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/noonebook/WorkBuddy/百度网盘mcp';
const OUT = path.join(ROOT, 'out', 'artcraft-copy-v2');

/** 闲鱼标题权重：汉字/字母 = 1，数字与特殊字符各 = 2（与 keywords.ts 同源） */
function titleWeight(s) {
  let w = 0;
  for (const ch of s) w += /[0-9]/.test(ch) || !/[\u4e00-\u9fa5a-zA-Z]/.test(ch) ? 2 : 1;
  return w;
}

/** 所有条目共用的尾部（安装包说明 / 获取方式 / 购买须知），避免 14 份重复维护 */
const TAIL = `■ 关于安装包
官方原版安装包，未做任何修改；随包附中文使用手册（PDF）与图文安装说明。

■ 获取方式
拍下后自动发货，提供百度网盘下载链接。

■ 购买须知
1. 建议先转存到你自己的网盘再下载，避免链接失效
2. 打开链接如提示输入提取码，已在发货内容里一并给出
3. 虚拟商品，发出后不支持退款，介意勿拍`;

/** 各应用共用的「包含内容」尾两行（版本号由调用方拼） */
const LIC = `· 开源许可证：MIT OR Apache-2.0 双许可（随包附 LICENSE-APACHE / LICENSE-MIT / NOTICE）
· 中文使用手册 PDF（安装、上手、功能速查、常见问题）`;

const WIN_BOTH = '· Windows 10/11：安装版 .msi + 免安装 portable .zip';
const MAC = '· macOS：.dmg（Apple 芯片与 Intel 通用）';

const ITEMS = [
  {
    code: 'BD-ARTCRAFT',
    name: 'ArtCraft',
    title: 'ArtCraft 场景搭建 3D合成 视频创作',
    content: `【ArtCraft · AI 图像视频创作工作台 v0.41.0】

■ 它是什么
面向创作者的 AI 图像 / 视频创作工具，把「搭场景 → 定机位 → 生成」做成可视化流程。先在 2D / 3D 画布上摆好人物、道具和镜头，再让 AI 出图、出视频 —— 不是靠反复抽提示词碰运气。

■ 为什么好用
· 2D / 3D 双画布：背景、前景、道具分层摆放，构图有纵深，能精确控制机位与角度
· 人物可控：可摆姿势、可做角色身份迁移，同一个人物在多张图里保持一致
· 图生 3D：一张图转成可旋转、可摆位的 3D 模型，直接当场景道具复用
· 一键去背景：抠出来的人物能直接当素材再加工
· 模型可选：图像、视频、音乐音效、3D 模型、场景世界多类模型按活儿挑，不被锁死在某一家
· 一次入手长期可用：同类 AI 绘画工具多为月费制，这是开源项目
· 本地运行、原生轻量：桌面原生应用，不是套壳浏览器，创作不依赖外网环境

⚠️ 生图 / 生视频需自备模型接口 Key 或购买官方点数，安装包内不含任何 AI 额度

■ 包含内容（v0.41.0）
· Windows：安装版 .exe / .msi
· macOS：.dmg（Apple 芯片与 Intel 通用）
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-PHOTOCRAFT',
    name: 'PhotoCraft',
    title: 'PhotoCraft PS平替 修图软件 图层蒙版',
    content: `【PhotoCraft · 开源照片编辑器 v0.9.0｜Photoshop 平替】

■ 它是什么
纯 Rust 重写的开源修图软件，官方定位即「Photoshop 的 clean-room 重实现」。图层、蒙版、调整图层、图层样式、文字、矢量、笔刷俱全，而且能原生打开与保存真实的 PSD 文件。

■ 为什么好用
· 真的是 PSD：不是「另存为 PSD」，是原生读写 .psd / .psb，跟 PS 互导不掉图层
· 非破坏性编辑：16 种调整图层随时改、随时关，原图不动；图层样式可在图层间复制粘贴
· 67 种工具 + 真实笔刷引擎：形状动态、散布、纹理、双重笔刷、颜色动态，受笔压/倾斜/旋转驱动
· 选区够专业：魔棒、快速选择、对象选择、主体选择，智能选区在本机跑、不上云
· 滤镜实时预览：模糊（高斯/动感/径向/镜头/倾斜偏移…）、锐化、降噪、扭曲、像素化、风格化、渲染
· 色彩管理：RGB / 灰度 / CMYK / Lab，8 / 16 / 32 位每通道，真实 ICC 色彩管理、软打样、色域警告
· 兼容面广：还能打开 PSB、分层 TIFF、OpenRaster、Krita、PDN3、SVG、HEIC、EXR / HDR / FITS
· 一次入手长期可用：PS 走订阅制、年年续费，这是开源项目
· 不用注册账号：无需 Adobe ID，不联网验证激活
· 装机体积小：不必再装几个 G 的 Creative Cloud 全家桶

■ 包含内容（v0.9.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-PDFCRAFT',
    name: 'PdfCraft',
    title: 'PdfCraft Acrobat平替 PDF编辑器',
    content: `【PdfCraft · PDF 工作台 v0.8.0｜Acrobat 平替】

■ 它是什么
纯 Rust 重写的开源 PDF 工具，官方定位即「Adobe Acrobat 的 clean-room 重实现」。阅读、整理、合并、拆分、加密一套做完，全部在本机跑。

■ 为什么好用
· 合并 / 拆分 / 提取：合并任意数量 PDF（每个文件自动生成书签），按指定页提取，按每 n 页拆分，链接、表单域、图层、附件都保留
· 页面整理：旋转、删除、插入空白页、从别的文件插页、前后移动
· 忠实渲染：多语言文字、竖排日文、彩色 emoji、渐变、透明度都按作者原意呈现；大页面分块渲染，放大到多少倍文字都锐利
· 容错打开：每页独立渲染，损坏文档会被修复
· 搜索与复制：输入即搜、逐条跳转，按正确阅读顺序选文字（支持分栏、从右到左、中日韩）
· 表单、图层、附件、评论：表单域与字段高亮、图层开关即时重绘、附件可打开或保存
· 走标准安全处理器：40 位 RC4 到 AES-256 全支持，输入所有者密码即可解除作者限制
· 一次入手长期可用：Acrobat 是订阅制，这是开源项目
· 文件不出本机：合同、证件、标书这类敏感 PDF 不用上传给第三方在线转换
· 不用注册账号：不联网验证激活

■ 包含内容（v0.8.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-LIGHTCRAFT',
    name: 'LightCraft',
    title: 'LightCraft Lightroom平替 修图调色',
    content: `【LightCraft · 照片库与 RAW 冲图 v0.8.0｜Lightroom 平替】

■ 它是什么
纯 Rust 重写的开源照片管理与冲图软件，官方定位即「Adobe Lightroom 的 clean-room 重实现」。照片库 + RAW 冲图 + 批量处理，一条链走完。

■ 为什么好用
· 相机 RAW 直读：DNG、佳能 CR2 / CR3、索尼 ARW、尼康 NEF、富士 RAF（含 X-Trans）、松下 RW2 / 徕卡 RWL、宾得 PEF、奥林巴斯 ORF 等主流格式
· 非破坏性：所有调整都不动原片，随时回退到任意一步；同时写 XMP 边车文件，换软件也不丢调整
· 32 位浮点宽色域管线：高光像胶片一样柔和过渡，暗部提亮不出光晕
· 调整项齐全：曝光 / 对比 / 高光 / 阴影 / 白色 / 黑色、色温色调、鲜艳度、8 段色彩混合器、三路调色、纹理 / 清晰度 / 去雾 / 暗角 / 颗粒、色调曲线
· 蒙版能选会组合：笔刷、线性 / 径向渐变，还能按亮度范围、颜色范围、天空、主体、背景选择，再用加 / 减 / 交集组合
· 预设与批量：18 个内置预设，可存自己的预设，按所选分组复制 / 粘贴 / 同步编辑
· 图库管理：全部照片、最近添加、精选、按日期、相册、最近删除，可评分打标并按字段搜索
· 导出与输出：JPEG / PNG / TIFF / WebP / AVIF / DNG，还能一键生成 PDF 联系表用于打印选片
· 界面自带简体中文：Edit → Language 里直接切，不用装汉化补丁
· 一次入手长期可用：Lightroom 是订阅制，这是开源项目
· 离线下能干活：摄影外拍现场不联网也能改图

■ 包含内容（v0.8.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-WORDCRAFT',
    name: 'WordCraft',
    title: 'WordCraft Word平替 文档排版 文字处理',
    content: `【WordCraft · 文档写作与排版 v0.7.0｜Microsoft Word 平替】

■ 它是什么
纯 Rust 重写的开源文字处理软件，官方定位即「Microsoft Word 的 clean-room 重实现」。文档写作、排版、打印一套齐活。

■ 为什么好用
· 完整的 Word 工作流：功能区、样式、表格、修订、引用、邮件合并，都是熟悉的位置
· 排版能力全：字符与段落格式、标尺拖拽缩进、制表位前导符、分栏、分节、页眉页脚（首页 / 奇偶页）、页码、水印、页面边框、首字下沉、自动断字
· 长文档利器：目录、脚注尾注、引文与参考文献（APA / MLA / Chicago / IEEE）、题注、交叉引用、索引
· 审阅与协作：批注气球、修订（Track Changes）、接受 / 拒绝、文档比较、限制编辑、文档检查器、无障碍检查器
· 邮件合并：从 CSV 合并、合并域、地址块、问候语、规则、预览，还能做信封与标签
· 表格与对象：网格插图、合并拆分、跨页重复表头、公式排序；图片裁剪重着色、形状、文本框、文字环绕
· 多视图：打印布局 / Web 布局 / 草稿 / 阅读模式 / 焦点模式，还有深色模式
· 格式互通：读写 .docx，可打开 .doc，导出 PDF（带可选文本与书签），另支持 ODT / RTF / HTML / Markdown / LaTeX / TXT
· 界面含简体中文与繁體中文，共 21 种语言，默认跟随系统
· 一次入手长期可用：Office 是订阅制，这是开源项目
· 不用注册账号：不用 Microsoft 账号、不联网验证
· 轻装运行：装机体积小，老电脑也能跑

■ 包含内容（v0.7.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-VECTORCRAFT',
    name: 'VectorCraft',
    title: 'VectorCraft Illustrator平替 插画',
    content: `【VectorCraft · 矢量插画 v0.11.0｜Illustrator 平替】

■ 它是什么
纯 Rust 重写的开源矢量绘图软件，官方定位即「Adobe Illustrator 的 clean-room 重实现」。SVG、路径、图标设计为主战场。

■ 为什么好用
· 沿用 Illustrator 的手感：Pen、Direct Selection、Pathfinder、智能参考线、外观面板、色板、图层面板的位置和快捷键都在
· 矢量核心扎实：真实贝塞尔锚点与控制手柄、上下文任务栏、精确曲线布尔运算、形状生成器
· 高级矢量表现：渐变网格、实时径向重复、封套扭曲、实时 3D 旋转成形
· 尺寸标注工具：线性 / 角度 / 直径 / 半径标注，并随所测图形一起变化
· 透视网格：附着到平面上的图形保持透视可编辑
· 多画板：一个文件里排多张画板
· 文字：带样式文字、文字串接（threading），支持双向排版
· SVG 一等支持：矢量格式直接进出，做图标、做 UI 资源顺手；另可导出 PDF（含 PDF/X）、PNG / JPEG / WebP，输出 PSD；能打开 SVGZ、EPS、DXF、EMF / WMF
· 界面含简体中文与繁體中文，另有中文字体随包，中文排版不缺字
· 一次入手长期可用：Illustrator 是订阅制，这是开源项目
· 不用注册账号：不用 Adobe ID、不联网验证

■ 包含内容（v0.11.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-EFFECTCRAFT',
    name: 'EffectCraft',
    title: 'EffectCraft AE平替 动效合成 视频特效',
    content: `【EffectCraft · 动效与视觉特效 v0.10.0｜After Effects 平替】

■ 它是什么
纯 Rust 重写的开源动效合成软件，官方定位即「Adobe After Effects 的 clean-room 重实现」。时间轴、图层合成、特效一套做下来。

■ 为什么好用
· 合成与图层：固体层、形状层、文字层、素材层、嵌套合成、空对象、调整图层、摄像机、灯光，支持父子关系、轨道遮罩、38 种混合模式与运动模糊
· 关键帧专业：线性 / 贝塞尔 / 保持 / 自动 / 连续贝塞尔，缓动、关键帧速度与插值对话框，带数值与速度曲线、可拖手柄的图表编辑器
· 效果库很大：306 种效果（含 After Effects 全部 298 种），覆盖模糊、调色、扭曲、生成、抠像、模拟、时间、音频等分类，另有 9 种图层样式
· 形状与遮罩：修剪路径、中继器、圆角、位移、锯齿、扭转、摆动、路径合并、渐变描边；钢笔工具画遮罩，支持模式、羽化、扩展与顶点编辑
· 3D 与摄像机：3D 图层、单 / 双节点摄像机（景深）、平行 / 聚光 / 点 / 环境光与柔和光线追踪阴影
· 表达式：JavaScript，兼容 After Effects 对象模型（wiggle、loopOut、thisComp.layer(…) 等）
· 渲染导出：渲染队列、输出模块与模板，可出 H.264 MP4、ProRes MOV（带 alpha）、HEVC、AV1、WebM、PNG / JPEG / TIFF、32 位 EXR 序列、动图 GIF、WAV / AIFF；另支持 Lottie 导入导出
· 真人驱动工具：木偶变形（位置 / 弯曲 / 重叠引脚），Roto 笔刷与人脸跟踪模型可按需下载
· 可被 AI 驱动：内置 MCP 服务，UI 上点得动的操作，脚本和 AI agent 也能做
· 一次入手长期可用：AE 是订阅制，这是开源项目
· 不用注册账号：不用 Adobe ID、不联网验证

⚠️ 工程文件为自有的 .ecproj 格式，**不能打开 After Effects 的 .aep / .aepx 工程**，AE 插件也不适用

■ 包含内容（v0.10.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-CADCRAFT',
    name: 'CADCraft',
    title: 'CADCraft AutoCAD平替 二维制图 标注',
    content: `【CADCraft · 二维制图 v0.7.0｜AutoCAD 平替】

■ 它是什么
纯 Rust 重写的开源 CAD 工具，官方定位即「Autodesk AutoCAD 的 clean-room 重实现」。二维绘图与尺寸标注为主。

■ 为什么好用
· 绘图命令齐全：直线、多段线（含圆弧与宽度）、圆、圆弧、矩形（圆角 / 倒角）、正多边形、椭圆、样条、点、构造线、射线、圆环、单行 / 多行文字
· 修改命令齐全：移动、复制、旋转、缩放、镜像、拉伸、偏移、修剪、延伸、圆角、倒角、打断、合并、分解、矩形 / 极轴阵列、显示顺序、消除重线
· 命令行照旧：还是敲「line 0,0 @10,0 @0,5 c」这样画图，命令别名（如 L）、相对坐标 @dx,dy、极坐标 @5&lt;45
· 精确绘图：对象捕捉（端点、中点、圆心、几何中心、节点、象限点、交点、插入点、垂足、切点…）、极轴追踪、正交、栅格捕捉
· 图层与特性：图层管理器（开关、冻结、锁定、打印、颜色、线型）、隔离 / 关闭 / 匹配等图层工具、逐对象特性面板、真彩色
· 标注专业：全部 DIM 系列命令与 DIMSTYLE 变量、随几何变化的关联尺寸、多重引线、表格
· 填充与块：拾取点边界（含孤岛）、图案 / 实心 / 渐变填充、块定义与插入、属性与嵌套块
· 布局与打印：图纸空间布局、视口（比例、锁定、逐视口图层冻结）、页面设置、PLOT 与导出 PDF
· 参数化：几何与标注约束、带表达式的参数、冲突检测，每次编辑后约束自动重解
· 文件仍是 DXF / DWG：DXF 原生读写（ASCII 与二进制，R12–2018），DWG 可打开 R13–2018、保存为 R2000，还能导出 SVG 与 PNG
· 界面含简体中文：跟随系统语言自动切换，实时生效
· 一次入手长期可用：AutoCAD 是订阅制且价格高，这是开源项目
· 轻装运行：一百多 MB，装完就能用
· 不用注册账号：不用 Autodesk 账号、不联网验证

⚠️ 暂不读取 SHX 字体（含 chineset.shx 这类大字体）：SHX 样式的文字会用内置单线字体绘制；缺字（如中文）自动从系统字体补，可用 FONTFALLBACK 指定（如思源黑体 / 微软雅黑）

■ 包含内容（v0.7.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-DESIGNCRAFT',
    name: 'DesignCraft',
    title: 'DesignCraft InDesign平替 排版软件',
    content: `【DesignCraft · 版面设计与出版 v0.8.0｜InDesign 平替】

■ 它是什么
纯 Rust 重写的开源排版软件，官方定位即「Adobe InDesign 的 clean-room 重实现」。面向多页文档与印刷排版。

■ 为什么好用
· 沿用 InDesign 的工作流：跨页与主页（parent pages）、框架与串接文本、控制面板、段落与字符样式、色板、文本绕排
· 专业排版引擎：Knuth–Plass 段落排版，词典连字、强制对齐、孤行控制、光学边距、分栏、基线网格、制表符
· 所见即所得：屏幕上的断行与导出 PDF 里的断行完全一致，不用导出后才发现换行变了
· 串接与绕排：一个故事可流经多栏、绕排到引文框周围
· 印刷导向：命名颜色与 CMYK 印刷色板，导出 PDF/X-4、PDF/A-2b
· 多页文档：画册、杂志、手册这类多页版面是主场
· 输出格式多：IDML 导入导出（能跟 InDesign 交换文件）、可编辑的 PowerPoint 导出、PNG、EPUB
· 可被 AI 驱动：每个菜单项与面板控件都能通过 MCP 服务与 JSON 控制通道驱动，脚本和 AI agent 能接管重复排版
· 一次入手长期可用：InDesign 是订阅制，这是开源项目
· 不用注册账号：不用 Adobe ID、不联网验证
· 轻装运行：装机体积小，不用拖着全家桶

■ 包含内容（v0.8.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-DECKCRAFT',
    name: 'DeckCraft',
    title: 'DeckCraft PPT平替 幻灯片制作 演示文稿',
    content: `【DeckCraft · 幻灯片演示 v0.7.0｜PowerPoint 平替】

■ 它是什么
纯 Rust 重写的开源演示文稿软件，官方定位即「Microsoft PowerPoint 的 clean-room 重实现」。做幻灯片、做演示。

■ 为什么好用
· 版式体系完整：幻灯片母版、11 种版式（占位符继承位置与格式）、8 套原创主题（含配色与字体方案）、节
· 绘图不将就：150+ 预设形状（带调整手柄）、可吸附的连接线、自由曲线 / 曲线 / 涂鸦、合并形状（并集 / 组合 / 拆分 / 相交 / 减除）、渐变 / 图片 / 图案填充、虚线箭头、阴影、发光、柔化边缘、映像
· 文字编辑：画布上原地编辑，完整字体与段落格式、项目符号与编号、分栏、自动调整大小、竖排文字、域与超链接
· 素材好加：图片（可裁剪与校正）、带样式表格、图表、SmartArt 基础功能、音频与视频插入并可播放
· 放映与动效：切换效果（含 Morph）、进入 / 强调 / 退出动画、运动路径、按段落逐条出现、全屏放映、演讲者视图、画笔、排练计时
· 导出选择多：PDF（幻灯片 / 备注页 / 讲义，带可选文本）、PNG / JPEG、整套演示文稿的动画 GIF、大纲文本
· 文件仍是 .pptx：打开与保存 PowerPoint 文件，未保存的工作由自动恢复保留
· 可被 AI 驱动：200+ 命令并支持撤销，全部能从命令行、JSON 控制通道和面向 AI 的 MCP 服务调用
· 一次入手长期可用：Office 是订阅制，这是开源项目
· 不用注册账号：不用 Microsoft 账号、不联网验证
· 轻装运行：汇报电脑也能轻装

■ 包含内容（v0.7.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-SOUNDCRAFT',
    name: 'SoundCraft',
    title: 'SoundCraft 音频工作站 多轨录音 混音剪辑',
    content: `【SoundCraft · 音频工作站 v0.7.0｜Pro Tools 平替】

■ 它是什么
纯 Rust 重写的开源 DAW，官方定位即「Avid Pro Tools 的 clean-room 重实现」。多轨录音、剪辑、混音，还带 MIDI 编曲与记谱。

■ 为什么好用
· 剪辑手感专业：Shuffle / Slip / Spot / Grid 四种编辑模式，智能、选择、抓取、修剪、铅笔、缩放、擦拭工具；按选择 / 按网格 / 按瞬态分离、接合、合并、去除静音、微移、五种形状的淡入淡出
· 混音台齐全：推子与声像（带自动化）、前置 / 后置发送、总线、辅助输入、主推子、VCA 主控、路由文件夹、独奏模式、插件延迟自动补偿
· 自动化完整：音量、声像、静音、发送及每个插件参数，Write / Touch / Latch / Trim 录制
· 插件自带一大套：7 段与 1 段 EQ、压缩限幅、扩展门、去齿音、最大化器、房间与板式混响、调制延迟、合唱、镶边、移相、饱和、移调、时间伸缩、抖动等，还能加载 CLAP 插件；任意处理器都能作为 AudioSuite 离线跑
· 自带合成器与采样器：减法合成器、鼓机、采样器（可用键盘弹奏任意 WAV / AIFF / FLAC / MP3 / OGG）
· MIDI 编曲：乐器轨与 MIDI 轨、带力度泳道的钢琴卷帘、事件列表、乐谱视图、步进输入、量化、移调，还能把演唱或演奏的旋律转成 MIDI
· 录音：按选择或即时插入录音、前后卷、循环录音（每次 take 一个播放列表）、完整通道条输入监听、自动保存与恢复
· 速度与时间：Bars|Beats 到 Timecode（全帧率含丢帧）多种时间标尺、速度与拍号映射、保音高的弹性变速
· 导出：混音或分轨导出 WAV / AIFF / FLAC，16 / 24 / 32 位浮点，支持抖动与标准化，并报告峰值、真峰值与整体响度（LUFS）
· 视频与环绕声：画面轨与跟随播放头的视频窗口（原生解码 H.264 / ProRes / Motion JPEG）；从立体声到 9.1.6 与 Ambisonics 的总线格式
· 记谱与打印：Score Editor，可导出 MusicXML 交给 Sibelius 等记谱软件，也能出可打印的雕版乐谱
· 装机极轻：Windows 安装包 10.9 MB（免安装版 14.3 MB）、macOS 22 MB，老旧笔记本也扛得住
· 一次入手长期可用：专业 DAW 多为高价买断或订阅，这是开源项目
· 断网也能开工：不用账号、不联网验证，录音棚离线可用

■ 包含内容（v0.7.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-FIGCRAFT',
    name: 'FigCraft',
    title: 'FigCraft Figma平替 UI设计 原型工具',
    content: `【FigCraft · 界面设计与原型 v0.6.0｜Figma 平替】

■ 它是什么
纯 Rust 重写的开源界面设计工具，官方定位即「Figma 的 clean-room 重实现」。帧、自动布局、组件与变体、矢量网络、样式、变量、原型 —— 桌面客户端形态，打开即用。

■ 为什么好用
· 自动布局：双向 auto layout，支持 wrap 与网格，内边距、间距、对齐（含文字基线）、Hug / Fill / Fixed 尺寸，画布上直接拖手柄调间距，方向键可让子项在流与网格单元间移动
· 组件与变体：主组件、带覆盖的实例（覆盖在编辑后保留）、组件集与变体、属性、换实例、分离、重置覆盖，资源面板带实时缩略图与搜索
· 样式与变量：本地样式与变量（颜色、数字、字符串、布尔），支持模式、别名、作用域，可绑定到填充、描边、效果、布局网格和实例属性
· 矢量能力不缩水：真正的矢量网络，钢笔与铅笔工具、矢量编辑模式（延伸与分叉路径、弯曲、任意闭合区域上色、套索、切割）、点面板（镜像手柄、逐点圆角）、形状生成器、布尔组（并集 / 相减 / 相交 / 排除，操作数保持可编辑）、轮廓描边、箭头、虚线、可变宽度描边
· 填充与效果：线性 / 径向 / 角度 / 菱形渐变（画布手柄）、图像填充（填充 / 适应 / 裁剪 / 平铺）、多重填充与描边、全部混合模式、投影与内阴影、图层与背景模糊、噪点、玻璃、蒙版
· 文字排版：画布上就地编辑（支持内联输入法）、段落内混合样式、自动宽高、行高、字距段距、列表、OpenType 特性、可变字体轴、从右到左与混排文字
· 原型与交付：连接、触发器、动作与智能动画式过渡、带条件与表达式的变量、演示视图（带设备框）、Inspect 面板与实时预览；Alt 量距、标注分类、可交付清单与改动对比，还能生成 CSS / HTML / React / SwiftUI 代码，评论线程与命名版本历史
· 导出：任意图层按任意倍率导出 PNG / JPG / WebP / SVG / PDF
· 八套起始模板：手机 App、落地页、仪表盘、设计系统起步、线框套件、社交图尺寸、演示幻灯片、图标集
· 可被 AI 驱动：400+ 条命令统一注册，UI 点击、命令行、JSON 通道与 MCP 服务共用一套 —— 点得动的，脚本和 AI agent 也能做
· 本地原生：不是浏览器套壳，秒开、断网也能改稿
· 一次入手长期可用：Figma 是团队订阅制，这是开源项目
· 不依赖境外网络：本地客户端，改稿不用等云端同步
· 不用注册账号：稿件存本地，不用担心文件存在别人服务器上

■ 包含内容（v0.6.0）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-CRAFT-LAUNCHER',
    name: 'Craft Launcher',
    title: 'Craft Launcher 软件管理器 应用启动器',
    content: `【Craft Launcher · 套件启动器 v0.4.1】

■ 它是什么
ArtCraft 全家桶的启动器。一个入口管理整套应用：列出套件里所有软件、标注你已经装了哪些、是什么版本，自动为你这台机器挑对安装包，有新版本还会提示。

■ 为什么好用
· 一个入口管全套：不用挨个去翻十几个发布页找安装包
· 自动识别平台与处理器架构，装对版本不踩坑
· 下载前自动按官方 SHA-256 校验，安装放心
· 网格与表格两种视图：一眼看清每个应用装了没、什么版本、最新版本与发布日期
· 自我更新：有新版本时点「更新并重启」即完成下载、校验与覆盖
· 能认出你手动装的应用，也能更新它们
· 常驻菜单栏 / 系统托盘，体积小：Windows 8.7 MB 起、macOS 18.5 MB
· 简体中文界面：跟随系统 zh-CN 自动切换，不用汉化
· 一次入手长期可用：装完即在手边，不用一个个找下载、一个个对版本
· 离线可用：不联网也能启动已装应用

■ 包含内容（v0.4.1）
${WIN_BOTH}
${MAC}
${LIC}

${TAIL}`,
  },
  {
    code: 'BD-ARTCRAFT-FULLSET',
    name: 'ArtCraft 全家桶',
    title: 'ArtCraft 全家桶 13款设计软件 开源套件',
    content: `【ArtCraft 全家桶 · 13 款开源创作软件一次到位】

■ 它是什么
13 个开源创作应用的合集：修图、矢量、排版、动效、音频、CAD、UI 设计、幻灯片、文档、PDF、照片冲图、AI 创作工作台。全部 MIT OR Apache-2.0 双许可。

■ 这套里都有什么
· PhotoCraft　照片编辑（Photoshop 平替）
· VectorCraft　矢量插画（Illustrator 平替）
· DesignCraft　版面排版（InDesign 平替）
· EffectCraft　动效合成（After Effects 平替）
· FigCraft　　 界面设计（Figma 平替）
· LightCraft　 照片库与 RAW 冲图（Lightroom 平替）
· DeckCraft　　幻灯片演示（PowerPoint 平替）
· WordCraft　　文档写作排版（Word 平替）
· PdfCraft　　 PDF 阅读编辑（Acrobat 平替）
· SoundCraft　 音频工作站（Pro Tools 平替）
· CADCraft　　 二维制图（AutoCAD 平替）
· ArtCraft　　 AI 图像视频创作工作台
· Craft Launcher　套件启动器

■ 为什么划算
· 一次拿到一整套，不用一个软件一个软件地找
· 全部纯 Rust 原生 + 离线可用 + 开源可查
· 多数应用支持被 AI / 脚本驱动（MCP），能接进自己的工作流
· 每个应用都附一份中文使用手册，装完就能上手
· 一次入手长期可用：这一套对标的商业软件全部是订阅制，加起来的年费不便宜
· 不用注册账号：不用各家账号、不联网验证激活

⚠️ 其中 ArtCraft 的 AI 生图 / 生视频需自备模型接口 Key 或购买官方点数
⚠️ EffectCraft 的工程文件是自有的 .ecproj 格式，不能打开 After Effects 的 .aep 工程

■ 包含内容
· Windows 10/11：每个应用都有安装版 .msi + 免安装 portable .zip
· macOS：每个应用都有 .dmg（Apple 芯片与 Intel 通用）
· 13 个应用，共 39 个安装包；另有各应用中文使用手册 PDF、套件总览与 MANIFEST
· 开源许可证：MIT OR Apache-2.0 双许可（随包附 LICENSE-APACHE / LICENSE-MIT / NOTICE）

${TAIL}`,
  },
];

// —— 校验 + 输出 ——
const checkOnly = process.argv.includes('--check');
const problems = [];
const rows = [];

for (const it of ITEMS) {
  const w = titleWeight(it.title);
  const ok = w <= 30;
  if (!ok) problems.push(`${it.code} 标题权重 ${w} > 30：${it.title}`);
  for (const bad of ['破解', '免费', '永久', '全网最低', '可商用', 'GPT', '适合国人的原因', '相关搜索']) {
    if (it.title.includes(bad) || it.content.includes(bad)) {
      problems.push(`${it.code} 命中雷区词/禁用措辞「${bad}」`);
    }
  }
  rows.push({ code: it.code, name: it.name, title: it.title, weight: w, ok, content: it.content });
}

console.log('code'.padEnd(24), 'w'.padStart(3), ' 标题');
console.log('─'.repeat(96));
for (const r of rows) {
  console.log(r.code.padEnd(24), String(r.weight).padStart(3), ' ' + (r.ok ? '✓' : '✗') + ' ' + r.title);
}
console.log('─'.repeat(96));
console.log(`共 ${rows.length} 条；标题权重区间 ${Math.min(...rows.map((r) => r.weight))}~${Math.max(...rows.map((r) => r.weight))}（上限 30）`);
console.log(`描述长度 ${Math.min(...rows.map((r) => r.content.length))}~${Math.max(...rows.map((r) => r.content.length))} 字`);

if (problems.length) {
  console.log('\n❌ 问题：');
  for (const p of problems) console.log('  · ' + p);
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过：权重 ≤30，无雷区词、无「适合国人的原因 / 相关搜索」措辞');
}

if (!checkOnly) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const r of rows) {
    fs.writeFileSync(
      path.join(OUT, `${r.code}.json`),
      JSON.stringify({ code: r.code, name: r.name, title: r.title, title_weight: r.weight, content: r.content }, null, 1),
      'utf8'
    );
  }
  const md = [
    '# ArtCraft 14 条 · 标题与描述（v3）',
    '',
    '> 权重规则：汉字/字母 = 1，数字与特殊字符（含空格）= 2，上限 30。',
    '> 雷区词（破解/免费/永久/全网最低/可商用/GPT）已全文筛查。',
    '> v3 变更：删除「适合国人的原因」「相关搜索」两个小节；卖点按官方 README 补实；',
    '> 补上会引发纠纷的功能性限制（.aep 不可打开、SHX 字体不可读）；许可证改为 MIT OR Apache-2.0 双许可。',
    '',
    '## 标题一览',
    '',
    '| code | 权重 | 标题 |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.code} | ${r.weight} | ${r.title} |`),
    '',
    '---',
    '',
    '## 完整描述',
    '',
    ...rows.flatMap((r) => [
      `### ${r.code}　${r.name}`,
      '',
      `**标题**（权重 ${r.weight}）：${r.title}`,
      '',
      '```',
      r.content,
      '```',
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(path.join(OUT, '_对照.md'), md, 'utf8');
  console.log(`\n已写出 → ${OUT}/<code>.json（14 份）+ _对照.md`);
}
