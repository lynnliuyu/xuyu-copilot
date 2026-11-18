/**
 * 目录树查看器。
 *
 * 用 list 自建 BFS 遍历（可访问全盘），把结果渲染成带「文件数 / 体积」的缩进树，
 * 用于快速看清网盘结构、决定哪些目录适合作为可售资源。
 *
 * 用法：
 *   npx tsx scripts/tree.ts --path=/ --depth=3
 *   npx tsx scripts/tree.ts --path=/淘宝出售类 --depth=6 --files=5
 */
import { walkTree, CATEGORY, type FileEntry } from '../packages/bdpan-core/src/files';
import { normalizePath, toDisplayPath } from '../packages/bdpan-core/src/paths';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function human(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: FileEntry[];
  size: number;
  fileCount: number;
}

function buildTree(entries: FileEntry[], root: string): Node {
  const rootNode: Node = { name: root, path: root, dirs: new Map(), files: [], size: 0, fileCount: 0 };
  const dirNodes = new Map<string, Node>([[root, rootNode]]);

  const ensureDir = (p: string): Node => {
    const existing = dirNodes.get(p);
    if (existing) return existing;
    const parent = ensureDir(p.slice(0, p.lastIndexOf('/')) || '/');
    const node: Node = { name: p.slice(p.lastIndexOf('/') + 1), path: p, dirs: new Map(), files: [], size: 0, fileCount: 0 };
    parent.dirs.set(node.name, node);
    dirNodes.set(p, node);
    return node;
  };

  // 先建所有目录节点，保证空目录也可见
  for (const e of entries) if (e.isdir === 1) ensureDir(e.path);
  if (!dirNodes.has(root)) ensureDir(root);

  for (const e of entries) {
    if (e.isdir === 1) continue;
    const parentPath = e.path.slice(0, e.path.lastIndexOf('/')) || '/';
    const parent = dirNodes.get(parentPath) ?? ensureDir(parentPath);
    parent.files.push(e);
  }

  // 自底向上聚合体积与文件数
  const aggregate = (n: Node): void => {
    n.size = n.files.reduce((a, f) => a + (f.size ?? 0), 0);
    n.fileCount = n.files.length;
    for (const c of n.dirs.values()) {
      aggregate(c);
      n.size += c.size;
      n.fileCount += c.fileCount;
    }
  };
  aggregate(rootNode);
  return rootNode;
}

async function main() {
  const root = normalizePath(arg('path', '/'));
  const depth = Number(arg('depth', '3'));
  const max = Number(arg('max', '60000'));
  const showFiles = Number(arg('files', '0'));

  process.stderr.write(`遍历 ${toDisplayPath(root)}（深度 ${depth}）...\n`);
  const t0 = Date.now();
  const entries = await walkTree({ root, max, intervalMs: 100, maxDepth: depth });
  const tree = buildTree(entries, root);
  const cost = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n${toDisplayPath(root)}   合计 ${tree.fileCount} 文件 / ${human(tree.size)}    (${cost}s)\n`);

  const printNode = (n: Node, prefix: string, isLast: boolean, isRoot: boolean) => {
    if (!isRoot) {
      const branch = isLast ? '└─ ' : '├─ ';
      const meta = n.fileCount === 0 && n.dirs.size === 0 ? '(空)' : `${String(n.fileCount).padStart(5)} 文件  ${human(n.size).padStart(10)}`;
      console.log(`${prefix}${branch}${n.name}    ${meta}`);
    }
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    const kids = [...n.dirs.values()].sort((a, b) => b.size - a.size);
    if (showFiles > 0 && n.files.length) {
      const shown = [...n.files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, showFiles);
      shown.forEach((f, i) => {
        const last = i === shown.length - 1 && kids.length === 0;
        console.log(
          `${childPrefix}${last ? '└─ ' : '├─ '}${f.server_filename}    ${human(f.size ?? 0)}  [${CATEGORY[f.category ?? 0] ?? '?'}]`,
        );
      });
      if (n.files.length > showFiles) {
        console.log(`${childPrefix}${kids.length ? '│  ' : '   '}... 另外 ${n.files.length - showFiles} 个文件`);
      }
    }
    kids.forEach((c, i) => printNode(c, childPrefix, i === kids.length - 1, false));
  };

  printNode(tree, '', true, true);
}

main().catch((e) => {
  console.error('失败：', e?.message ?? e);
  process.exit(1);
});
