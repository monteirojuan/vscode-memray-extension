/**
 * live.js — Webview client script for Memray Live Mode.
 *
 * Runs inside the VS Code Webview sandbox. Receives messages from the
 * extension host via the VS Code API `acquireVsCodeApi()` and updates
 * the DOM in real time.
 *
 * Message protocol (from extension host → webview):
 *   { type: 'snapshot', data: LiveSnapshot }
 *   { type: 'stopped' }
 *
 * Message protocol (webview → extension host):
 *   { type: 'stop' }
 *   { type: 'openSource', file: string, line: number }
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // VS Code API
  // ---------------------------------------------------------------------------

  const vscode = acquireVsCodeApi(); // eslint-disable-line no-undef

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  const statHeap   = document.getElementById('stat-heap');
  const statPeak   = document.getElementById('stat-peak');
  const tableBody  = document.getElementById('topTableBody');
  const statusBar  = document.getElementById('status-bar');
  const btnStop    = document.getElementById('btn-stop');
  const canvas     = document.getElementById('memChart');

  // ---------------------------------------------------------------------------
  // Chart setup (inline mini-chart — no external library needed)
  // ---------------------------------------------------------------------------

  const MAX_POINTS = 120; // ~60 seconds at 500 ms interval
  const chartData  = [];  // { ts, rss } points

  const ctx = canvas.getContext('2d');

  function drawChart() {
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width  = W;
    canvas.height = H;

    ctx.clearRect(0, 0, W, H);

    if (chartData.length < 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.font = '12px var(--vscode-font-family, sans-serif)';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for data...', W / 2, H / 2);
      return;
    }

    const maxVal = Math.max(...chartData.map(d => d.heap), 1);
    const pad    = { top: 10, right: 8, bottom: 24, left: 60 };
    const cW     = W - pad.left - pad.right;
    const cH     = H - pad.top  - pad.bottom;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (cH * i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cW, y);
      ctx.stroke();

      // Y axis labels
      const val = maxVal * (1 - i / 4);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '10px var(--mono, monospace)';
      ctx.textAlign = 'right';
      ctx.fillText(formatBytes(val), pad.left - 4, y + 3);
    }

    // Area fill
    const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    gradient.addColorStop(0,   'rgba(14, 99, 156, 0.6)');
    gradient.addColorStop(1,   'rgba(14, 99, 156, 0.05)');

    ctx.beginPath();
    chartData.forEach((d, i) => {
      const x = pad.left + (i / (chartData.length - 1)) * cW;
      const y = pad.top  + (1 - d.heap / maxVal) * cH;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    });
    ctx.lineTo(pad.left + cW, pad.top + cH);
    ctx.lineTo(pad.left,       pad.top + cH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Line
    ctx.beginPath();
    chartData.forEach((d, i) => {
      const x = pad.left + (i / (chartData.length - 1)) * cW;
      const y = pad.top  + (1 - d.heap / maxVal) * cH;
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(14, 99, 156, 1)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // X axis — time range
    const first = chartData[0].ts;
    const last  = chartData[chartData.length - 1].ts;
    const elapsed = ((last - first) / 1000).toFixed(0);
    ctx.fillStyle   = 'rgba(255,255,255,0.4)';
    ctx.font        = '10px var(--mono, monospace)';
    ctx.textAlign   = 'left';
    ctx.fillText('0s', pad.left, H - 4);
    ctx.textAlign   = 'right';
    ctx.fillText(`${elapsed}s`, pad.left + cW, H - 4);
  }

  // ---------------------------------------------------------------------------
  // Table helpers
  // ---------------------------------------------------------------------------

  let sortKey   = 'mem';
  let sortAsc   = false;
  let lastTop   = [];
  let maxMemInTop = 1;

  function renderTable(top) {
    lastTop = top;
    maxMemInTop = Math.max(...top.map(r => r.mem), 1);

    const sorted = [...top].sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
      return sortAsc ? va - vb : vb - va;
    });

    tableBody.replaceChildren();

    if (sorted.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty-row';
      td.textContent = 'No allocations tracked yet.';
      tr.appendChild(td);
      tableBody.appendChild(tr);
      return;
    }

    const fragment = document.createDocumentFragment();
    sorted.forEach(row => {
      const mem = Number(row.mem);
      const line = Number.isFinite(row.line) ? row.line : (parseInt(String(row.line), 10) || 1);
      const file = String(row.file || '');
      const func = String(row.func || '');
      const barPct = Math.max(0, Math.min(100, (mem / maxMemInTop) * 100));

      const tr = document.createElement('tr');

      const tdFunc = document.createElement('td');
      tdFunc.title = func;
      tdFunc.textContent = func;
      tr.appendChild(tdFunc);

      const tdFile = document.createElement('td');
      const fileLink = document.createElement('span');
      fileLink.className = 'file-link';
      fileLink.dataset.file = file;
      fileLink.dataset.line = String(line);
      fileLink.title = `${file}:${line}`;
      fileLink.textContent = shortenPath(file);
      tdFile.appendChild(fileLink);
      tr.appendChild(tdFile);

      const tdLine = document.createElement('td');
      tdLine.textContent = String(line);
      tr.appendChild(tdLine);

      const tdMem = document.createElement('td');
      tdMem.className = 'mem-bar-cell';
      const memBar = document.createElement('div');
      memBar.className = 'mem-bar';
      memBar.style.width = `${barPct.toFixed(1)}%`;
      tdMem.appendChild(memBar);
      tdMem.appendChild(document.createTextNode(formatBytes(mem)));
      tr.appendChild(tdMem);

      const tdAllocs = document.createElement('td');
      tdAllocs.textContent = Number(row.allocs).toLocaleString();
      tr.appendChild(tdAllocs);

      fragment.appendChild(tr);
    });

    tableBody.appendChild(fragment);

    // Re-attach click listeners for file links
    tableBody.querySelectorAll('.file-link').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({
          type: 'openSource',
          file: el.dataset.file,
          line: parseInt(el.dataset.line, 10) || 1,
        });
      });
    });
  }

  // Sort by column header click
  document.querySelectorAll('#topTable th').forEach((th, idx) => {
    const keys = ['func', 'file', 'line', 'mem', 'allocs'];
    th.addEventListener('click', () => {
      const key = keys[idx];
      if (sortKey === key) {
        sortAsc = !sortAsc;
      } else {
        sortKey = key;
        sortAsc = key === 'func' || key === 'file'; // default asc for text
      }
      renderTable(lastTop);
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot handler
  // ---------------------------------------------------------------------------

  let snapshotCount = 0;

  function applySnapshot(data) {
    snapshotCount += 1;

    // Header stats
    statHeap.textContent = `Heap: ${formatBytes(data.heap)}`;
    statPeak.textContent = `Peak: ${formatBytes(data.peak)}`;

    // Chart
    chartData.push({ ts: data.ts, heap: data.heap });
    if (chartData.length > MAX_POINTS) chartData.shift();
    drawChart();

    // Table
    renderTable(data.top || []);

    // Status
    statusBar.textContent = `Running — ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'} received`;
  }

  // ---------------------------------------------------------------------------
  // Stop handler
  // ---------------------------------------------------------------------------

  btnStop.addEventListener('click', () => {
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping...';
    vscode.postMessage({ type: 'stop' });
  });

  // ---------------------------------------------------------------------------
  // Extension host → Webview messages
  // ---------------------------------------------------------------------------

  window.addEventListener('message', event => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'snapshot') {
      applySnapshot(msg.data);
    } else if (msg.type === 'stopped') {
      btnStop.disabled    = true;
      btnStop.textContent = 'Stopped';
      statusBar.textContent = `Session ended — ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'} received`;
      statusBar.classList.add('stopped');
    }
  });

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function shortenPath(p) {
    const parts = p.replace(/\\/g, '/').split('/');
    return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
  }

  // Redraw chart on resize
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 100);
  });

  // Initial paint
  drawChart();
}());
