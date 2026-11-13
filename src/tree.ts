import { relative } from 'node:path';
import type { Project } from './project.js';
import type { BrokenFile, ScanResult } from './scan.js';
import type { Painter } from './util/color.js';
import { toPosix } from './util/text.js';

interface Node {
  name: string;
  children: Map<string, Node>;
  project?: Project;
  broken?: BrokenFile;
}

export interface TreeOptions {
  ascii?: boolean;
  /** Show name/version, lock type and dependency counts (default true). */
  details?: boolean;
  cwd?: string;
}

const newNode = (name: string): Node => ({ name, children: new Map() });

function insert(root: Node, rel: string, leaf: (n: Node) => void): void {
  let node = root;
  const segs = rel === '' ? [] : rel.split('/');
  for (const seg of segs) {
    if (!node.children.has(seg)) node.children.set(seg, newNode(seg));
    node = node.children.get(seg)!;
  }
  leaf(node);
}

/** Collapse chains of directories that hold nothing but a single sub-directory: a/b/c. */
function compress(node: Node): Node {
  for (const [k, child] of node.children) node.children.set(k, compress(child));
  if (!node.project && !node.broken && node.children.size === 1 && node.name !== '') {
    const only = [...node.children.values()][0]!;
    return { ...only, name: `${node.name}/${only.name}` };
  }
  return node;
}

function describe(p: Project, paint: Painter['paint'], details: boolean): string {
  const bits: string[] = [];
  if (p.name) bits.push(paint('accent', p.name) + (p.version ? paint('dim', `@${p.version}`) : ''));
  else bits.push(paint('dim', '(unnamed)'));
  if (!details) return bits.join(' ');
  const tags: string[] = [];
  if (p.workspaces) tags.push('workspace root');
  else if (p.workspaceRoot) tags.push('workspace');
  if (p.private) tags.push('private');
  if (p.lock) tags.push(p.lock.name);
  const count = p.deps.filter((d) => d.kind !== 'overrides' && d.kind !== 'packageManager').length;
  bits.push(paint('dim', `${count} dep${count === 1 ? '' : 's'}`));
  if (tags.length) bits.push(paint('hint', `[${tags.join(', ')}]`));
  return bits.join('  ');
}

/** Render the scanned package.json locations as a directory tree, one tree per scan root. */
export function renderTree(result: ScanResult, painter: Painter, opts: TreeOptions = {}): string {
  const { paint } = painter;
  const details = opts.details !== false;
  const cwd = opts.cwd ?? process.cwd();
  const g = opts.ascii
    ? { tee: '|-- ', last: '`-- ', pipe: '|   ', space: '    ' }
    : { tee: '├── ', last: '└── ', pipe: '│   ', space: '    ' };
  const out: string[] = [];

  for (const rootDir of result.roots) {
    const inRoot = (abs: string): boolean =>
      abs === rootDir || abs.startsWith(rootDir + '/') || abs.startsWith(rootDir + '\\');
    const projects = result.projects.filter(
      (p) => p.root === rootDir || (inRoot(p.dir) && !result.roots.includes(p.root)),
    );
    const broken = result.broken.filter((b) => inRoot(b.file));
    if (!projects.length && !broken.length) continue;
    const tree = newNode('');
    for (const p of projects) insert(tree, toPosix(relative(rootDir, p.dir)), (n) => (n.project = p));
    for (const b of broken)
      insert(tree, toPosix(relative(rootDir, b.file)).replace(/\/?package\.json$/, ''), (n) => (n.broken = b));
    for (const [k, child] of tree.children) tree.children.set(k, compress(child));

    const label = toPosix(relative(cwd, rootDir)) || '.';
    const count = projects.length;
    let head = `${paint('path', label)} ${paint('dim', `(${count} package.json)`)}`;
    if (tree.project) head += `  ${describe(tree.project, paint, details)}`;
    out.push(head);

    const walk = (node: Node, prefix: string): void => {
      const kids = [...node.children.values()].sort((a, b) => {
        // projects before plain directories, then alphabetical
        const pa = a.project ? 0 : 1;
        const pb = b.project ? 0 : 1;
        return pa - pb || a.name.localeCompare(b.name);
      });
      kids.forEach((kid, i) => {
        const last = i === kids.length - 1;
        let line = prefix + (last ? g.last : g.tee);
        if (kid.project) line += `${paint('path', kid.name)}  ${describe(kid.project, paint, details)}`;
        else if (kid.broken)
          line += `${paint('error', kid.name)}  ${paint('error', `✖ invalid package.json: ${kid.broken.error}`)}`;
        else line += paint('dim', `${kid.name}/`);
        out.push(line);
        walk(kid, prefix + (last ? g.space : g.pipe));
      });
    };
    walk(tree, '');
    out.push('');
  }
  return out.join('\n').trimEnd();
}
