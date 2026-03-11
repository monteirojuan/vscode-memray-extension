(function () {
  const data = window.__MEMRAY_FLAMEGRAPH_DATA__;
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

  const graphContainer = document.getElementById('flamegraph');
  const searchBox = document.getElementById('searchBox');
  const resetZoomBtn = document.getElementById('resetZoomBtn');
  const hideIrrelevant = document.getElementById('hideIrrelevant');
  const hideImportSystem = document.getElementById('hideImportSystem');
  const threadFilter = document.getElementById('threadFilter');
  const summaryContent = document.getElementById('summaryContent');
  const frameInfo = document.getElementById('frameInfo');
  let altPressed = false;
  let hoveredNode = null;

  const hasSource = (node) => {
    const n = node && node.data ? node.data : node;
    if (!n || !n.file || n.line <= 0) return false;
    // filter virtual Python paths: <unknown>, <frozen ...>, <string>, <stdin>, etc.
    if (n.file.startsWith('<') || n.file === 'memray') return false;
    return true;
  };

  const updateFrameInfo = () => {
    if (!hoveredNode) {
      frameInfo.textContent = '';
      frameInfo.className = 'frame-info';
      return;
    }
    const n = hoveredNode.data ? hoveredNode.data : hoveredNode;
    const fn = n.function || n.name || '';
    const src = hasSource(n) ? `${n.file}:${n.line}` : null;
    if (src) {
      frameInfo.className = 'frame-info has-source';
      const actionHint = altPressed ? '↵ Alt+Click to open' : 'Alt+Click to open source';
      frameInfo.textContent = `${fn}  —  ${src}  —  ${actionHint}`;
    } else {
      frameInfo.className = 'frame-info';
      frameInfo.textContent = fn ? `${fn}  —  no source available` : '';
    }
  };

  const bindFrameHovers = () => {
    window.d3.selectAll('#flamegraph .frame')
      .on('mouseover.memray', function (d) {
        hoveredNode = d;
        updateFrameInfo();
        if (hasSource(d)) {
          this.style.cursor = altPressed ? 'alias' : 'zoom-in';
        } else {
          this.style.cursor = 'zoom-in';
        }
      })
      .on('mouseout.memray', function () {
        hoveredNode = null;
        updateFrameInfo();
        this.style.cursor = '';
      })
      .on('mousemove.memray', function (d) {
        if (hasSource(d)) {
          this.style.cursor = altPressed ? 'alias' : 'zoom-in';
        }
      });
  };
  const flamegraphFactory = typeof window.flamegraph === 'function'
    ? window.flamegraph
    : (window.d3 && typeof window.d3.flamegraph === 'function' ? window.d3.flamegraph : undefined);

  if (!graphContainer || !data || typeof window.d3 !== 'object' || typeof flamegraphFactory !== 'function') {
    if (graphContainer) {
      const reasons = [];
      if (!data) reasons.push('missing flamegraph data');
      if (typeof window.d3 !== 'object') reasons.push('missing d3');
      if (typeof flamegraphFactory !== 'function') reasons.push('missing d3-flame-graph');
      graphContainer.textContent = `Unable to render flamegraph.${reasons.length ? ` (${reasons.join(', ')})` : ''}`;
    }
    return;
  }

  const formatBytes = (value) => {
    if (!Number.isFinite(value) || value < 0) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    const decimals = index === 0 ? 0 : 1;
    return `${size.toFixed(decimals)} ${units[index]}`;
  };

  const setSummary = () => {
    const summary = data.summary || {};
    summaryContent.innerHTML = [
      `<div><strong>Peak:</strong> ${formatBytes(summary.peakMemoryBytes || 0)}</div>`,
      `<div><strong>Total allocations:</strong> ${summary.totalAllocations || 0}</div>`,
      `<div><strong>Total bytes:</strong> ${formatBytes(summary.totalBytesAllocated || 0)}</div>`,
      `<div><strong>Duration:</strong> ${summary.durationMs || 0} ms</div>`,
      `<div><strong>Script:</strong> ${data.script || 'unknown'}</div>`
    ].join('');
  };

  const chart = flamegraphFactory()
    .width(graphContainer.clientWidth || 1000)
    .cellHeight(18)
    .transitionDuration(300)
    .minFrameSize(1)
    .title('')
    .tooltip(false)
    .onClick((node) => {
      if (!altPressed) {
        return;
      }
      const payloadNode = node && node.data ? node.data : node;
      if (!payloadNode || !payloadNode.file || !payloadNode.line || !vscode) {
        return;
      }
      vscode.postMessage({ type: 'openSource', file: payloadNode.file, line: payloadNode.line });
    });

  const populateThreadFilter = () => {
    const threads = Array.isArray(data.threads) ? data.threads : [];
    for (const thread of threads) {
      const option = document.createElement('option');
      option.value = thread.id;
      option.textContent = thread.label || thread.id;
      threadFilter.appendChild(option);
    }
  };

  const cloneNode = (node) => ({ ...node, children: (node.children || []).map(cloneNode) });

  const applyFilters = (node, activeThreadId, filterIrrelevant, filterImportSystem) => {
    const children = (node.children || [])
      .map((child) => applyFilters(child, activeThreadId, filterIrrelevant, filterImportSystem))
      .filter(Boolean);

    const threadMatch = !activeThreadId || node.threadId === activeThreadId;
    const irrelevantMatch = !filterIrrelevant || node.interesting !== false;
    const importSystemMatch = !filterImportSystem || node.importSystem !== true;
    const keep = (threadMatch && irrelevantMatch && importSystemMatch) || children.length > 0 || node.name === '<root>';

    if (!keep) {
      return null;
    }

    return { ...node, children };
  };

  const render = () => {
    const activeThreadId = threadFilter.value || '';
    const filtered = applyFilters(cloneNode(data.d3Data), activeThreadId, hideIrrelevant.checked, hideImportSystem.checked);
    if (!filtered) {
      graphContainer.innerHTML = '<p>No frames match the selected filters.</p>';
      return;
    }
    graphContainer.innerHTML = '';
    window.d3.select(graphContainer).datum(filtered).call(chart);
    if (searchBox.value) {
      chart.search(searchBox.value);
    }
    bindFrameHovers();
  };

  window.addEventListener('resize', () => {
    chart.width(graphContainer.clientWidth || 1000);
    render();
  });

  window.addEventListener('keydown', (event) => {
    altPressed = Boolean(event.altKey);
    updateFrameInfo();
    if (altPressed && hoveredNode && hasSource(hoveredNode)) {
      const frames = document.querySelectorAll('#flamegraph .frame');
      frames.forEach(f => { f.style.cursor = 'alias'; });
    }
  });
  window.addEventListener('keyup', (event) => {
    altPressed = Boolean(event.altKey);
    updateFrameInfo();
    if (!altPressed) {
      const frames = document.querySelectorAll('#flamegraph .frame');
      frames.forEach(f => { f.style.cursor = ''; });
    }
  });
  window.addEventListener('blur', () => {
    altPressed = false;
    updateFrameInfo();
  });

  searchBox.addEventListener('input', () => {
    chart.search(searchBox.value);
  });
  resetZoomBtn.addEventListener('click', () => {
    chart.resetZoom();
  });
  hideIrrelevant.addEventListener('change', render);
  hideImportSystem.addEventListener('change', render);
  threadFilter.addEventListener('change', render);

  populateThreadFilter();
  setSummary();
  render();
})();
