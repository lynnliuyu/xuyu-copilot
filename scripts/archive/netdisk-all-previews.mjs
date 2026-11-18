import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import os from 'node:os';const exec=promisify(execFile);
const d=JSON.parse(fs.readFileSync('out/netdisk-before-curation/index.json'));const arr=[];function w(ns){for(const n of ns){arr.push(n);w(n.children||[])}}w(d.tree);
const picks=arr.filter(n=>!n.dir&&/\.(jpg|jpeg|png|webp|avif)$/i.test(n.name)&&n.size<5e6&&(n.path.match(/^00-资源池\/淘宝出售类\/素材类\/[^/]+$/)||n.path.includes('/Shopee/网店素材/')));
const records=JSON.parse(fs.readFileSync('out/netdisk-preview-images.json'));let i=0;
async function worker(){while(i<picks.length){const n=picks[i++];if(records.some(r=>r.original===n.path))continue;
 const log=JSON.parse(fs.readFileSync('out/netdisk-curation-log.json'));const m=log.moves.filter(m=>n.path===m.source||n.path.startsWith(m.source+'/')).sort((x,y)=>y.source.length-x.source.length)[0];const remote=m?m.to+n.path.slice(m.source.length):n.path;
 const cover=`media/previews/${crypto.createHash('sha256').update(n.path).digest('hex').slice(0,16)}${path.extname(n.name)}`;
 try{await exec(path.join(os.homedir(),'.local/bin/bdpan'),['download',remote,path.resolve('netdisk-site',cover)],{timeout:90000});records.push({original:n.path,remote,cover});fs.writeFileSync('out/netdisk-preview-images.json',JSON.stringify(records,null,2));console.log('原图',records.length,n.name);}catch(e){console.log('失败',n.name,e.message.slice(0,100))}
}}
await Promise.all(Array.from({length:4},worker));console.log('图片总数',records.length);
