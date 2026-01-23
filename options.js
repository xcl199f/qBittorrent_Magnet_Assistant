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
  hostname = hostname.split('/')[0];
  hostname = hostname.split(':')[0];
  
  return hostname || url;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

async function localizePage() {
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
}

async function saveRefreshInterval() {
  const activeValue = document.getElementById('activeRefreshSlider').value;
  const inactiveValue = document.getElementById('inactiveRefreshSlider').value;
  
  await chrome.storage.sync.set({
    activeRefreshInterval: activeValue,
    inactiveRefreshInterval: inactiveValue
  });
  
  chrome.runtime.sendMessage({
    action: 'refreshIntervalUpdate'
  });
}

async function initRefreshSliders() {
  const activeSlider = document.getElementById('activeRefreshSlider');
  const inactiveSlider = document.getElementById('inactiveRefreshSlider');
  const activeValue = document.getElementById('activeRefreshValue');
  const inactiveValue = document.getElementById('inactiveRefreshValue');
  const inactiveValueContainer = inactiveValue.parentNode;

  const data = await chrome.storage.sync.get(['activeRefreshInterval', 'inactiveRefreshInterval']);

  if (data.activeRefreshInterval) {
    activeSlider.value = data.activeRefreshInterval;
    activeValue.textContent = data.activeRefreshInterval;
  }

  if (data.inactiveRefreshInterval) {
    inactiveSlider.value = data.inactiveRefreshInterval;
    inactiveValue.textContent = data.inactiveRefreshInterval;
  } else {
    inactiveValueContainer.classList.add('no-refresh');
  }

  const saveActiveInterval = debounce((value) => {
    chrome.storage.sync.set({activeRefreshInterval: value});
  }, 500);

  const saveInactiveInterval = debounce((value) => {
    chrome.storage.sync.set({inactiveRefreshInterval: value});
  }, 500);

  activeSlider.addEventListener('input', () => {
    activeValue.textContent = activeSlider.value;
    saveActiveInterval(activeSlider.value);
  });
  
  inactiveSlider.addEventListener('input', () => {
    inactiveValue.textContent = inactiveSlider.value;
    if (inactiveSlider.value == 0) {
      inactiveValueContainer.classList.add('no-refresh');
    } else {
      inactiveValueContainer.classList.remove('no-refresh');
    }
    saveInactiveInterval(inactiveSlider.value);
  });
}

let resultDivTimer;
function showMessage(message, type, timeout = 5000) {
  const resultDiv = document.getElementById('testResult');
  resultDiv.textContent = message;
  resultDiv.className = type;
  
  clearTimeout(resultDivTimer);
  resultDivTimer = setTimeout(() => {
    resultDiv.className = '';
  }, timeout);
}

let servers = [];
let currentServerId = null;
let editingServerId = null;
let serverStatusCache = new Map();

async function loadServers() {
  const data = await chrome.storage.sync.get(['servers', 'currentServerId']);
  servers = data.servers || [];

  currentServerId = data.currentServerId || null;
  
  if (currentServerId) {
    editingServerId = currentServerId;
  }
  
  loadServerForEditing(editingServerId);
  serverStatusCache.clear();
  await updateServerList();

  const testPromises = servers.map(async (server) => {
    try {
      const result = await testServerConnection(server);
      const status = result.success ? 
        (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
        'disconnected';
      updateServerItemStatus(server.id, status);
    } catch (error) {
      updateServerItemStatus(server.id, 'disconnected');
    }
  });
  
  Promise.all(testPromises);

  return servers;
}

async function updateSelectedServerStatus(serverId) {
  const server = servers.find(s => s.id === serverId);
  if (!server) return {success: false};
  
  try {
    updateServerItemStatus(serverId, 'checking');
    const result = await testServerConnection(server);
    const newStatus = result.success ? 
      (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
      'disconnected';
    
    updateServerItemStatus(serverId, newStatus);
    return result;
  } catch (error) {
    updateServerItemStatus(serverId, 'disconnected');
    return {success: false}
  }
}

function updateServerItemStatus(serverId, status) {
  serverStatusCache.set(serverId, status);
  const serverItem = document.querySelector(`[data-server-id="${serverId}"]`);
  if (!serverItem) return;
  
  const statusBadge = serverItem.querySelector('.status-badge');
  if (statusBadge) {
    statusBadge.textContent = getMessage(status + 'Status') || status;
    statusBadge.className = `status-badge status-${status}`;
  }
}

async function updateServerList() {
  const serverList = document.getElementById('serverList');
  if (!serverList) return;
  
  serverList.innerHTML = '';
  
  servers.forEach(server => {
    const serverItem = document.createElement('div');
    serverItem.className = 'server-item';
    serverItem.dataset.serverId = server.id;
    
    if (server.id === editingServerId) {
      serverItem.classList.add('active');
    }

    const cachedStatus = serverStatusCache.get(server.id) || 'checking';
    const statusText = getMessage(cachedStatus + 'Status') || cachedStatus;

    serverItem.innerHTML = `
      <div class="server-info">
        <div>
          <span class="current-server-indicator"></span>
          <span class="server-name">${server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer')}</span>
        </div>
        <div class="server-url" title="${server.qbitUrl}">${server.qbitUrl}</div>
      </div>
      <div class="server-right-section">
        <span class="status-badge status-${cachedStatus}">${statusText}</span>
        <label class="webui-icon" style="cursor: pointer;" title="${getMessage('openWebUI')}" data-server-url="${server.qbitUrl}">🌐</label>
        <label class="auto-login-toggle">
          <input type="checkbox" class="toggle-checkbox" ${server.autoLogin !== false ? 'checked' : ''} data-server-id="${server.id}">
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    
    serverItem.addEventListener('click', async (e) => {
      if (e.target.classList.contains('logout-btn')) {
        return;
      }
      
      document.querySelectorAll('.server-item.active').forEach(item => {
        item.classList.remove('active');
      });
      serverItem.classList.add('active');
      setCurrentServer(server.id);
    });
    
    serverList.appendChild(serverItem);
    
    const webuiIcon = serverItem.querySelector('.webui-icon');
    if (webuiIcon) {
      webuiIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = webuiIcon.dataset.serverUrl;
        if (url) {
          chrome.tabs.create({ url: url });
        }
      });
    }
  });
  
  setupAutoLoginToggles();

  setTimeout(() => {
    const activeServer = document.querySelector('.server-item.active');
    if (activeServer) {
      activeServer.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest'
      });
    }
  }, 100);
}

function setupAutoLoginToggles() {
  document.querySelectorAll('.toggle-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', async (e) => {
      const serverId = checkbox.dataset.serverId;
      const server = servers.find(s => s.id === serverId);
      
      if (!server) return;
      
      server.autoLogin = checkbox.checked;
      await chrome.storage.sync.set({ servers });
      
      if (!checkbox.checked) {
        try {
          const originalServerId = currentServerId;
          
          await chrome.storage.sync.set({
            qbitUrl: server.qbitUrl,
            qbitUsername: server.qbitUsername || '',
            qbitPassword: server.qbitPassword || ''
          });
          
          await chrome.runtime.sendMessage({
            action: 'logout',
            serverUrl: server.qbitUrl
          });
          
          updateSelectedServerStatus(serverId);
          
          if (originalServerId !== serverId) {
            await chrome.runtime.sendMessage({
              action: 'switchServer',
              serverId: originalServerId
            });
          }
          
        } catch (error) {
          console.error('logout failed:', error);
        }
      } else {
        try {
          showMessage(getMessage('testingConnection'), 'info');
          
          const result = await testServerConnection(server);
          const newStatus = result.success ? 
            (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
            'disconnected';
          updateServerItemStatus(serverId, newStatus);
          
          if (result.success && result.authenticated) {
            showMessage(getMessage('connectionSuccess'), 'success');
          }
        } catch (error) {
          updateServerItemStatus(serverId, 'disconnected');
        }
      }
    });
  });
}

function loadServerForEditing(serverId) {
  const server = servers.find(s => s.id === serverId);
  
  if (!server) {
    resetForm();
    editingServerId = null;
    document.getElementById('currentServerTitle').textContent = getMessage('addNewServer');
    document.getElementById('saveServer').textContent = getMessage('addServer');
    document.getElementById('deleteServer').classList.add('hidden');
    document.getElementById('serverSettingsForm').classList.remove('hidden');
    return;
  }
  
  editingServerId = serverId;
  
  document.getElementById('currentServerTitle').textContent = getMessage('editServer') + ': ' + (server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer'));
  
  document.getElementById('serverId').value = server.id;
  document.getElementById('serverName').value = server.name || '';
  document.getElementById('qbitUrl').value = server.qbitUrl || '';
  document.getElementById('qbitUsername').value = server.qbitUsername || '';
  document.getElementById('qbitPassword').value = server.qbitPassword || '';
  document.getElementById('defaultCategory').value = server.defaultCategory || '';
  document.getElementById('defaultSavePath').value = server.defaultSavePath || '';
  document.getElementById('defaultDeleteFiles').checked = server.defaultDeleteFiles || false;
  
  document.getElementById('serverSettingsForm').classList.remove('hidden');
  document.getElementById('saveServer').textContent = getMessage('saveServer');
  document.getElementById('deleteServer').classList.remove('hidden');
}

function resetForm() {
  document.getElementById('serverId').value = '';
  document.getElementById('serverName').value = '';
  document.getElementById('qbitUrl').value = 'http://localhost:8080';
  document.getElementById('qbitUsername').value = '';
  document.getElementById('qbitPassword').value = '';
  document.getElementById('defaultCategory').value = '';
  document.getElementById('defaultSavePath').value = '';
  document.getElementById('defaultDeleteFiles').checked = false;
}

async function testServerConnection(server) {
  try {
    if (server.autoLogin === false) {
      return {
        success: false,
        authenticated: false,
        skipTest: true
      };
    }

    const response = await chrome.runtime.sendMessage({ 
      action: server.id === currentServerId ? 'testConnection' : 'testServerConnectionDirect',
      server: {
        qbitUrl: server.qbitUrl,
        qbitUsername: server.qbitUsername || '',
        qbitPassword: server.qbitPassword || ''
      }
    });
    
    return response;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const hasProtocol = url.match(/^.*:\/\//);
    
    if (!hasProtocol) {
      url = 'http://' + url.trim();
    }

    const urlObj = new URL(url);

    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return '';
    }

    let result = urlObj.protocol + '//' + urlObj.host;
    return result.toLowerCase();
  } catch {
    return '';
  }
}

function validateUrl(url) {
  if (!url) return false;
  
  try {
    const hasProtocol = url.match(/^.*:\/\//);
    
    if (!hasProtocol) {
      url = 'http://' + url;
    }
    
    const urlObj = new URL(url);


    return !!urlObj.hostname;
  } catch {
    return false;
  }
}

async function saveCurrentServer() {
  const nameInput = document.getElementById('serverName');
  const urlInput = document.getElementById('qbitUrl');
  
  if (nameInput.classList.contains('error-border') || 
      urlInput.classList.contains('error-border')) {
    showMessage(getMessage('fixErrorsBeforeSave'), 'error');
    return false;
  }

  const serverData = {
    id: document.getElementById('serverId').value || 'server_' + Date.now(),
    name: document.getElementById('serverName').value.trim(),
    qbitUrl: normalizeUrl(document.getElementById('qbitUrl').value.trim()),
    qbitUsername: document.getElementById('qbitUsername').value.trim(),
    qbitPassword: document.getElementById('qbitPassword').value.trim(),
    defaultCategory: document.getElementById('defaultCategory').value.trim(),
    defaultSavePath: document.getElementById('defaultSavePath').value.trim(),
    defaultDeleteFiles: document.getElementById('defaultDeleteFiles').checked
  };

  const isInvalidServerName = serverData.name !== '' && servers.find(s => 
    s.name === serverData.name && s.id !== serverData.id
  );

  if (isInvalidServerName) {
    showMessage(getMessage('serverNameDuplicate'), 'error');
    return false;
  }
  
  if (!serverData.qbitUrl) {
    showMessage(getMessage('enterWebuiAddress'), 'error');
    return false;
  }

  const normalizedUrl = normalizeUrl(serverData.qbitUrl);
  const sameUrl = servers.find(s => 
    s.qbitUrl === normalizedUrl && s.id !== serverData.id
  );

  if (sameUrl) {
    showMessage(getMessage('serverUrlDuplicate'), 'error');
    return false;
  }
  
  const savedServerId = serverData.id;
  try {
    showMessage(getMessage('serverSaved'), 'success');
    
    const isNewServer = !servers.find(s => s.id === serverData.id);
    
    if (isNewServer) {
      servers.push(serverData);
      currentServerId = serverData.id;
      await chrome.storage.sync.set({ currentServerId, servers });
      
      await chrome.runtime.sendMessage({
        action: 'switchServer',
        serverId: serverData.id
      });
    } else {
      const index = servers.findIndex(s => s.id === serverData.id);
      servers[index] = serverData;
      await chrome.storage.sync.set({ servers });
    }
    
    editingServerId = savedServerId;
    
    if(isNewServer){
      await loadServers();
    } else {
      const serverItem = document.querySelector(`[data-server-id="${serverData.id}"]`);
      if (serverItem) {
        const serverNameEl = serverItem.querySelector('.server-name');
        const serverUrlEl = serverItem.querySelector('.server-url');
        const webuiIcon = serverItem.querySelector('.webui-icon');
        
        if (serverNameEl) {
          serverNameEl.textContent = serverData.name || 
            extractHostname(serverData.qbitUrl) || 
            getMessage('unnamedServer');
        }
        if (serverUrlEl) {
          serverUrlEl.textContent = serverData.qbitUrl;
          serverUrlEl.title = serverData.qbitUrl;
        }
        if (webuiIcon) {
          webuiIcon.dataset.serverUrl = serverData.qbitUrl;
        }
      }
    }
    return true;
  } catch (error) {
    showMessage(getMessage('saveFailed') + ': ' + error.message, 'error');
  }
  return false;
}

async function deleteCurrentServer() {
  if (!editingServerId) return;
  
  const server = servers.find(s => s.id === editingServerId);
  if (!server) {
    showMessage(getMessage('serverNotFound'), 'error');
    return;
  }

  const serverName = server.name || extractHostname(server.qbitUrl) || getMessage('unnamedServer');
  if (!confirm(getMessage('confirmDeleteServer', [serverName]))) {
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deleteServer',
      serverId: editingServerId
    });
    
    if (response?.success) {
      showMessage(getMessage('serverDeleted'), 'success');
      
      editingServerId = null;
      await loadServers();
      document.getElementById('serverSettingsForm').classList.add('hidden');
    } else {
      showMessage(getMessage('deleteFailed'), 'error');
    }
  } catch (error) {
    showMessage(getMessage('deleteFailed') + ': ' + error.message, 'error');
  }
}

async function setCurrentServer(serverId) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'switchServer',
      serverId: serverId
    });
    
    if (response?.success) {
      editingServerId = serverId;
      currentServerId = serverId;
      loadServerForEditing(serverId);
      await updateServerList();
      updateSelectedServerStatus(currentServerId);
      showMessage(getMessage('serverSwitched'), 'success');
    } else {
      throw new Error(response?.error || 'Switch failed');
    }
  } catch (error) {
    showMessage(getMessage('switchFailed') + ': ' + error.message, 'error');
  }
}

function blinkInputWithCSS(inputId, times = 3) {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  let count = 0;
  
  function animate() {
    input.classList.add('blinking');
    
    setTimeout(() => {
      input.classList.remove('blinking');
      
      count++;
      if (count < times) {
        setTimeout(animate, 100);
      } else {
        input.focus();
      }
    }, 500);
  }
  
  animate();
}

function setupRealTimeValidation() {
  const nameInput = document.getElementById('serverName');
  const urlInput = document.getElementById('qbitUrl');
  
  nameInput.addEventListener('input', debounce(() => {
    const name = nameInput.value.trim();
    const serverId = document.getElementById('serverId').value;
    
    if (name && checkServerNameDuplicate(name, serverId || null)) {
      nameInput.classList.add('error-border');
      showMessage(getMessage('serverNameDuplicate'), 'error');
    } else {
      nameInput.classList.remove('error-border');
    }
  }, 300));
  
  urlInput.addEventListener('input', debounce(() => {
    const url = urlInput.value.trim();
    if (url && !normalizeUrl(url)) {
      urlInput.classList.add('error-border');
      showMessage(getMessage('invalidUrlFormat'), 'error');
    } else {
      urlInput.classList.remove('error-border');
    }
  }, 500));
}

function setupHelpSystem() {
  const helpButton = document.getElementById('helpButton');
  const helpOverlay = document.getElementById('helpOverlay');
  const closeHelp = document.getElementById('closeHelp');

  if (!helpButton) return;

  helpButton.addEventListener('click', () => {
    helpOverlay.style.display = 'block';
  });

  closeHelp.addEventListener('click', () => {
    helpOverlay.style.display = 'none';
  });

  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) {
      helpOverlay.style.display = 'none';
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  customI18nDefined && await customI18n.init();
  localizePage();
  initRefreshSliders();
  setupRealTimeValidation();
  setupHelpSystem();

  const languageSelect = document.getElementById('languageSelect');
  if (languageSelect) {
    const result = await chrome.storage.sync.get('selectedLanguage');
    languageSelect.value = result.selectedLanguage || 'auto';
    
    languageSelect.addEventListener('change', async () => {
      chrome.storage.sync.set({ selectedLanguage: languageSelect.value });
      customI18nDefined && await customI18n.setLanguage(languageSelect.value);
      localizePage();
      initRefreshSliders();
      await updateServerList();
      showMessage(getMessage('languageChanged'), 'success');
    });
  }
  
  loadServers().then(servers => {
    if (servers.length === 0) {
      const helpOverlay = document.getElementById('helpOverlay');
      helpOverlay.style.display = 'block';
    }
  });

  document.getElementById('addNewServer').addEventListener('click', () => {
    resetForm();
    editingServerId = null;
    document.getElementById('currentServerTitle').textContent = getMessage('addNewServer');
    document.getElementById('saveServer').textContent = getMessage('addServer');
    document.getElementById('deleteServer').classList.add('hidden');
    document.getElementById('serverSettingsForm').classList.remove('hidden');
  });
  
  document.getElementById('testConnection').addEventListener('click', async () => {
    if(!await saveCurrentServer()) {return};

    if (!editingServerId) {
      showMessage(getMessage('selectServerFirst'), 'error');
      return;
    }
    
    const server = servers.find(s => s.id === editingServerId);
    if (!server) {
      showMessage(getMessage('serverNotFound'), 'error');
      return;
    }

    showMessage(getMessage('testingConnection'), 'info');
    const result = await updateSelectedServerStatus(server.id);
    
    if (result.success && !result.error) {
      let message = '';
      
      if (result.version) {
        message += `✅ qBittorrent ${result.version}`;
      }
      
      if (result.authenticated) {
        message += ' ✅ ' + getMessage('authSuccessful');
      } else if (!result.canLogin) {
        message += ' ℹ️ ' + getMessage('anonymousAccess');
      } else if (result.authenticated === false) {
        message += ' ⚠️ ' + getMessage('authRequired');
        blinkInputWithCSS('qbitPassword');
        blinkInputWithCSS('qbitUsername');
      }
            
      if (result.csrfEnabled) {
        message += ' ℹ️ ' + getMessage('csrfEnabled');
      }

      showMessage(message.trim(), result.error ? 'error' : result.authenticated ? 'success' : 'info');
    } else {
      showMessage(`❌ ${getMessage('connectionFailed')}: ${result.error || getMessage('unknownError')}`, 'error', 20000);
    }
  });
  
  document.getElementById('saveServer').addEventListener('click', saveCurrentServer);
  document.getElementById('deleteServer').addEventListener('click', deleteCurrentServer);

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      if (changes.currentServerId) {
        const newId = changes.currentServerId.newValue;
        document.querySelectorAll('.server-item.active').forEach(item => {
          item.classList.remove('active');
        });
        const serverItem = document.querySelector(`[data-server-id="${newId}"]`);
        serverItem && serverItem.classList.add('active');
        editingServerId = newId;
        currentServerId = newId;
        loadServerForEditing(newId);
      }
    }
  });
});