let getMessage = function(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
};

let customI18nDefined = false;

if (typeof customI18n !== 'undefined' && customI18n && 
  typeof customI18n.init === 'function' && 
  typeof customI18n.getMessage === 'function') {

  customI18nDefined = true;
  getMessage = function(key, substitutions = []) {
    return customI18n.getMessage(key, substitutions);
  };
}

function extractHostname(url) {
  if (!url) return '';
  
  let hostname = url.replace(/^https?:\/\//, '');
  hostname = hostname.split('/')[0].split(':')[0];
  
  return hostname || url;
}

let currentServerId = null;
let servers = [];
let currentServer = null;
let serverStatusCache = new Map();

async function loadServers() {
  const data = await chrome.storage.sync.get(['servers', 'currentServerId']);
  servers = data.servers || [];
  currentServerId = data.currentServerId || null;
  
  await updateServerDropdown();
  
  if (currentServerId) {
    currentServer = servers.find(s => s.id === currentServerId);
    return currentServer;
  }
  return null;
}

async function checkAllServersStatusInDropdown() {
  for (const server of servers) {
    const dropdownItem = document.querySelector(`.dropdown-item[data-server-id="${server.id}"]`);
    if (!dropdownItem) continue;
    
    const statusBadge = dropdownItem.querySelector('.dropdown-status');
    if (statusBadge) {
      statusBadge.textContent = getMessage('checkingStatus');
      statusBadge.className = 'dropdown-status checking';
      setServerStatus(server.id, 'checking');
    }
    
    try {
      let status = 'disconnected';

      checkServerConnection(server.id).then(result => {
        status = result.success ? 
          (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
          'disconnected';
        
        setServerStatus(server.id, status);
        if (server.id === currentServerId) { 
          updateCurrentServerStatus(status);
        } 
        if (statusBadge) {
          statusBadge.textContent = getMessage(status + 'Status');
          statusBadge.className = `dropdown-status ${status}`;
        }
      });
    } catch (error) {
      setServerStatus(server.id, 'disconnected');
      if (statusBadge) {
        statusBadge.textContent = getMessage('disconnectedStatus');
        statusBadge.className = 'dropdown-status disconnected';
      }
    }
  }
}

function initCustomSelect() {
  const selectHeader = document.getElementById('selectHeader');
  const selectDropdown = document.getElementById('selectDropdown');
  
  selectHeader.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = selectHeader.parentElement.classList.contains('open');
    
    if (isOpen) {
      selectHeader.parentElement.classList.remove('open');
    } else {
      selectHeader.parentElement.classList.add('open');
      loadServers().then(() => {
        checkAllServersStatusInDropdown();
      });
    }
  });
  
  document.addEventListener('click', () => {
    selectHeader.parentElement.classList.remove('open');
  });
  
  selectDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

async function updateServerDropdown() {
  const dropdownList = document.getElementById('serverDropdownList');
  const selectedServerText = document.getElementById('selectedServerText');
  const currentServerStatus = document.getElementById('currentServerStatus');
  
  if (!dropdownList) return;
  
  dropdownList.innerHTML = '';
  
  if (currentServer) {
    const displayName = currentServer.name || extractHostname(currentServer.qbitUrl) || getMessage('unnamedServer');
    selectedServerText.textContent = displayName;
    currentServerStatus.textContent = getMessage('checkingStatus');
    currentServerStatus.className = 'status-area checking';
  } else {
    selectedServerText.textContent = getMessage('selectServer');
    currentServerStatus.textContent = getMessage('unknownStatus');
    currentServerStatus.className = 'status-area unknown';

    if(servers.length === 0){
      const dropdownItem = document.createElement('div');
      dropdownItem.className = 'dropdown-item';
      const displayName = getMessage('addServer');
    
      dropdownItem.innerHTML = `
        <span class="server-name">${displayName}</span>
      `;
      dropdownList.appendChild(dropdownItem);
      dropdownItem.addEventListener('click', async () => {document.getElementById('openOptions').click();});
    }
  }
  
  servers.forEach(server => {
    const dropdownItem = document.createElement('div');
    dropdownItem.className = 'dropdown-item';
    if (server.id === currentServerId) {
      dropdownItem.classList.add('selected');
    }
    dropdownItem.dataset.serverId = server.id;
    
    const displayName = server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer');
    
    dropdownItem.innerHTML = `
      <span class="server-name">${displayName}</span>
      <span class="dropdown-status checking">${getMessage('checkingStatus')}</span>
    `;
    
    dropdownItem.addEventListener('click', async () => {
      await switchToServer(server.id);
      document.querySelector('.custom-select').classList.remove('open');
    });
    
    dropdownList.appendChild(dropdownItem);
  });
}

let switchServerAbortController = null;

async function switchToServer(serverId) {
  if (switchServerAbortController) {
    switchServerAbortController.abort();
    switchServerAbortController = null;
  }
  
  const downloadsSection = document.getElementById('downloadsSection');
  if (downloadsSection) {
    downloadsSection.style.display = 'none';
  }
  
  try {
    switchServerAbortController = new AbortController();
    const signal = switchServerAbortController.signal;
    
    const response = await chrome.runtime.sendMessage({
      action: 'switchServer',
      serverId: serverId
    });
    
    if (signal.aborted) {
      return;
    }
    
    if (response?.success) {
      currentServerId = serverId;
      
      currentServer = servers.find(s => s.id === serverId);
      if (currentServer) {
        updateSelectedServerDisplay(currentServer);
      }
      
      const result = await checkServerConnection(serverId, signal);
      
      if (signal.aborted || result.aborted) {
        return;
      }

      const isConnected = result.status === 'connected';

      if (isConnected) {
        refreshDownloads();
        updateSpeedLimitDisplay();
      }
    } else {
      throw new Error(response?.error || 'Switch failed');
    }
  } catch (error) {
    console.error('Switch server error:', error);
    updateSelectedServerDisplay(currentServer);
    alert('Switch server error:', error);
  } finally {
    switchServerAbortController = null;
  }
}

async function updateCurrentServerStatus(status) {
  const server = currentServer;
  if (!server) return;
  
  const selectedServerText = document.getElementById('selectedServerText');
  if (selectedServerText) {
    selectedServerText.textContent = server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer');
  }
  
  const statusElement = document.getElementById('currentServerStatus');
  if (statusElement) {
    statusElement.textContent = getMessage('checkingStatus');
    statusElement.className = 'status-area checking';
  }
  
  try {
    if (status === undefined) {
      const result = await checkServerConnection(server.id);
      status = result.success ? 
        (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
        'disconnected';
      setServerStatus(currentServerId, status);
    }
    if (statusElement) {
      statusElement.textContent = getMessage(status + 'Status');
      statusElement.className = `status-area ${status}`;
    }
    
    return status === 'connected';
  } catch (error) {
    setServerStatus(currentServerId, 'disconnected');
    if (statusElement) {
      statusElement.textContent = getMessage('disconnectedStatus');
      statusElement.className = 'status-area disconnected';
    }
    return false;
  }
}

function updateSelectedServerDisplay(server) {
  const selectedServerText = document.getElementById('selectedServerText');
  if (selectedServerText && server) {
    const displayName = server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer');
    selectedServerText.textContent = displayName;
  }
  
  document.querySelectorAll('.dropdown-item').forEach(item => {
    if (item.dataset.serverId === server.id) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });
}

function setServerStatus(serverId, status) {
  serverStatusCache.set(serverId, status);
  
  if (serverId === currentServerId) {
    const currentServerStatus = document.getElementById('currentServerStatus');
    const status = serverStatusCache.get(currentServerId) || 'unknown';
    const statusText = getMessage(status + 'Status') || status;
    
    if (currentServerStatus) {
      currentServerStatus.textContent = statusText;
      currentServerStatus.className = `status-area ${status}`;
      
      if (statusText.length > 6) {
        currentServerStatus.style.minWidth = '70px';
      } else {
        currentServerStatus.style.minWidth = '60px';
      }
    }
  }
}

let connectionCheckPromise = null;

async function checkServerConnection(serverId = currentServerId, abortSignal = null) {
  const server = servers.find(s => s.id === serverId);
  if (!server) {
    return {
      success: false,
      authenticated: false,
      error: getMessage('serverNotFound'),
      status: 'disconnected'
    };
  }

  if (serverId === currentServerId) {
    setServerStatus(serverId, abortSignal ? serverStatusCache.get(serverId) : 'checking');
  }

  if (serverId === currentServerId && connectionCheckPromise && !abortSignal) {
    return await connectionCheckPromise;
  }

  const checkPromise = (async () => {
    try {
      if (serverId === currentServerId) {
        const cachedStatus = serverStatusCache.get(serverId);
        if (cachedStatus === 'connected') {
          try {
            const response = await chrome.runtime.sendMessage({
              action: 'verifySession',
              serverId: serverId
            });
            if (response?.valid) {
              const result = {
                success: true,
                authenticated: true,
                quickCheck: true,
                status: 'connected'
              };
              setServerStatus(serverId, 'connected');
              return result;
            }
          } catch {}
        }
      }

      if (abortSignal?.aborted) {
        return {
          success: false,
          aborted: true,
          status: 'aborted'
        };
      }

      let response;
      if (serverId === currentServerId) {
        response = await chrome.runtime.sendMessage({
          action: 'testConnection'
        });
      } else {
        response = await chrome.runtime.sendMessage({
          action: 'testServerConnectionDirect',
          server: server
        });
      }

      if (abortSignal?.aborted) {
        return {
          success: false,
          aborted: true,
          status: 'aborted'
        };
      }
      
      if (response?.success) {
        const status = response.success ? 
          (response.authenticated || !response.canLogin ? 'connected' : 'needs-auth') : 
          'disconnected';
        const result = {
          success: true,
          authenticated: response.authenticated || false,
          version: response.version,
          status: status
        };
        setServerStatus(serverId, status);

        return result;
      } else {
        setServerStatus(serverId, 'disconnected');
        const result = {
          success: false,
          authenticated: false,
          error: response?.error || getMessage('unknownError'),
          status: 'disconnected'
        };

        return result;
      }
    } catch (error) {
      setServerStatus(serverId, 'disconnected');
      const result = {
        success: false,
        authenticated: false,
        error: error.message || getMessage('communicationError'),
        status: 'disconnected'
      };

      return result;
    }
  })();

  if (serverId === currentServerId) {
    connectionCheckPromise = checkPromise;
    try {
      const result = await checkPromise;
      return result;
    } finally {
      setTimeout(() => {
        if (connectionCheckPromise === checkPromise) {
          connectionCheckPromise = null;
        }
      }, 0);
    }
  }

  return await checkPromise;
}

function refreshDownloads() {
  const refreshBtn = document.getElementById('manualRefresh');
  if (refreshBtn) {
    refreshBtn.classList.add('refreshing');
  }
  
  chrome.runtime.sendMessage({ 
    action: 'refreshDownloads',
    force: true 
  }, () => {
    updateSpeedLimitDisplay();
    if (refreshBtn) {
      setTimeout(() => {
        refreshBtn.classList.remove('refreshing');
      }, 500);
    }
  });
}

function localizePage() {
  document.querySelectorAll('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    const message = getMessage(key);
    if (message) {
      element.textContent = message;
    }
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
    const key = element.getAttribute('data-i18n-placeholder');
    const message = getMessage(key);
    if (message) {
      element.placeholder = message;
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    const message = getMessage(key);
    if (message) {
      element.title = message;
    }
  });
}

function formatSpeed(bytesPerSecond) {
  if (bytesPerSecond === 0) return '0 B/s';
  
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let speed = bytesPerSecond;
  let unitIndex = 0;
  
  while (speed >= 1024 && unitIndex < units.length - 1) {
    speed /= 1024;
    unitIndex++;
  }
  
  return `${speed.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

let currentDownloads = [];
let lastUpdateTime = null;

function updateDownloadsUI(downloads, activeCount, operateItemHash) {
  currentDownloads = downloads || [];
  const downloadsSection = document.getElementById('downloadsSection');
  const downloadsList = document.getElementById('downloadsList');
  const downloadCount = document.getElementById('downloadCount');
  
  if (!downloadsSection || !downloadsList) return;

  downloadsList.innerHTML = '';

  if (activeCount > 0) {
    downloadsSection.style.display = 'block';
    
    if (downloadCount) {
      if (activeCount > 0) {
        downloadCount.innerHTML = `
          <span class="count-number active">${activeCount}</span>
        `;
        downloadCount.classList.add('active');
      }
    }

    const statusStats = {
      downloading: { count: 0, label: getMessage('downloading') || 'Downloading', color: '#0078d4', class: 'status-downloading' },
      paused: { count: 0, label: getMessage('paused') || 'Paused', color: '#ff8c2e', class: 'status-paused' },
      seeding: { count: 0, label: getMessage('seeding') || 'Seeding', color: '#28a745', class: 'status-seeding' },
      checking: { count: 0, label: getMessage('checking') || 'Checking', color: '#6f42c1', class: 'status-checking' },
      queued: { count: 0, label: getMessage('queued') || 'Queued', color: '#a9cf4aff', class: 'status-queued' },
      error: { count: 0, label: getMessage('error') || 'Error', color: '#ff0000', class: 'status-error' },
      other: { count: 0, label: getMessage('other') || 'Other', color: '#495057', class: 'status-other' }
    };

    const getDownloadStatus = (download) => {
      const isPaused = download.isPaused || download.state.includes('paused') || download.state.includes('stopped');
      const isDownloading = download.isDownloading;
      const isQueued = download.state === 'queued' || download.state === 'stalledDL';
      const isSeeding = download.state === 'uploading' || download.state === 'stalledUP';
      const isChecking = download.state === 'checking';
      const isError = download.isError;
      
      if (isDownloading) return 'downloading';
      if (isPaused) return 'paused';
      if (isSeeding) return 'seeding';
      if (isChecking) return 'checking';
      if (isQueued) return 'queued';
      if (isError) return 'error';
      return 'other';
    };
    
    const getPriority = (download) => {
      if (download.isDownloading) return 1;
      if (download.isPaused) return 2;
      if (download.isError) return 0;
      if (download.state === 'queued') return 1;
      if (download.state === 'stalledDL') return 1;
      if (download.state === 'uploading') return 4;
      if (download.state === 'stalledUP') return 4;
      if (download.state === 'checking') return 5;
      return 6;
    };
    
    const sortedDownloads = [...downloads].sort((a, b) => {
      const priorityA = getPriority(a);
      const priorityB = getPriority(b);
      
      if (priorityA === priorityB) {
        if (a.progress !== b.progress) {
          return b.progress - a.progress;
        }
        if (a.downloadSpeed !== b.downloadSpeed) {
          return b.downloadSpeed - a.downloadSpeed;
        }
      }
      
      return priorityA - priorityB;
    });

    const maxDisplay = 5;
    
    sortedDownloads.forEach((download, index) => {
      const status = getDownloadStatus(download);
      statusStats[status].count++;

      if (index < maxDisplay) {
        const statusText = getMessage(status) || download.state;
        const statusClass = 'status-' + status;
        const isPaused = status === 'paused';

        const downloadItem = document.createElement('div');
        downloadItem.className = `download-item ${status === 'downloading' ? 'downloading' : ''} ${isPaused ? 'paused' : ''}`;
        downloadItem.dataset.hash = download.hash || `temp-${index}`;
        downloadItem.dataset.status = status;
        
        const forceShowBtn = operateItemHash === download.hash;
        const progressPercent = (download.progress * 100).toFixed(1);
        const downloadSpeed = isPaused ? '0 B/s' : formatSpeed(download.downloadSpeed);
        const uploadSpeed = isPaused ? '0 B/s' : formatSpeed(download.uploadSpeed);
        const downloadSize = formatSize(download.size);
        const downloaded = formatSize(download.downloaded);

        const pauseText = getMessage('pause') || 'Pause';
        const resumeText = getMessage('resume') || 'Resume';
        const deleteText = getMessage('delete') || 'Delete';
        
        downloadItem.innerHTML = `
          <div class="download-name" title="${download.name}">
            ${download.name.substring(0, 40)}${download.name.length > 40 ? '...' : ''}
          </div>
          <div class="progress-container">
            <div class="progress-bar" style="width: ${progressPercent}%"></div>
          </div>
          <div class="progress-text">
            <span>${progressPercent}%</span>
            <span>${downloaded} / ${downloadSize}</span>
          </div>
          <div class="speed-info">
            <label class="sequential-toggle" title="${getMessage("sequentialDownloadTooltip")}">
              <span class="sequential-label" data-i18n="sequentialDownload">${getMessage("sequentialDownload") || "Sequential Download"}</span>
              <span class="sequential-switch">
                <input type="checkbox" class="sequential-toggle-checkbox" data-hash="${download.hash}" ${download.seqDownload ? 'checked' : ''}>
                <span class="sequential-slider"></span>
              </span>
            </label>
            <span>↑ ${uploadSpeed}&emsp;↓ ${downloadSpeed}</span>
            <span class="status-text ${statusClass}">${statusText}</span>
          </div>
          <div class="download-actions${forceShowBtn ? ' force-show' : ''}">
            ${isPaused ? 
              `<button class="action-btn resume-btn" data-action="resume">${resumeText}</button>` : 
              `<button class="action-btn pause-btn" data-action="pause">${pauseText}</button>`
            }
            <button class="action-btn delete-btn" data-action="delete">${deleteText}</button>
          </div>
        `;
        
        forceShowBtn && setTimeout(() => {
          const actionsContainer = downloadItem.querySelector('.download-actions');
          actionsContainer.classList.remove('force-show');
        }, 0);
        downloadsList.appendChild(downloadItem);
      }
    });
    
    const oldStatusBar = document.querySelector('.status-bar-container');
    if (oldStatusBar) {
      oldStatusBar.remove();
    }
    
    const statusSegments = [];
    let totalWidth = 0;

    Object.entries(statusStats).forEach(([statusKey, statusInfo]) => {
      if (statusInfo.count > 0) {
        const percentage = (statusInfo.count / activeCount) * 100;
        const width = Math.max(percentage, 5);
        statusSegments.push({
          key: statusKey,
          count: statusInfo.count,
          label: statusInfo.label,
          color: statusInfo.color,
          class: statusInfo.class,
          width: width,
          originalPercentage: percentage
        });
        totalWidth += width;
      }
    });
    
    if (totalWidth > 100) {
      statusSegments.forEach(segment => {
        segment.width = (segment.width / totalWidth) * 100;
      });
    }
    
    if (statusSegments.length > 0) {
      const statusBarContainer = document.createElement('div');
      statusBarContainer.className = 'status-bar-container';

      const statusBarInner = document.createElement('div');
      statusBarInner.className = 'status-bar-inner';
      
      const statusBarHTML = statusSegments.map((segment, index) => `
        <div class="status-bar-segment ${segment.class}" 
             data-status-key="${segment.key}"
             data-count="${segment.count}"
             data-label="${segment.label}"
             style="width: ${segment.width}%; background-color: ${segment.color}; ${index > 0 ? 'border-left: 1px solid rgba(255,255,255,0.3);' : ''}">
        </div>
      `).join('');
      
      statusBarContainer.innerHTML = statusBarHTML;
      
      downloadsList.parentNode.insertBefore(statusBarContainer, downloadsList);

      let currentHighlightIndex = -1;
      let currentStatusKey = null;
      let clearHighlight = null;

      statusBarContainer.addEventListener('click', function(e) {
        clearTimeout(clearHighlight);
        const segment = e.target.closest('.status-bar-segment');
        if (!segment) return;
        
        const statusKey = segment.dataset.statusKey;
        
        if (statusKey !== currentStatusKey) {
          currentStatusKey = statusKey;
          currentHighlightIndex = -1;
        }
        
        const matchingItems = Array.from(document.querySelectorAll('.download-item'))
          .filter(item => item.dataset.status === statusKey);
        if (matchingItems.length === 0) return;
        
        currentHighlightIndex = (currentHighlightIndex + 1) % matchingItems.length;
        
        document.querySelectorAll('.download-item.highlighted').forEach(item => {
          item.classList.remove('highlighted');
        });
        
        const targetItem = matchingItems[currentHighlightIndex];
        targetItem.classList.add('highlighted');
        clearHighlight = setTimeout(() => {targetItem.classList.remove('highlighted')}, 3000);
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      
      statusBarContainer.querySelectorAll('.status-bar-segment').forEach(segment => {
        segment.addEventListener('mouseenter', function(e) {
          const tooltip = document.querySelector('.status-bar-tooltip') || document.createElement('div');
          const isNewTip = !tooltip.className;
          tooltip.className = 'status-bar-tooltip';
          tooltip.textContent = `${this.dataset.label}: ${this.dataset.count}`;
          tooltip.style.position = 'fixed';
          tooltip.style.top = (e.clientY - 30) + 'px';
          tooltip.style.transform = 'translateX(-50%)';
          tooltip.style.left = e.clientX + 'px';
          isNewTip && document.body.appendChild(tooltip);
          this._tooltip = tooltip;
        });

        segment.addEventListener('mousemove', function(e) {
          if (this._tooltip) {
            this._tooltip.style.top = (e.clientY - 30) + 'px';
            this._tooltip.style.left = e.clientX + 'px';
          }
        });

        segment.addEventListener('mouseleave', function() {
          if (this._tooltip) {
            this._tooltip.remove();
            this._tooltip = null;
          }
        });
      });
    }
    
    if (downloads.length > maxDisplay) {
      const remainingCount = downloads.length - maxDisplay;
      const moreText = getMessage('viewMore', [remainingCount]) || `View all ${remainingCount}...`;
      
      const moreItem = document.createElement('div');
      moreItem.className = 'download-more';
      moreItem.style.textAlign = 'center';
      moreItem.style.padding = '8px';
      moreItem.style.color = '#666';
      moreItem.style.fontSize = '12px';
      moreItem.style.cursor = 'pointer';
      moreItem.textContent = moreText;
      moreItem.title = getMessage('openWebUI') || 'Open qBittorrent WebUI';
      moreItem.addEventListener('click', () => {
        if (currentServer?.qbitUrl) {
          chrome.tabs.create({ url: currentServer.qbitUrl });
        }
      });
      downloadsList.appendChild(moreItem);
    }
    
  } else {
    downloadsSection.style.display = 'none';
    if (downloadCount) {
      downloadCount.textContent = '(0)';
    }
  }
}

function updateRefreshIntervalDisplay(intervalMs) {
  const intervalEl = document.querySelector('.refresh-interval');
  const autoRefreshToggle = document.getElementById('autoRefreshToggle');
  if (!intervalEl) return;
  
  const seconds = intervalMs / 1000;
  if (seconds === 0) {
    intervalEl.textContent = getMessage('noRefresh') || 'Off';
  } else if (!autoRefreshToggle.checked) {
    intervalEl.textContent = getMessage('autoRefreshOff') || 'Off';
  } else if (seconds < 60) {
    intervalEl.textContent = getMessage(seconds === 1 ? 'refreshIntervalShortSingular' : 'refreshIntervalShortPlural', [seconds]) || `${seconds}s`;
  } else {
    const minutes = seconds / 60;
    intervalEl.textContent = getMessage(minutes === 1 ? 'refreshIntervalMinSingular' : 'refreshIntervalMinPlural', [minutes]) || `${minutes}m`;
  }
}

function updateLastUpdateTime(timestamp) {
  const lastUpdatedEl = document.querySelector('.last-updated');
  if (!lastUpdatedEl || !timestamp) {
    lastUpdatedEl.textContent = '';
    return;
  }
  
  const now = new Date();
  const lastUpdate = new Date(timestamp);
  const diff = Math.floor((now - lastUpdate) / 1000);
  
  if (diff < 60) {
    lastUpdatedEl.textContent = getMessage('justNow') || 'Just now';
  } else {
    const minutes = Math.floor(diff / 60);
    lastUpdatedEl.textContent = getMessage('minutesAgo', [minutes]) || `${minutes}m ago`;
  }
}

async function updateSpeedLimitDisplay() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getSpeedLimits'
    });

    if (response?.success) {
      const downloadLimitEl = document.getElementById('downloadLimit');
      const uploadLimitEl = document.getElementById('uploadLimit');
      const toggle = document.getElementById('speedLimitToggle');
      
      if (downloadLimitEl) {
        downloadLimitEl.textContent = response.downloadLimitDisplay;
      }
      
      if (uploadLimitEl) {
        uploadLimitEl.textContent = response.uploadLimitDisplay;
      }

      if (toggle) {
        const isEnabled = response.isEnabled;
        if (isEnabled) {
          toggle.classList.add('active');
        } else {
          toggle.classList.remove('active');
        }
      }
    }
  } catch (error) {
    console.error('Failed to get speed limits:', error);
  }
}

async function toggleSpeedLimitMode(enabled) {
  const toggle = document.getElementById('speedLimitToggle');
  const originalState = toggle.classList.contains('active');
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'toggleSpeedLimit',
      enabled: enabled
    });
    
    if (response?.success && response.isEnabled !== undefined) {
      const actuallyEnabled = response.isEnabled;
      
      if (actuallyEnabled === enabled) {
        updateSpeedLimitDisplay();
      } else {
        toggle.classList.toggle('active');
      }
    } else {
      if (toggle.classList.contains('active') === originalState) {
        toggle.classList.toggle('active');
      }
      alert(`Failed to toggle: ${response?.error || 'Unknown error'}`);
    }
  } catch (error) {
    if (toggle.classList.contains('active') === originalState) {
      toggle.classList.toggle('active');
    }
    console.error('Failed to toggle speed limit:', error);
  }
}

async function setSpeedLimitValues(downloadLimit, uploadLimit, isAltSpeed) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'setSpeedLimitValues',
      downloadLimit: downloadLimit,
      uploadLimit: uploadLimit,
      isAltSpeed: isAltSpeed
    });
    
    if (response?.success) {
      updateSpeedLimitDisplay();
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to set speed limit values:', error);
    return false;
  }
}

function updateDownloadsUIfromCache() {
  chrome.runtime.sendMessage({ 
    action: 'getDownloadStatus' 
  }, (response) => {
    if (response?.success) {
      updateDownloadsUI(response.downloads, response.activeCount);
      
      if (response.lastUpdateTime) {
        updateLastUpdateTime(response.lastUpdateTime);
      } else {
        if (response.downloads && response.downloads.length > 0) {
          updateLastUpdateTime(new Date().toISOString());
        } else {
          updateLastUpdateTime(null);
        }
      }
    }
  });
}

function getCurrentInterval(){
  chrome.runtime.sendMessage({ action: 'getCurrentInterval' }, (response) => {
    if (response.interval !== undefined) {
      updateRefreshIntervalDisplay(response.interval);
    }
  });
}

async function quickAddMagnet() {
  const input = document.getElementById('magnetInput');
  let magnetLink = input.value.trim();
  
  if (!magnetLink) {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (clipboardText.includes('magnet:')) {
        magnetLink = clipboardText;
      }
    } catch (error) {
      console.log('Cannot read clipboard');
    }
  }
  
  if (!magnetLink) {
    alert(getMessage('enterMagnetLink'));
    return;
  }
  
  if (!magnetLink.startsWith('magnet:')) {
    alert(getMessage('enterValidMagnet'));
    return;
  }
  

  if (!currentServer?.qbitUrl) {
    alert(getMessage('setAddressFirstPopup'));
    document.getElementById('openOptions').click();
    return;
  }
  
  chrome.runtime.sendMessage({
    action: 'addMagnet',
    magnetLink: magnetLink
  }, (response) => {
    if (response?.success) {
      this.textContent = getMessage('magnetAddedSuccess');
      this.classList.add('success');
      setTimeout(()=>{
        this.textContent = getMessage('quickAddBtn');
        this.classList.remove('success');
      }, 2000);
      input.value = '';
      tempClipboardValue = '';
    } else {
      alert('❌ ' + getMessage('addFailedPopup'));
    }
  });
}

async function pauseAllDownloads() {
  if (!currentDownloads || currentDownloads.length === 0) {
    alert(getMessage('noDownloadsToPause') || 'No downloads to pause');
    return;
  }
  
  const pauseAllBtn = document.getElementById('pauseAllBtn');
  pauseAllBtn.classList.add('processing');
  pauseAllBtn.disabled = true;
  
  const hashes = currentDownloads.map(d => d.hash).join('|');
  const originalDownloads = [...currentDownloads];
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'pauseAllDownloads',
      hashes: hashes
    });
    
    if (response?.success) {
      const refreshResponse = await waitForStatusChange(originalDownloads, 'pause');
      updateDownloadsUI(refreshResponse.downloads, refreshResponse.activeCount);
    }
  } catch (error) {
    console.error('Batch pause failed:', error);
  } finally {
    restoreBatchOperationButtons();
  }
}

async function resumeAllDownloads() {
  if (!currentDownloads || currentDownloads.length === 0) {
    alert(getMessage('noDownloadsToResume') || 'No downloads to resume');
    return;
  }
  
  const pausedDownloads = currentDownloads.filter(d => d.isPaused);
  if (pausedDownloads.length === 0) {
    alert(getMessage('noPausedDownloads') || 'No paused downloads');
    return;
  }
  
  const resumeAllBtn = document.getElementById('resumeAllBtn');
  resumeAllBtn.classList.add('processing');
  resumeAllBtn.disabled = true;
  
  const hashes = pausedDownloads.map(d => d.hash).join('|');
  const originalDownloads = [...pausedDownloads];
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'resumeAllDownloads',
      hashes: hashes
    });
    
    if (response?.success) {
      const refreshResponse = await waitForStatusChange(originalDownloads, 'resume');
      updateDownloadsUI(refreshResponse.downloads, refreshResponse.activeCount);
    }
  } catch (error) {
    console.error('Batch resume failed:', error);
  } finally {
    restoreBatchOperationButtons();
  }
}

function restoreBatchOperationButtons() {
  const pauseAllBtn = document.getElementById('pauseAllBtn');
  const resumeAllBtn = document.getElementById('resumeAllBtn');
  
  if (pauseAllBtn) {
    pauseAllBtn.classList.remove('processing');
    pauseAllBtn.disabled = false;
  }
  
  if (resumeAllBtn) {
    resumeAllBtn.classList.remove('processing');
    resumeAllBtn.disabled = false;
  }
}

function waitForStatusChange(originalDownloads, actionType, maxRetries = 5) {
  return new Promise((resolve, reject) => {
    let retryCount = 0;
    
    const checkStatus = () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ 
          action: 'refreshDownloads',
          force: true,
          skipUpdateUI: true
        }, (refreshResponse) => {
          if (!refreshResponse?.downloads) {
            if (retryCount < maxRetries) {
              retryCount++;
              checkStatus();
            } else {
              reject(new Error('Timeout'));
            }
            return;
          }
          
          let allChanged = true;
          for (const original of originalDownloads) {
            const newItem = refreshResponse.downloads.find(d => d.hash === original.hash);
            if (newItem) {
              const expectedPaused = actionType === 'pause';
              if (newItem.isPaused !== expectedPaused) {
                allChanged = false;
                break;
              }
            }
          }
          
          if (allChanged || retryCount >= maxRetries) {
            resolve(refreshResponse);
          } else {
            retryCount++;
            checkStatus();
          }
        });
      }, 500);
    };
    
    checkStatus();
  });
}


function operateDownload(action, hash, btn) {
  const actionTexts = {
    pause: {
      processing: getMessage('pausing') || 'Pausing...',
      success: getMessage('pause') || 'Pause',
      fail: getMessage('pause') || 'Pause'
    },
    resume: {
      processing: getMessage('resuming') || 'Resuming...',
      success: getMessage('resume') || 'Resume',
      fail: getMessage('resume') || 'Resume'
    }
  };
  
  const texts = actionTexts[action] || { 
    processing: getMessage('processing') || 'Processing...',
    success: getMessage('success') || 'Done',
    fail: getMessage('fail') || 'Operation'
  };
  
  const originalText = btn.textContent;
  
  btn.textContent = texts.processing;
  btn.disabled = true;

  chrome.runtime.sendMessage({
    action: `${action}Download`,
    hash: hash
  }, (response) => {
    if (response?.success) {
      let retryCount = 0;
      const maxRetries = 3;
      const originalState = btn.classList.contains('pause-btn') ? 'active' : 'paused';
      const checkStatus = () => {
        setTimeout(() => {
          chrome.runtime.sendMessage({ 
            action: 'refreshDownloads',
            force: true,
            skipUpdateUI: true
          }, (refreshResponse) => {
            const targetDownload = refreshResponse.downloads?.find(d => d.hash === hash);
            const newState = targetDownload?.isPaused === true ? 'paused' : 'active';

            if (newState !== originalState || retryCount >= maxRetries) {
              updateDownloadsUI(refreshResponse.downloads, refreshResponse.activeCount, hash);
            } else {
              retryCount++;
              checkStatus();
            }
          });
        }, 500);
      };
      checkStatus();
    } else {
      const errorMessage = getMessage('addFailedDetail') || 'Failed: $1';
      alert(errorMessage.replace('$1', response?.error || getMessage('unknownError')));
      if (btn.parentNode) {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }
  });
}

function deleteDownload(hash, name) {
  const confirmMessage = getMessage('confirmDeleteMessage', [name]) || `Delete "${name}"?`;
  const deleteFilesText = getMessage('deleteFiles') || 'Delete files';
  const cancelText = getMessage('cancel') || 'Cancel';
  const deleteText = getMessage('delete') || 'Delete';
  const defaultDeleteFiles = currentServer?.defaultDeleteFiles || false;

  const modal = document.createElement('div');
  modal.className = 'delete-confirm-modal';
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-content">
        <div class="modal-message">${confirmMessage}</div>
        <label class="delete-files-option">
          <input type="checkbox" id="deleteFilesCheckbox" ${defaultDeleteFiles ? 'checked' : ''}>
          <span>${deleteFilesText}</span>
        </label>
        <div class="modal-buttons">
          <button id="cancelBtn" class="modal-btn cancel-btn">${cancelText}</button>
          <button id="confirmBtn" class="modal-btn confirm-btn">${deleteText}</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelector('#cancelBtn').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
  
  modal.querySelector('#confirmBtn').addEventListener('click', () => {
    const deleteFiles = modal.querySelector('#deleteFilesCheckbox').checked;
    
    chrome.runtime.sendMessage({
      action: 'deleteDownload',
      hash: hash,
      name: name,
      deleteFiles: deleteFiles
    }, (response) => {
      if (response?.success) {
        chrome.runtime.sendMessage({ 
          action: 'refreshDownloads',
          force: true
        });
      }
    });
    
    document.body.removeChild(modal);
  });
  
  modal.querySelector('.modal-overlay').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      document.body.removeChild(modal);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadStatusUpdate') {
    updateLastUpdateTime(request.lastUpdateTime);
    updateDownloadsUI(request.downloads, request.activeCount);
    sendResponse({ received: true });
  }

  if (request.action === 'refreshIntervalUpdate') {
    updateRefreshIntervalDisplay(request.interval);
  }

  if (request.action === 'switchServer') {
    switchToServer(request.serverId);
  }
});

document.addEventListener('DOMContentLoaded', async() => {
  customI18nDefined && await customI18n.init();
  localizePage();
  initCustomSelect();

  loadServers().then(currentServer => {
    if (currentServer) {
      updateCurrentServerStatus().then(isConnected => {
        if (isConnected) {
          updateDownloadsUIfromCache();
          getCurrentInterval();
          refreshDownloads();
        }
      });
    }
  });

  chrome.runtime.sendMessage({
    action: 'popupOpened'
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      chrome.runtime.sendMessage({
        action: 'popupClosed'
      });
    }
  });
 
  let tempClipboardValue = '';
  const magnetInput = document.getElementById('magnetInput');

  document.getElementById('hiddenInput').addEventListener('input', function() {
    tempClipboardValue = this.value;
    
    if (tempClipboardValue.trim().startsWith('magnet:')) {
      magnetInput.value = tempClipboardValue;
    }
    
    this.value = '';
  });

  document.getElementById('quickAdd').addEventListener('click', quickAddMagnet);
  
  document.getElementById('quickAdd').addEventListener('mouseenter', function() {
    const hiddenInput = document.getElementById('hiddenInput');
    
    if (!magnetInput.value.trim()) {
      hiddenInput.focus();
      document.execCommand('paste');
    }
  });

  document.getElementById('quickAdd').addEventListener('mouseleave', function() {
    if (magnetInput.value === tempClipboardValue) {
      magnetInput.value = '';
    }
    tempClipboardValue = '';
  });

  magnetInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('quickAdd').click();
    }
  });

  document.getElementById('clearInput').addEventListener('click', function() {
    magnetInput.value = '';
    tempClipboardValue = '';
  });

  document.getElementById('scanMagnet').addEventListener('click', async function() {
    const dropdown = document.getElementById('searchResultsDropdown');
    const resultsList = document.getElementById('searchResultsList');
    const resultsCount = document.getElementById('resultsCount');


    resultsList.innerHTML = '<div class="no-results">' + getMessage('scanningPage') + '...</div>';
    dropdown.classList.add('show');
    resultsCount.textContent = '0';
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab || !tab.id) {
        resultsList.innerHTML = '<div class="no-results">' + getMessage('noActiveTab') + '</div>';
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'scanMagnets'
      });
      
      if (response?.success && response.magnets?.length > 0) {
        const magnets = response.magnets;
        resultsCount.textContent = magnets.length;

        resultsList.innerHTML = '';
        magnets.forEach((magnet, index) => {
          const item = createMagnetResultItem(magnet, index);
          resultsList.appendChild(item);
        });
      } else {
        resultsList.innerHTML = '<div class="no-results">' + 
          (getMessage('noMagnetsFound') || 'No magnets found on this page') + 
          '</div>';
        resultsCount.textContent = '0';
      }
    } catch (error) {
      console.error('Scan error:', error);
      if (error.message.includes('Could not establish connection') || 
          error.message.includes('Receiving end does not exist')) {
        resultsList.innerHTML = '<div class="no-results">' + 
          getMessage('connectionError') + 
          '<br><small>' + getMessage('refreshPageTip') + '</small></div>';
      } else {
        resultsList.innerHTML = '<div class="no-results">' + 
          getMessage('scanFailed') + ': ' + (error.message || 'Unknown error') + 
          '</div>';
      }
      resultsCount.textContent = '0';
    }
  });

  function createMagnetResultItem(magnet, index) {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.dataset.index = index;
    let showLocateBtn = true;
    
    const displayName = magnet.link.match(/dn=([^&]+)/i)?.[1] || magnet.displayName || '';
    let decodedName = displayName ? decodeURIComponent(displayName) : '';
    if (decodedName === 'Decoded magnet link') {
      showLocateBtn = false;
      decodedName = getMessage('decodedMagnetLink') || decodedName;
    }

    item.innerHTML = `
      <div class="search-result-info">
        <div class="magnet-header">
          <div class="magnet-name ${!decodedName ? 'no-name' : ''}" title="${decodedName}">
            ${decodedName || getMessage('unnamedMagnet')}
          </div>
          ${magnet.size ? `<div class="magnet-size">${magnet.size}</div>` : ''}
        </div>
        <div class="magnet-hash">${magnet.link}</div>
      </div>
      ${showLocateBtn ? `<button class="locate-btn" title="${getMessage('locateOnPageTooltip' || 'Locate this magnet on the page')}">
        ${getMessage('locateOnPage') || 'Locate'}</button>` : ''}
    `;
    
    item.addEventListener('click', (e) => {
      if (!e.target.closest('.locate-btn')) {
        document.getElementById('magnetInput').value = magnet.link;
        document.getElementById('searchResultsDropdown').classList.remove('show');
      }
    });
    
    const locateBtn = item.querySelector('.locate-btn');
    locateBtn && locateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'highlightMagnet',
          magnetIndex: index
        });
      }
    });
    
    return item;
  }

  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('searchResultsDropdown');
    const searchBtn = document.getElementById('scanMagnet');
    const inputGroup = document.querySelector('.magnet-input-group');
    
    if (dropdown.classList.contains('show') && 
        !dropdown.contains(e.target) && 
        !searchBtn.contains(e.target) &&
        !inputGroup.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  });

  document.getElementById('searchResultsDropdown').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.getElementById('pauseAllBtn').addEventListener('click', () => {
    pauseAllDownloads();
  });
  
  document.getElementById('resumeAllBtn').addEventListener('click', () => {
    resumeAllDownloads();
  });

  document.getElementById('speedLimitToggle').addEventListener('click', async function() {
    const currentActive = this.classList.contains('active');
    const newState = !currentActive;
    
    if (newState) {
      this.classList.add('active');
    } else {
      this.classList.remove('active');
    }
    
    await toggleSpeedLimitMode(newState);
  });

  chrome.storage.sync.get(['autoRefresh'], (settings) => {
    const autoRefreshToggle = document.getElementById('autoRefreshToggle');
    autoRefreshToggle.checked = settings.autoRefresh || false;
    
    autoRefreshToggle.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      chrome.storage.sync.set({ autoRefresh: enabled });
      if (enabled) {
        getCurrentInterval();
      } else {
        document.querySelector('.refresh-interval').textContent = getMessage('autoRefreshOff') || 'Off';
      }
    });
  });
  
  document.getElementById('manualRefresh').addEventListener('click', () => {
    refreshDownloads();
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    
    if (target.classList.contains('action-btn')) {
      const action = target.dataset.action;
      const downloadItem = target.closest('.download-item');
      const hash = downloadItem?.dataset.hash;
      const name = downloadItem?.querySelector('.download-name')?.title;
 
      if (!hash || !name) return;

      if (action === 'pause' || action === 'resume') {
        operateDownload(action, hash, target);
      } else if (action === 'delete') {
        deleteDownload(hash, name, target);
      }
      
      event.preventDefault();
      event.stopPropagation();
    }
  });

  document.addEventListener('change', async (e) => {
    if (e.target.classList.contains('sequential-toggle-checkbox')) {
      const hash = e.target.dataset.hash;
      const enabled = e.target.checked;
      
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'setSequentialDownload',
          hash: hash,
          enabled: enabled
        });
        
        if (!response?.success) {
          e.target.checked = !enabled;
        }
      } catch (error) {
        console.error('Failed to toggle sequential download:', error);
        e.target.checked = !enabled;
      }
    }
  });

  
  document.getElementById('openOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  
  document.getElementById('openWebUI').addEventListener('click', async () => {
    if (currentServer?.qbitUrl) {
      chrome.tabs.create({ url: currentServer.qbitUrl });
    } else {
      alert(getMessage('setAddressFirstSettings'));
      chrome.runtime.openOptionsPage();
    }
  });
  
});