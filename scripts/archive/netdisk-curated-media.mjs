import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const index=JSON.parse(fs.readFileSync('out/netdisk-index.json'));
const nodes=[];function walk(ns){for(const n of ns){nodes.push(n);walk(n.children||[])}}walk(index.tree);
const media=JSON.parse(fs.readFileSync('netdisk-site/media.json'));
media.curated ||= {};
const titles={
 'drive-download-20241215T041635Z-001':'Ultimate Fantasy RTS · 幻想策略游戏资产',
 'drive-download-20241215T041427Z-001':'模型资源合集',
 'anime-head':'动漫角色头部', 'fantasy-town':'幻想小镇', 'free-la-tour-eiffel':'埃菲尔铁塔',
 'hw-4-cyberpunk-sci-fi-building':'赛博朋克科幻建筑', 'lowpoly-rocks-1':'低多边形岩石',
 'mechanical-rgb-keyboard':'RGB 机械键盘', 'one-piece-going-merry':'黄金梅丽号海盗船',
 'taiwan-style-signboard-lowpoly':'低多边形街头招牌', 'tiny-isometric-room':'等距小房间',
 'ancient-chinese-courtyard-park':'中式庭院公园', 'chinese-house':'中式住宅',
 'low-poly-city-pack':'低多边形城市合集', 'sea-house':'海边小屋',
 'japanese-horyu-ji-temple-replica':'日本法隆寺建筑', '5v5-game-map':'5v5 游戏地图',
 'bloody-bunny':'血腥兔角色', 'blue-archivekasumizawa-miyu':'碧蓝档案 · 霞泽美游', 'buzz-lightyear-brawl-stars-t-pose':'巴斯光年角色 · T 姿势', 'clawhauser':'疯狂动物城 · 豹警官', 'finnick-fox':'狐狸角色', 'fnaf-hw2-jackie':'玩具熊角色模型', 'genshin-style-anime-female-base-mesh-for-blender':'动漫女性基础人体模型', 'longboard-texturing-practice':'长板模型 · 贴图练习', 'tramp-disney':'迪士尼流浪狗角色', 'animal-crossing-atlas-diorama-3':'动物森友会场景', 'polyhavenassets':'Poly Haven 材质与模型资产', '可打印stl文件':'STL 3D 打印模型合集',
 '91xx':'Uninstall Tool · 卸载工具', 'Agisoft_Metashape_Professiona':'Agisoft Metashape · 摄影测量', 'Steinberg_Cubase_Pro_v14.0':'Cubase Pro 14 · 音频制作', 'AdvancedInstaller22':'Advanced Installer 22 · 安装包制作', '4KVideoDownloaderPlus1.10.4.0167x64':'4K Video Downloader Plus', 'BCUninstaller_5.8.2_setup':'BCUninstaller · 批量卸载工具',
 'All-in-one Pack':'室内设计笔刷完整套装', 'procreate室内设计笔刷ipad彩平图平面立面材质家具线条手绘楼梯':'室内设计笔刷与基础教程',
};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const rootKinds={'3D模型':['Blender 模型','#123c59','#42d3d1'],'Blender建模':['Blender 插件','#743623','#ffb66b'],三维素材:['三维模型','#123c59','#42d3d1'],设计素材:['设计素材','#542b72','#ffa2bb'],智能家居:['智能家居','#164e42','#83edbf'],游戏资源:['游戏资源','#382b70','#aa9dff'],Blender工具:['Blender 工具','#743623','#ffb66b'],软件:['应用软件','#213f83','#93bfff'],'00-资源池':['归档资源','#374151','#cad4e3']};
fs.mkdirSync('netdisk-site/media/curated',{recursive:true});
for(const n of nodes.filter(n=>n.dir&&rootKinds[n.path.split('/')[0]])){
 const [kind,bg,accent]=rootKinds[n.path.split('/')[0]];
 let title=titles[n.name]||n.name.replace(/^\d{3,}[-_]\s*/,'');
 if(n.name.startsWith('X1a0He Plugin for Mac'))title='微信小助手 · Apple 芯片';
 if(n.name.startsWith('小米智能家居设计方案'))title='小米智能家居设计方案';
 if(n.name==='Adobe 2026 mac')title='Adobe 2026 · Mac 软件套装';
 const count=(function tally(n){return(n.children||[]).reduce((s,c)=>s+(c.dir?tally(c):1),0)})(n);
 const formats=[...new Set((function files(n){return(n.children||[]).flatMap(c=>c.dir?files(c):[c.name])})(n).map(s=>s.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase()).filter(Boolean))].slice(0,6);
 const usage = n.path.includes('Procreate') ? '用于 iPad 室内设计绘图，包含笔刷、线稿或参考资料' : n.path.startsWith('三维素材') ? '用于三维创作与场景搭建；具体软件兼容性以包内格式为准' : n.path.startsWith('智能家居') ? '智能家居方案、配置工具与参考资料' : n.path.startsWith('Blender工具') ? 'Blender 建模辅助工具，版本及平台请查看合集文件' : n.path.startsWith('游戏资源') ? '游戏相关资料与工具合集' : '按用途及平台整理的资源合集';
 const desc=`${usage} · ${kind} · ${count} 个文件${formats.length?' · '+formats.join(' / '):''}`;
 const h=crypto.createHash('sha256').update(n.path).digest('hex').slice(0,16);
 const lines=Array.from(title.matchAll(/.{1,14}/gu),m=>m[0]).slice(0,3);
 const art=(kind==='三维模型'||kind==='Blender 模型')?'<path d="M625 70 715 120 715 220 625 270 535 220 535 120Z M625 70V170 M535 120 625 170 715 120 M625 170V270"/>':kind==='智能家居'?'<path d="M530 170 625 85 720 170 M550 150V265H700V150 M603 265V200H647V265"/><circle cx="625" cy="150" r="13"/>':kind==='设计素材'?'<path d="M550 250 670 90 710 125 590 285Z M550 250 540 290 590 285 M655 110 695 145"/>':'<rect x="540" y="90" width="180" height="160" rx="25"/><path d="M580 140H680 M580 175H650 M580 210H670"/>';
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><defs><linearGradient id="g"><stop stop-color="${bg}"/><stop offset="1" stop-color="#101827"/></linearGradient><pattern id="p" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="white" opacity=".05"/></pattern></defs><rect width="800" height="450" fill="url(#g)"/><rect width="800" height="450" fill="url(#p)"/><circle cx="700" cy="65" r="240" fill="${accent}" opacity=".06"/><g stroke="${accent}" stroke-width="5" fill="none" stroke-linejoin="round">${art}</g><text x="48" y="68" fill="${accent}" font-family="sans-serif" font-size="20" letter-spacing="3">${esc(kind)}</text>${lines.map((line,i)=>`<text x="48" y="${155+i*48}" fill="white" font-family="system-ui,sans-serif" font-weight="600" font-size="32">${esc(line)}</text>`).join('')}<text x="48" y="367" fill="#c4cede" font-family="sans-serif" font-size="18">${esc(formats.join(' · ')||'资料与文件合集')}</text><text x="48" y="405" fill="#7f92ac" font-family="sans-serif" font-size="16">资源库 · 分类封面</text></svg>`;
 const file=`media/curated/${h}.svg`;fs.writeFileSync(path.join('netdisk-site',file),svg);
 media.curated[n.path]={title,description:desc,cover:file,formats};
}
media.previews ||= {};
if(fs.existsSync('out/netdisk-preview-images.json')) for(const p of JSON.parse(fs.readFileSync('out/netdisk-preview-images.json'))){
 const log=JSON.parse(fs.readFileSync('out/netdisk-curation-log.json'));
 const move=log.moves.filter(m=>p.original===m.source||p.original.startsWith(m.source+'/')).sort((a,b)=>b.source.length-a.source.length)[0];
 const remote=move?move.to+p.original.slice(move.source.length):p.remote;
 media.previews[remote]=p.cover;
 if(p.original.includes('/全家桶图片/Adobe.png')) for(const [k,v] of Object.entries(media.curated)) if(k.endsWith('Adobe 2026 mac')||k.endsWith('/全家桶图片'))v.cover=p.cover;
 if(p.original.includes('/PNG/')||p.original.endsWith('/Preview.jpg')) for(const [k,v] of Object.entries(media.curated)) if(k.endsWith('drive-download-20241215T041635Z-001'))v.cover=p.cover;
}
fs.writeFileSync('netdisk-site/media.json',JSON.stringify(media,null,1));
console.log(`制作分类及资源封面 ${Object.keys(media.curated).length} 项`);
