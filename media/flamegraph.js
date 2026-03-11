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
  let altPressed = false;
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
  };

  window.addEventListener('resize', () => {
    chart.width(graphContainer.clientWidth || 1000);
    render();
  });

  window.addEventListener('keydown', (event) => {
    altPressed = Boolean(event.altKey);
  });
  window.addEventListener('keyup', (event) => {
    altPressed = Boolean(event.altKey);
  });
  window.addEventListener('blur', () => {
    altPressed = false;
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
