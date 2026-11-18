import fs from'node:fs';const d=JSON.parse(fs.readFileSync('out/netdisk-before-curation/index.json'));const log=JSON.parse(fs.readFileSync('out/netdisk-curation-log.json'));const fixed=fs.existsSync('out/netdisk-directory-moves-fixed.json')?JSON.parse(fs.readFileSync('out/netdisk-directory-moves-fixed.json')):{moves:[]};
const byPath=new Map();function w(ns){for(const n of ns){byPath.set(n.path,n);w(n.children||[])}}w(d.tree);
function remove(ns,p){const i=ns.findIndex(n=>n.path===p);if(i>=0)return ns.splice(i,1)[0];for(const n of ns){const found=remove(n.children||[],p);if(found)return found;}}
function folder(p){if(byPath.has(p))return byPath.get(p);const name=p.split('/').at(-1);const parent=p.includes('/')?folder(p.slice(0,p.lastIndexOf('/'))):{children:d.tree};const n={name,path:p,dir:true,children:[],mtime:new Date().toISOString().slice(0,10)};parent.children||=[];parent.children.push(n);byPath.set(p,n);return n;}
function repath(n,old,to){n.path=to+n.path.slice(old.length);for(const c of n.children||[])repath(c,old,to)}
for(const m of [...log.moves,...fixed.moves]){const n=remove(d.tree,m.source);if(!n)continue;repath(n,m.source,m.to);folder(m.dest).children.push(n);}
d.generated_at=new Date().toISOString();d.partial=true;d.errors=[{path:'整理核对中',message:'根据已完成移动记录重建，稍后以网盘重新扫描结果核对'}];fs.writeFileSync('out/netdisk-index.json',JSON.stringify(d,null,1));
