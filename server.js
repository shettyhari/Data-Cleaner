// Data Cleaner - local web app for finding duplicate files and organizing folders.
// Zero dependencies: run with `node server.js`, then open http://localhost:4321
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile, spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UNDO_FILE = path.join(__dirname, 'organize-undo.json');
const IS_WIN = process.platform === 'win32';

// Folders never descended into while scanning (system / recycle areas).
const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'recovery', 'config.msi', 'node_modules', '.git',
]);

const CATEGORIES = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'raw', 'cr2', 'nef', 'arw', 'ico', 'psd'],
  Videos: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'],
  Audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff', 'mid', 'midi'],
  Documents: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'md', 'tex', 'epub', 'pages'],
  Spreadsheets: ['xls', 'xlsx', 'xlsm', 'csv', 'ods', 'numbers', 'tsv'],
  Presentations: ['ppt', 'pptx', 'odp', 'key'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'tgz', 'cab'],
  Code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'php', 'rb', 'html', 'css', 'scss', 'json', 'xml', 'yml', 'yaml', 'sql', 'sh', 'ps1', 'bat', 'ipynb'],
  Programs: ['exe', 'msi', 'apk', 'dmg', 'deb', 'rpm', 'appx', 'msix'],
  Fonts: ['ttf', 'otf', 'woff', 'woff2', 'fon'],
};
const EXT_TO_CATEGORY = {};
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CATEGORY[e] = cat;
const MONTHS = ['01-January', '02-February', '03-March', '04-April', '05-May', '06-June', '07-July', '08-August', '09-September', '10-October', '11-November', '12-December'];

// ---------- helpers ----------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

function extOf(name) {
  const e = path.extname(name).slice(1).toLowerCase();
  return e;
}

async function uniqueTarget(target, reserved) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  let i = 1;
  while (reserved.has(candidate.toLowerCase()) || fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i++})${ext}`);
  }
  reserved.add(candidate.toLowerCase());
  return candidate;
}

// Run async fn over items with limited concurrency.
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function hashFile(file, start, end) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const opts = start === undefined ? {} : { start, end };
    const s = fs.createReadStream(file, { ...opts, highWaterMark: 1024 * 1024 });
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Fast pre-check: hash first + last 64KB.
async function partialHash(file, size) {
  const CHUNK = 64 * 1024;
  if (size <= CHUNK * 2) return hashFile(file);
  const a = await hashFile(file, 0, CHUNK - 1);
  const b = await hashFile(file, size - CHUNK, size - 1);
  return a + b;
}

// ---------- drives & browsing ----------
async function listDrives() {
  if (!IS_WIN) return [{ path: '/', label: '/' }, { path: os.homedir(), label: 'Home' }];
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      await fsp.access(root);
      drives.push({ path: root, label: root });
    } catch { /* not present */ }
  }
  // Attach size info via PowerShell (best effort).
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,Size,FreeSpace,DriveType | ConvertTo-Json -Compress'],
        { timeout: 8000, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    let info = JSON.parse(out);
    if (!Array.isArray(info)) info = [info];
    for (const d of drives) {
      const m = info.find((x) => x.DeviceID + '\\' === d.path);
      if (m) {
        d.name = m.VolumeName || '';
        d.size = Number(m.Size) || 0;
        d.free = Number(m.FreeSpace) || 0;
        d.type = { 2: 'Removable', 3: 'Local Disk', 4: 'Network', 5: 'CD/DVD' }[m.DriveType] || '';
      }
    }
  } catch { /* ignore */ }
  return drives;
}

async function browse(dir) {
  dir = path.resolve(dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const folders = [];
  let fileCount = 0;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name.startsWith('$') || e.name.toLowerCase() === 'system volume information') continue;
      folders.push(e.name);
    }
    else if (e.isFile()) fileCount++;
  }
  folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, folders, fileCount };
}

// ---------- duplicate scanning (background jobs) ----------
const jobs = new Map();
// Files that appeared in a duplicate result - only these may be deleted.
const deletableFiles = new Map(); // lowercased path -> group hash

function newJob() {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, status: 'running', phase: 'Listing files', filesSeen: 0, bytesSeen: 0,
    candidates: 0, hashed: 0, toHash: 0, errors: 0, currentDir: '', result: null,
    error: null, cancelled: false, startedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

async function walk(root, opts, job, onFile) {
  const stack = [root];
  while (stack.length) {
    if (job.cancelled) return;
    const dir = stack.pop();
    job.currentDir = dir;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { job.errors++; continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (!opts.includeHidden && e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('$')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        await onFile(full, e.name);
      }
    }
  }
}

async function runScan(job, root, opts) {
  try {
    const bySize = new Map();
    const exts = opts.extensions && opts.extensions.length ? new Set(opts.extensions.map((x) => x.toLowerCase().replace(/^\./, ''))) : null;
    await walk(root, opts, job, async (full, name) => {
      if (exts && !exts.has(extOf(name))) return;
      let st;
      try { st = await fsp.stat(full); } catch { job.errors++; return; }
      job.filesSeen++;
      job.bytesSeen += st.size;
      if (st.size < opts.minSize) return;
      if (st.size === 0) return;
      const arr = bySize.get(st.size);
      const rec = { path: full, name, size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs };
      if (arr) arr.push(rec); else bySize.set(st.size, [rec]);
    });
    if (job.cancelled) { job.status = 'cancelled'; return; }

    // Stage 2: partial hash among same-size files
    const sameSize = [...bySize.values()].filter((a) => a.length > 1);
    let candidates = sameSize.flat();
    job.candidates = candidates.length;
    job.phase = 'Quick-checking same-size files';
    job.toHash = candidates.length;
    job.hashed = 0;
    await pool(candidates, 4, async (f) => {
      if (job.cancelled) return;
      try { f.quick = await partialHash(f.path, f.size); } catch { f.quick = null; job.errors++; }
      job.hashed++;
    });
    if (job.cancelled) { job.status = 'cancelled'; return; }

    const byQuick = new Map();
    for (const f of candidates) {
      if (!f.quick) continue;
      const k = f.size + ':' + f.quick;
      const a = byQuick.get(k);
      if (a) a.push(f); else byQuick.set(k, [f]);
    }

    // Stage 3: full hash to confirm (skip if file fully covered by partial hash)
    const needFull = [...byQuick.values()].filter((a) => a.length > 1).flat();
    job.phase = 'Verifying duplicates (full content hash)';
    job.toHash = needFull.length;
    job.hashed = 0;
    await pool(needFull, 3, async (f) => {
      if (job.cancelled) return;
      try {
        f.hash = f.size <= 128 * 1024 ? f.quick : await hashFile(f.path);
      } catch { f.hash = null; job.errors++; }
      job.hashed++;
    });
    if (job.cancelled) { job.status = 'cancelled'; return; }

    const byHash = new Map();
    for (const f of needFull) {
      if (!f.hash) continue;
      const a = byHash.get(f.hash);
      if (a) a.push(f); else byHash.set(f.hash, [f]);
    }
    const groups = [];
    for (const [hash, files] of byHash) {
      if (files.length < 2) continue;
      files.sort((a, b) => a.mtime - b.mtime);
      groups.push({
        hash,
        size: files[0].size,
        wasted: files[0].size * (files.length - 1),
        files: files.map(({ path: p, name, size, mtime, ctime }) => ({ path: p, name, size, mtime, ctime })),
      });
      for (const f of files) deletableFiles.set(f.path.toLowerCase(), hash);
    }
    groups.sort((a, b) => b.wasted - a.wasted);
    job.result = {
      root,
      groups,
      totalGroups: groups.length,
      totalDuplicates: groups.reduce((s, g) => s + g.files.length - 1, 0),
      totalWasted: groups.reduce((s, g) => s + g.wasted, 0),
      filesScanned: job.filesSeen,
      bytesScanned: job.bytesSeen,
      durationMs: Date.now() - job.startedAt,
    };
    job.status = 'done';
    job.phase = 'Done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  }
}

// ---------- deletion ----------
function recycleFiles(files) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'datacleaner-'));
    const listFile = path.join(tmp, 'list.json');
    const script = path.join(tmp, 'recycle.ps1');
    fs.writeFileSync(listFile, JSON.stringify(files), 'utf8');
    fs.writeFileSync(script, [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      '$list = [System.IO.File]::ReadAllText($args[0], [System.Text.Encoding]::UTF8) | ConvertFrom-Json',
      'foreach ($f in $list) {',
      '  try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, "OnlyErrorDialogs", "SendToRecycleBin"); Write-Output ("OK`t" + $f) }',
      '  catch { Write-Output ("ERR`t" + $f + "`t" + $_.Exception.Message) }',
      '}',
    ].join('\r\n'), 'utf8');
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, listFile], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d.toString('utf8'); });
    ps.on('close', () => {
      const results = {};
      for (const line of out.split(/\r?\n/)) {
        const [status, file, msg] = line.split('\t');
        if (file) results[file.toLowerCase()] = status === 'OK' ? null : (msg || 'Failed');
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(files.map((f) => {
        const key = f.toLowerCase();
        const err = key in results ? results[key] : (fs.existsSync(f) ? 'Not processed' : null);
        return { path: f, ok: !err, error: err || undefined };
      }));
    });
  });
}

async function deleteFiles(files, mode) {
  // Safety checks: only scanned duplicates, and never every copy of a group.
  const groupCounts = new Map();
  for (const [p, h] of deletableFiles) {
    if (fs.existsSync(p)) groupCounts.set(h, (groupCounts.get(h) || 0) + 1);
  }
  const requested = new Map();
  const rejected = [];
  for (const f of files) {
    const h = deletableFiles.get(String(f).toLowerCase());
    if (!h) { rejected.push({ path: f, ok: false, error: 'Not part of a duplicate scan result' }); continue; }
    requested.set(h, (requested.get(h) || 0) + 1);
  }
  const allowed = [];
  for (const f of files) {
    const h = deletableFiles.get(String(f).toLowerCase());
    if (!h) continue;
    if ((requested.get(h) || 0) >= (groupCounts.get(h) || 0)) {
      rejected.push({ path: f, ok: false, error: 'Refused: this would delete every copy of the file' });
    } else allowed.push(f);
  }

  let results;
  if (mode === 'permanent' || !IS_WIN) {
    results = [];
    for (const f of allowed) {
      try { await fsp.unlink(f); results.push({ path: f, ok: true }); } catch (e) { results.push({ path: f, ok: false, error: e.message }); }
    }
  } else {
    results = allowed.length ? await recycleFiles(allowed) : [];
  }
  for (const r of results) if (r.ok) deletableFiles.delete(r.path.toLowerCase());
  return [...results, ...rejected];
}

// ---------- organizing ----------
function targetFolderFor(name, stat, mode) {
  const ext = extOf(name);
  if (mode === 'extension') return ext ? ext.toUpperCase() : 'No Extension';
  if (mode === 'date') {
    const d = new Date(stat.mtimeMs);
    return path.join(String(d.getFullYear()), MONTHS[d.getMonth()]);
  }
  if (mode === 'type-date') {
    const d = new Date(stat.mtimeMs);
    return path.join(EXT_TO_CATEGORY[ext] || 'Others', String(d.getFullYear()));
  }
  if (mode === 'size') {
    const mb = stat.size / (1024 * 1024);
    if (mb < 1) return 'Small (under 1 MB)';
    if (mb < 100) return 'Medium (1-100 MB)';
    if (mb < 1024) return 'Large (100 MB-1 GB)';
    return 'Huge (over 1 GB)';
  }
  return EXT_TO_CATEGORY[ext] || 'Others';
}

async function planOrganize(root, mode, includeSubfolders) {
  root = path.resolve(root);
  const files = [];
  if (includeSubfolders) {
    const job = { cancelled: false, errors: 0 };
    await walk(root, { includeHidden: false }, job, async (full, name) => { files.push({ full, name }); });
  } else {
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      if (e.isFile()) files.push({ full: path.join(root, e.name), name: e.name });
    }
  }
  const reserved = new Set();
  const moves = [];
  const summary = {};
  for (const f of files) {
    if (f.name.startsWith('.') || /^desktop\.ini$|^thumbs\.db$/i.test(f.name)) continue;
    let st;
    try { st = await fsp.stat(f.full); } catch { continue; }
    const folder = targetFolderFor(f.name, st, mode);
    const destDir = path.join(root, folder);
    if (path.dirname(f.full).toLowerCase() === destDir.toLowerCase()) continue; // already organized
    const to = await uniqueTarget(path.join(destDir, f.name), reserved);
    moves.push({ from: f.full, to, folder, size: st.size });
    summary[folder] = summary[folder] || { count: 0, size: 0 };
    summary[folder].count++;
    summary[folder].size += st.size;
  }
  return { root, mode, moves, summary };
}

async function applyOrganize(root, moves) {
  const rootOrig = path.resolve(root);
  root = rootOrig.toLowerCase();
  const done = [];
  const failed = [];
  for (const m of moves) {
    const from = path.resolve(m.from);
    let to = path.resolve(m.to);
    if (!from.toLowerCase().startsWith(root) || !to.toLowerCase().startsWith(root)) {
      failed.push({ ...m, error: 'Outside selected folder' });
      continue;
    }
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      if (fs.existsSync(to)) to = await uniqueTarget(to, new Set());
      await fsp.rename(from, to);
      done.push({ from, to });
    } catch (e) { failed.push({ ...m, error: e.message }); }
  }
  if (done.length) fs.writeFileSync(UNDO_FILE, JSON.stringify({ root: rootOrig, at: Date.now(), moves: done }, null, 2));
  return { moved: done.length, failed };
}

async function undoOrganize() {
  if (!fs.existsSync(UNDO_FILE)) throw new Error('Nothing to undo');
  const log = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
  let restored = 0;
  const failed = [];
  const dirs = new Set();
  for (const m of log.moves.slice().reverse()) {
    try {
      if (fs.existsSync(m.from)) throw new Error('Original location is occupied');
      await fsp.mkdir(path.dirname(m.from), { recursive: true });
      await fsp.rename(m.to, m.from);
      dirs.add(path.dirname(m.to));
      restored++;
    } catch (e) { failed.push({ ...m, error: e.message }); }
  }
  // Remove folders that the organize step created and are now empty.
  const rootLc = log.root.toLowerCase();
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  for (let d of sorted) {
    while (d.toLowerCase().startsWith(rootLc) && d.toLowerCase() !== rootLc) {
      try { await fsp.rmdir(d); } catch { break; }
      d = path.dirname(d);
    }
  }
  fs.unlinkSync(UNDO_FILE);
  return { restored, failed };
}

function undoInfo() {
  if (!fs.existsSync(UNDO_FILE)) return null;
  try {
    const log = JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
    return { root: log.root, at: log.at, count: log.moves.length };
  } catch { return null; }
}

// ---------- HTTP routing ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/drives':
      return sendJson(res, 200, { drives: await listDrives(), home: os.homedir() });
    case 'GET /api/browse': {
      const p = url.searchParams.get('path');
      if (!p) return sendJson(res, 400, { error: 'path required' });
      return sendJson(res, 200, await browse(p));
    }
    case 'POST /api/scan': {
      const body = await readBody(req);
      if (!body.path || !(await isDir(body.path))) return sendJson(res, 400, { error: 'Folder not found' });
      const job = newJob();
      runScan(job, path.resolve(body.path), {
        minSize: Math.max(0, Number(body.minSize) || 0),
        includeHidden: !!body.includeHidden,
        extensions: Array.isArray(body.extensions) ? body.extensions : null,
      });
      return sendJson(res, 200, { jobId: job.id });
    }
    case 'GET /api/job': {
      const job = jobs.get(url.searchParams.get('id'));
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      const { cancelled, ...rest } = job;
      return sendJson(res, 200, rest);
    }
    case 'POST /api/job/cancel': {
      const body = await readBody(req);
      const job = jobs.get(body.id);
      if (job) job.cancelled = true;
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/delete': {
      const body = await readBody(req);
      if (!Array.isArray(body.files) || !body.files.length) return sendJson(res, 400, { error: 'No files' });
      const results = await deleteFiles(body.files, body.mode === 'permanent' ? 'permanent' : 'recycle');
      return sendJson(res, 200, { results });
    }
    case 'POST /api/reveal': {
      const body = await readBody(req);
      if (IS_WIN && body.path && fs.existsSync(body.path)) spawn('explorer.exe', ['/select,', body.path], { detached: true });
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/organize/preview': {
      const body = await readBody(req);
      if (!body.path || !(await isDir(body.path))) return sendJson(res, 400, { error: 'Folder not found' });
      return sendJson(res, 200, await planOrganize(body.path, body.mode || 'type', !!body.includeSubfolders));
    }
    case 'POST /api/organize/apply': {
      const body = await readBody(req);
      if (!body.path || !Array.isArray(body.moves)) return sendJson(res, 400, { error: 'Invalid request' });
      return sendJson(res, 200, await applyOrganize(body.path, body.moves));
    }
    case 'GET /api/organize/undo':
      return sendJson(res, 200, { undo: undoInfo() });
    case 'POST /api/organize/undo':
      return sendJson(res, 200, await undoOrganize());
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Only accept same-origin browser requests (blocks other websites from calling the API).
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return sendJson(res, 403, { error: 'Forbidden origin' });
  }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Data Cleaner running at http://localhost:${PORT}`);
});
