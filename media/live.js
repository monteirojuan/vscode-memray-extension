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

  const statRss    = document.getElementById('stat-rss');
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

    const maxVal = Math.max(...chartData.map(d => d.rss), 1);
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
      const y = pad.top  + (1 - d.rss / maxVal) * cH;
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
      const y = pad.top  + (1 - d.rss / maxVal) * cH;
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

    const rows = sorted.map(row => {
      const barPct = ((row.mem / maxMemInTop) * 100).toFixed(1);
      return `<tr>
        <td title="${escapeHtml(row.func)}">${escapeHtml(row.func)}</td>
        <td>
          <span class="file-link"
                data-file="${escapeHtml(row.file)}"
                data-line="${row.line}"
                title="${escapeHtml(row.file)}:${row.line}">
            ${escapeHtml(shortenPath(row.file))}
          </span>
        </td>
        <td>${row.line}</td>
        <td class="mem-bar-cell">
          <div class="mem-bar" style="width:${barPct}%"></div>
          ${escapeHtml(formatBytes(row.mem))}
        </td>
        <td>${row.allocs.toLocaleString()}</td>
      </tr>`;
    }).join('');

    tableBody.innerHTML = rows || '<tr><td colspan="5" class="empty-row">No allocations tracked yet.</td></tr>';

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
    statRss.textContent  = `RSS: ${formatBytes(data.rss)}`;
    statHeap.textContent = `Heap: ${formatBytes(data.heap)}`;
    statPeak.textContent = `Peak: ${formatBytes(data.peak)}`;

    // Chart
    chartData.push({ ts: data.ts, rss: data.rss });
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
