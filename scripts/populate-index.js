const fs = require('fs').promises;
const path = require('path');

async function run() {
  const workspacePath = process.cwd();
  const memrayDir = path.join(workspacePath, '.memray');
  try {
    const st = await fs.stat(memrayDir);
    if (!st.isDirectory()) {
      console.log('.memray not a directory');
      return;
    }
  } catch (e) {
    console.log('.memray does not exist');
    return;
  }

  const entries = [];
  const files = await fs.readdir(memrayDir);
  const looseMap = {};

  for (const name of files) {
    const p = path.join(memrayDir, name);
    const s = await fs.stat(p);
    if (s.isDirectory()) {
      const metaPath = path.join(p, 'meta.json');
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(raw);
        entries.push({ id: meta.id || path.basename(p), title: meta.title || path.basename(p), html: path.relative(workspacePath, meta.html || ''), bin: path.relative(workspacePath, meta.bin || ''), timestamp: meta.timestamp || new Date().toISOString() });
        continue;
      } catch (err) {
        const inside = await fs.readdir(p);
        let html; let bin;
        for (const f of inside) {
          if (f.endsWith('.html')) html = path.join(p, f);
          if (f.endsWith('.bin')) bin = path.join(p, f);
        }
        entries.push({ id: path.basename(p), title: path.basename(p), html: html ? path.relative(workspacePath, html) : undefined, bin: bin ? path.relative(workspacePath, bin) : undefined, timestamp: s.mtime.toISOString() });
      }
    } else if (s.isFile()) {
      if (name.endsWith('.html') || name.endsWith('.bin')) {
        const base = name.replace(/\.html$|\.bin$/i, '');
        looseMap[base] = looseMap[base] || {};
        if (name.endsWith('.html')) looseMap[base].html = path.join('.memray', name);
        if (name.endsWith('.bin')) looseMap[base].bin = path.join('.memray', name);
        looseMap[base].mtime = s.mtime.toISOString();
      }
    }
  }

  for (const [k, v] of Object.entries(looseMap)) {
    entries.push({ id: k, title: k, html: v.html ? path.relative(workspacePath, v.html) : undefined, bin: v.bin ? path.relative(workspacePath, v.bin) : undefined, timestamp: v.mtime });
  }

  entries.sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''));
  const indexPath = path.join(memrayDir, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), 'utf8');
  console.log(`Wrote ${entries.length} entries to ${indexPath}`);
}

run().catch(err => { console.error(err); process.exit(1); });
