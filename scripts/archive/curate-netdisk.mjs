import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const CLI = path.join(os.homedir(), '.local/bin/bdpan');
const original = JSON.parse(fs.readFileSync('out/netdisk-before-curation/index.json'));
const entries = [];
function walk(ns) { for (const n of ns) { entries.push(n); walk(n.children || []); } }
walk(original.tree);
const logFile = 'out/netdisk-curation-log.json';
const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : { moves: [], errors: [] };
const plan = [];
const add = (n, dest) => { if(n) plan.push({ source:n.path, dest, name:n.name }); };
const find = p => entries.find(n=>n.path===p);
const root = '00-资源池';
for (const name of ['材质系列','立面系列','平面系列','室内设计专用Procreate笔刷']) add(find(`${root}/${name}`), '设计素材/Procreate笔刷');
for (const n of find(`${root}/我的资源`)?.children || []) add(n, '设计素材/Procreate笔刷/综合套装');
add(find(`${root}/小米智能家居设计方案智家装全屋灯光设备点位布局清单网开关系统`), '智能家居/设计方案');
for (const name of ['Homeassistant','KNX6.2']) add(find(`${root}/淘宝出售类/${name}`), '智能家居/工具');
add(find('Adobe 2026 mac'), '软件/Mac软件');
for (const n of original.tree.filter(n=>n.name.startsWith('X1a0He Plugin for Mac'))) add(n,'软件/Mac软件');
const isImage = n=>/\.(png|jpe?g|webp|avif|svg)$/i.test(n.name);
const modelType = name => /stl|打印/i.test(name) ? '3D打印' : /car|bmw|mazda|nissan|mclaren|porsche|subaru|toyota|jiotto/i.test(name) ? '车辆模型' : /bunny|anime|female|blue.archive|finnick|fnaf|clawhauser|buzz|tramp|head/i.test(name) ? '角色模型' : /house|town|city|building|temple|eiffel|courtyard|room|signboard|game.map/i.test(name) ? '建筑与场景' : /rock|polyhaven|kitbash/i.test(name) ? '环境与材质' : '物件模型';
const baseName = n=>n.name.replace(/\.(zip|rar|7z)$/i,'').replace(/ \(\d+\)$/,'').replaceAll('_','-');
for(const n of find(`${root}/淘宝出售类/素材类`)?.children || []) {
  if(isImage(n)) { add(n,'设计素材/预览图片'); continue; }
  if(/\.(flv|mp4)$/i.test(n.name)) { add(n,'设计素材/视频参考'); continue; }
  if(/keentools|blenderkit|quad.remesher/i.test(n.name)) {add(n,`Blender工具/${/quad/i.test(n.name)?'Quad Remesher':/keentools/i.test(n.name)?'KeenTools':'BlenderKit'}`);continue;}
  if(/cat.catch|\.crx$|\.xpi$/i.test(n.name)) {add(n,'软件/浏览器插件/猫抓');continue;}
  if(/\.(exe|msi)$/i.test(n.name)) {add(n,`软件/Windows软件/${/blender/i.test(n.name)?'Blender':'Telegram'}`);continue;}
  if(n.dir||/\.(zip|rar|7z)$/i.test(n.name)) add(n,`三维素材/${modelType(n.name)}/${baseName(n)}`);
  else add(n,'设计素材/参考资料');
}
for(const type of find(`${root}/淘宝出售类/实用类`)?.children || []) for(const n of type.children || []) add(n,`软件/Windows软件/${type.name.replace('其他实用','其他工具')}`);
for(const n of find(`${root}/淘宝出售类/游戏`)?.children || []) add(n,'游戏资源/雀魂');
for(const n of find(`${root}/淘宝出售类/Shopee`)?.children || []) add(n,n.name==='网店素材'?'设计素材/商品展示图':'软件/安装包合集');
fs.writeFileSync('out/netdisk-curation-plan.json',JSON.stringify(plan,null,2));
const made = new Set();
async function command(args) {
  const {stdout} = await exec(CLI,[...args,'--json'],{timeout:120000,maxBuffer:8*1024*1024});
  let j;try{j=JSON.parse(stdout)}catch{throw Error(stdout.slice(0,160))}
  if(j?.error||j?.code && j.code!==0)throw Error(j.error||j.message||stdout.slice(0,160));return j;
}
async function mkdir(dest) {
  const parts=dest.split('/');for(let i=1;i<=parts.length;i++){const p=parts.slice(0,i).join('/');if(made.has(p))continue;
    try{await command(['mkdir',p]);}catch(e){await command(['ls',p]);}made.add(p);
  }
}
for(const item of plan){
  if(log.moves.some(m=>m.source===item.source))continue;
  try{
    await mkdir(item.dest);
    // Never replace or merge same-name items implicitly.
    const existing=await command(['ls',item.dest]);
    if(Array.isArray(existing)&&existing.some(n=>n.path !== `/apps/bdpan/${item.dest}` && n.server_filename===item.name))throw Error('目标同名项目存在，保留原项目');
    await command(['mv',item.source,item.dest]);
    log.errors=log.errors.filter(e=>e.source!==item.source);
    log.moves.push({...item,to:`${item.dest}/${item.name}`});console.log(`已整理 ${log.moves.length}/${plan.length} ${item.name}`);
  }catch(e){log.errors.push({...item,error:e.message});console.log(`未移动 ${item.name}: ${e.message}`);}
  fs.writeFileSync(logFile,JSON.stringify(log,null,2));
}
console.log(JSON.stringify({planned:plan.length,moved:log.moves.length,errors:log.errors.length}));
