import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import os from 'node:os';const exec=promisify(execFile);
const d=JSON.parse(fs.readFileSync('out/netdisk-before-curation/index.json'));const a=[];function w(ns){for(const n of ns){a.push(n);w(n.children||[])}}w(d.tree);
const selected=a.filter(n=>!n.dir && /Blender-5003-Interior-Models.jpg|KITBASH-420-DETAILS.jpg|全家桶图片\/Adobe.png|平面系列\/.*A3-Metric Gridlines.png|drive-download-20241215T041635Z-001\/PNG\/.*\.png$/i.test(n.path));
const picks=selected.filter(n=>!n.path.includes('/PNG/')).concat(selected.find(n=>n.path.includes('/PNG/'))||[]);
const log=JSON.parse(fs.readFileSync('out/netdisk-curation-log.json'));
fs.mkdirSync('netdisk-site/media/previews',{recursive:true});const records=[];
for(const [i,n] of picks.entries()){
 const moved=log.moves.filter(m=>n.path===m.source||n.path.startsWith(m.source+'/')).sort((x,y)=>y.source.length-x.source.length)[0];
 const remote=moved?moved.to+n.path.slice(moved.source.length):n.path;
 const local=`media/previews/preview-${i}${path.extname(n.name)}`;
 try{await exec(path.join(os.homedir(),'.local/bin/bdpan'),['download',remote,path.resolve('netdisk-site',local)],{timeout:120000});records.push({original:n.path,remote,cover:local});console.log('已下载原始预览图',n.name)}catch(e){console.log('下载失败',n.name,e.message.slice(0,150))}
}
fs.writeFileSync('out/netdisk-preview-images.json',JSON.stringify(records,null,2));
