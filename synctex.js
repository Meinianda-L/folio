import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function run(args, cwd, searchPath) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn('synctex', args, { cwd, env: { PATH: searchPath || process.env.PATH || '/usr/bin:/bin', HOME: cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { if (out.length < 256 * 1024) out += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, out: error.code === 'ENOENT' ? 'synctex not installed' : 'synctex failed' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out }); });
  });
}
// `synctex` prints `Key:value` lines, one block per match between "SyncTeX result begin/end".
function records(out) {
  const list = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const match = line.match(/^(\w+):(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === 'Page' || key === 'Input') { current = {}; list.push(current); }
    if (current) current[key] = value;
  }
  return list;
}
const UNAVAILABLE = { available: false };

// Map between the last PDF and source lines. Coordinates are PDF points from the page's top-left.
// toPdf: { file, line } → { boxes: [{ page, x, y, width, height }] }
// toSource: { page, x, y } → { file, line }
export async function synctexQuery({ folder, synctexRoot, searchPath, direction, file, line, page, x, y }) {
  const gz = path.join(folder, 'output.synctex.gz');
  if (!synctexRoot || !(await fs.stat(gz).catch(() => null))) return UNAVAILABLE;
  // synctex wants the PDF and its .synctex.gz side by side under the same name.
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-synctex-'));
  try {
    await fs.copyFile(path.join(folder, 'output.pdf'), path.join(work, 'output.pdf'));
    await fs.copyFile(gz, path.join(work, 'output.synctex.gz'));
    if (direction === 'toPdf') {
      const result = await run(['view', '-i', `${Math.max(1, Number(line) || 1)}:0:${path.join(synctexRoot, '.', file)}`, '-o', 'output.pdf'], work, searchPath);
      if (!result.ok) return UNAVAILABLE;
      const boxes = records(result.out).filter(item => item.Page).map(item => ({ page: Number(item.Page), x: Number(item.h), y: Number(item.v) - Number(item.H), width: Number(item.W), height: Number(item.H) }))
        .filter(box => [box.page, box.x, box.y, box.width, box.height].every(Number.isFinite));
      return { available: true, boxes };
    }
    const result = await run(['edit', '-o', `${Math.max(1, Number(page) || 1)}:${Number(x) || 0}:${Number(y) || 0}:output.pdf`], work, searchPath);
    if (!result.ok) return UNAVAILABLE;
    // Inputs are recorded inside the build snapshot; report project sources, not build output.
    for (const item of records(result.out)) {
      if (!item.Input || !(Number(item.Line) > 0)) continue;
      const relative = path.relative(synctexRoot, path.resolve(item.Input.trim())).split(path.sep).join('/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.startsWith('output/')) return { available: true, file: relative, line: Number(item.Line) };
    }
    return { available: true };
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}
