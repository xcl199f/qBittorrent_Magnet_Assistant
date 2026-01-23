import './i18n-manager.js';

let getMessage = function(key, substitutions = []) {
  return chrome.i18n.getMessage(key, substitutions);
};

if (typeof customI18n !== 'undefined' && customI18n && 
  typeof customI18n.init === 'function' && 
  typeof customI18n.getMessage === 'function') {
  customI18n.init().then(() => {
    getMessage = function(key, substitutions = []) {
      return customI18n.getMessage(key, substitutions);
    };
  }).catch(error => {
    console.log('customI18n:', error);
  });
}

function extractInfoHash(magnetLink) {
  const match = magnetLink.match(/magnet:\?xt=urn:btih:([^&]+)/i);
  return match ? match[1].toLowerCase() : null;
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

function sendMessageSafely(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message;
        if (errorMsg.includes('Receiving end does not exist') ||
            errorMsg.includes('The message port closed before a response was received')
        ) {
          resolve(null);
        } else {
          console.warn(errorMsg);
          resolve(null);
        }
      } else {
        resolve(response);
      }
    });
  });
}

async function saveServerConfig(serverConfig) {
  const data = await chrome.storage.sync.get(['servers']);
  const serverId = await chrome.storage.sync.get(['currentServerId']);
  let servers = data.servers || [];
  const currentServerId = serverId.currentServerId;

  if (serverConfig.id) {
    const index = servers.findIndex(s => s.id === serverConfig.id);
    if (index >= 0) {
      servers[index] = serverConfig;
      if (currentServerId === serverConfig.id) {
        await chrome.storage.sync.set({ servers: servers });
        return serverConfig.id;
      }
    } else {
      servers.push(serverConfig);
    }
  } else {
    serverConfig.id = 'server_' + Date.now();
    servers.push(serverConfig);
  }
  await chrome.storage.sync.set({ servers });
  return serverConfig.id;
}

const emptyServer = {
  qbitUrl: '',
  qbitUsername: '',
  qbitPassword: '',
  defaultCategory: '',
  defaultTags: '',
  defaultSavePath: ''
};

async function getServerInfo(serverId) {
  const data = await chrome.storage.sync.get(['servers', 'currentServerId']);
  if (!serverId) serverId = data.currentServerId;
  if (!serverId || !data.servers) return emptyServer;
  return data.servers.find(s => s.id === serverId) || emptyServer;
}

async function getServerCredentials(serverId) {
  const server = await getServerInfo(serverId);
  
  return {
    qbitUrl: server.qbitUrl,
    qbitUsername: server.qbitUsername || '',
    qbitPassword: server.qbitPassword || ''
  };
}

async function temporarilyDisableLogin(server) {
  const disableUntil = Date.now() + (15 * 60 * 1000);
  
  const record = {
    disableUntil: disableUntil,
    failedCredentials: {
      url: server.qbitUrl,
      username: server.qbitUsername || '',
      password: server.qbitPassword || ''
    },
    timestamp: Date.now()
  };
  
  const data = await chrome.storage.local.get(['loginDisabledRecords']);
  const records = data.loginDisabledRecords || {};
  
  records[server.id] = record;
  await chrome.storage.local.set({ loginDisabledRecords: records });
}

async function isLoginDisabled(serverId) {
  if (!serverId) { return false }

  const data = await chrome.storage.local.get(['loginDisabledRecords']);
  const records = data.loginDisabledRecords || {};
  const record = records[serverId];

  if (!record) return false;

  if (Date.now() > record.disableUntil) {
    await clearLoginDisabled(serverId);
    return false;
  }

  const server = await getServerInfo(serverId);
  
  if (!server) {
    await clearLoginDisabled(serverId);
    return false;
  }

  const areCredentialsSame = 
    server.qbitUsername === record.failedCredentials.username &&
    server.qbitPassword === record.failedCredentials.password;
  
  if (!areCredentialsSame) {
    await clearLoginDisabled(serverId);
    return false;
  }
  
  return true;
}

async function clearLoginDisabled(serverId) {
  const data = await chrome.storage.local.get(['loginDisabledRecords']);
  const records = data.loginDisabledRecords || {};
  delete records[serverId];
  await chrome.storage.local.set({ loginDisabledRecords: records });
}

class QBittorrentClient {
  constructor() {
    this.session = {
      cookie: null,
      csrfToken: null,
      lastLogin: 0
    };
    this.serverId = null;
    this.baseURL = null;
    this.serverSessions = new Map();
    this.currentControllers = new Set();
  }
  
  initialize(server) {
    this.serverId = server.id; 
    this.baseURL = server.qbitUrl;
    this.restoreSession();
  }

  cancelAllRequests(reason = 'EXTERNAL_CANCELLED') {
    for (const controller of this.currentControllers) {
      controller.abort(reason);
    }
    this.currentControllers.clear();
  }
    
  async makeRequest(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    
    const defaultOptions = {
      credentials: 'include',
      headers: {
        'Referer': this.baseURL,
        'Origin': new URL(this.baseURL).origin,
        'Accept': 'application/json, text/plain, */*'
      }
    };
    
    const finalOptions = { ...defaultOptions, ...options };
    
    if (this.session.csrfToken && !finalOptions.headers['X-CSRF-Token']) {
      finalOptions.headers['X-CSRF-Token'] = this.session.csrfToken;
    }
    
    const MAX_RETRIES = options.maxRetries || 2;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      this.currentControllers.add(controller);
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      
      try {
        const attemptOptions = { ...finalOptions, signal: controller.signal };
        const response = await fetch(url, attemptOptions);
        
        clearTimeout(timeoutId);
        this.currentControllers.delete(controller);
        
        if (response.status === 401 || response.status === 403) {
          const retryInfo = {
            url,
            options: attemptOptions,
            endpoint,
            retryCount: 0
          };
          return await this.retryWithLogin(response, retryInfo);
        }
        
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        this.currentControllers.delete(controller);

        if (error.message === 'EXTERNAL_CANCELLED') {
          throw error;
        }

        if (error.name === 'AbortError' && attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        
        if (error.name === 'AbortError' || error.name === 'TypeError') {
          this.isTestClient || downloadManager.handleConnectionStatusChange(false);
        }
        
        throw error;
      }
    }
  }

  async retryWithLogin(failedResponse, retryInfo) {
    if (retryInfo.endpoint === '/api/v2/auth/logout' || this.isTestClient || retryInfo.retryCount > 0) {
      return failedResponse;
    }
    retryInfo.retryCount++;
    
    try {
      this.session.csrfToken = null;
      this.session.cookie = null;

      const server = await getServerInfo();
      const isloginDisable = await isLoginDisabled(server.id);

      if (server && server.qbitUsername && server.qbitPassword && !isloginDisable) {
        const loginResult = await this.login(server.qbitUsername, server.qbitPassword);

        if (loginResult.success) {
          delete retryInfo.options.headers['X-CSRF-Token'];

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          retryInfo.options.signal = controller.signal;
          
          const retryResponse = await fetch(retryInfo.url, retryInfo.options);
          clearTimeout(timeoutId);
          
          return retryResponse;
        } else {
          temporarilyDisableLogin(server);
          return loginResult;
        }
      }
    } catch (error) {
      console.log('Retry with login failed:', error);
    }

    return failedResponse;
  }
  
  async testConnection() {
    try {
      const response = await this.makeRequest('/api/v2/app/version', {
        method: 'GET',
        headers: {
          'Accept': 'text/plain',
          'Referer': this.baseURL,
          'Origin': new URL(this.baseURL).origin
        }
      });
      
      if (response.ok) {
        const version = await response.text();
        this.isTestClient || downloadManager.handleConnectionStatusChange(true);
        
        let authenticated = false;
        let csrfEnabled = false;
        let canLogin = false;
        
        if (this.session.csrfToken) {
          authenticated = true;
          csrfEnabled = true;
        } else {
          canLogin = true;
        }
        
        return { 
          success: true, 
          version: version,
          authenticated: authenticated,
          csrfEnabled: csrfEnabled,
          canLogin: canLogin,
          connected: true
        };
      } else {
        return await this.handleAuthRequiredResponse(response);
      }
    } catch (error) {
      this.isTestClient || downloadManager.handleConnectionStatusChange(false);

      if (error.name === 'TypeError' || error.name === 'AbortError') {
        return { 
          success: false, 
          error: error.message,
          connected: false,
          authenticated: false
        };
      }
      
      return { 
        success: false, 
        error: error.message,
        connected: false,
        authenticated: false
      };
    }
  }

  async handleAuthRequiredResponse(response) {
    this.isTestClient || downloadManager.handleConnectionStatusChange(false);

    if (response.status === 403) {
      return { 
        success: true,
        connected: true,
        authenticated: false,
        csrfEnabled: true,
        canLogin: true,
        error: await isLoginDisabled(this.serverId) && getMessage('loginDisable') || response.error || getMessage('authRequiredCSRF')
      };
    }
    
    if (response.status === 401) {
      return { 
        success: true,
        connected: true,
        authenticated: false,
        csrfEnabled: false,
        canLogin: true,
        error: response.error || getMessage('authRequired')
      };
    }

    return { 
      success: false, 
      error: `HTTP ${response.status}`,
      needsAuth: response.status === 403
    };
  }

  async login(username, password) {
    try {
      const formData = new URLSearchParams();
      formData.append('username', username);
      formData.append('password', password);
      
      const loginResponse = await fetch(`${this.baseURL}/api/v2/auth/login`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': this.baseURL,
          'Origin': new URL(this.baseURL).origin,
          'Accept': 'application/json, text/plain, */*'
        }
      });

      const text = await loginResponse.text();
      if (loginResponse.ok && text.toLowerCase().includes('ok') && loginResponse.status === 200) {
        const cookies = await this.fetchAndStoreCookies();
        if (cookies.some(c => c.name === 'SID')) {
          this.isTestClient || downloadManager.handleConnectionStatusChange(true);
          return { success: true, status: loginResponse.status };
        } else {
          return { success: false, status: loginResponse.status, error: getMessage('authFailed') };
        }
      } else {
        return { success: false, status: loginResponse.status, error: getMessage('loginFailed') };
      }
    } catch (error) {
      return { success: false, status: '', error: error.message };
    }
  }

  async logout(serverUrl = null) {
    const urlToUse = serverUrl || this.baseURL;
    if (!urlToUse) return { success: false, error: getMessage('noServerAddress') };
    
    try {
      const tempClient = new QBittorrentClient();
      tempClient.initialize({ qbitUrl: urlToUse });
      await tempClient.makeRequest('/api/v2/auth/logout', {
        method: 'POST'
      });
    } catch (error) {}
    
    return new Promise((resolve) => {
      const url = new URL(urlToUse);
      const domain = url.hostname;
      
      chrome.cookies.getAll({ domain: domain }, (cookies) => {
        if (!cookies || cookies.length === 0) {
          resolve({ success: true, deleted: 0 });
          return;
        }

        let deletedCount = 0;
        const deletePromises = cookies.map(cookie => {
          return new Promise((resolveDelete) => {
            const protocol = cookie.secure ? 'https://' : 'http://';
            const cookieUrl = `${protocol}//${cookie.domain}${cookie.path}`;
            
            chrome.cookies.remove({
              url: cookieUrl,
              name: cookie.name
            }, () => {
              if (!chrome.runtime.lastError) deletedCount++;
              resolveDelete();
            });
          });
        });
        
        Promise.all(deletePromises).then(() => {
          if (!serverUrl || serverUrl === this.baseURL) {
            this.session.cookie = null;
            this.session.csrfToken = null;
            this.session.lastLogin = 0;
          }
          
          resolve({ success: true, deleted: deletedCount });
        });
      });
    });
  }

  async loadSession() {
    const server = await getServerInfo();

    if (server.qbitUrl) {
      this.serverId = server.id;
      this.baseURL = server.qbitUrl;
      
      const data = await chrome.storage.local.get(['serverSessions']);
      const allSessions = data.serverSessions || {};
      
      if (allSessions[server.qbitUrl]) {
        this.session = { ...allSessions[server.qbitUrl] };
      }
      
      this.serverSessions.set(server.qbitUrl, { ...this.session });
    } else {
      this.session = {
        cookie: null,
        csrfToken: null,
        lastLogin: 0
      };
    }
  }

  async saveSession() {
    if (this.isTestClient) {
      return;
    }

    if (this.baseURL) {
      this.serverSessions.set(this.baseURL, { ...this.session });
      
      const data = await chrome.storage.local.get(['serverSessions']);
      const allSessions = data.serverSessions || {};
      allSessions[this.baseURL] = { ...this.session };
      await chrome.storage.local.set({ serverSessions: allSessions });
    }
  }

  async restoreSession() {
    if (this.serverSessions.has(this.baseURL)) {
      const savedSession = this.serverSessions.get(this.baseURL);
      this.session = { ...savedSession };
    } else {
      const data = await chrome.storage.local.get(['serverSessions']);
      const allSessions = data.serverSessions || {};
      
      if (allSessions[this.baseURL]) {
        this.session = { ...allSessions[this.baseURL] };
        this.serverSessions.set(this.baseURL, { ...this.session });
      } else {
        this.session = {
          cookie: null,
          csrfToken: null,
          lastLogin: 0
        };
      }
    }
  }

  async fetchAndStoreCookies() {
    return new Promise((resolve) => {
      const url = new URL(this.baseURL);
      
      chrome.cookies.getAll({ domain: url.hostname }, (cookies) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        
        const sidCookie = cookies.find(c => c.name === 'SID');
        if (sidCookie) {
          this.session.cookie = sidCookie.value;
          this.session.csrfToken = sidCookie.value;
          this.session.lastLogin = Date.now();
          if (!this.isTestClient) {
            this.saveSession();
          }
        }
        
        resolve(cookies);
      });
    });
  }
  
  async addMagnet(magnetLink, options = {}) {
    try {
      const formData = new FormData();
      formData.append('urls', magnetLink);
      
      if (options.category) {
        formData.append('category', options.category);
      }
      if (options.tags) {
        formData.append('tags', options.tags);
      }
      if (options.savepath) {
        formData.append('savepath', options.savepath);
      }
      
      const headers = {
        'Referer': this.baseURL,
        'Origin': new URL(this.baseURL).origin
      };
      
      if (this.session.csrfToken) {
        headers['X-CSRF-Token'] = this.session.csrfToken;
      }
      
      const response = await qbtClient.makeRequest(`/api/v2/torrents/add`, {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        return { success: true };
      } else {
        const errorText = await response.text();
        return { 
          success: false, 
          error: errorText, 
          status: response.status,
          csrfError: response.status === 403
        };
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async getSpeedLimitsMode() {
    const modeResponse = await this.makeRequest('/api/v2/transfer/speedLimitsMode');
    if (!modeResponse.ok) {
      throw new Error(`Failed to get speedLimitsMode: HTTP ${modeResponse.status}`);
    }
    const speedMode = await modeResponse.text();
    const isAltSpeedMode = speedMode === '1';
    const modeChanged = downloadManager.isAltSpeedMode !== isAltSpeedMode;
    downloadManager.isAltSpeedMode = isAltSpeedMode;

    modeChanged && downloadManager.updateExtensionBadge();

    return isAltSpeedMode;
  }
}

class DownloadManager {
  constructor() {
    this.activeDownloads = new Map();
    this.completedDownloads = new Map();
    this.activeInterval = 5000;
    this.inactiveInterval = 0;
    this.currentInterval = 5000;
    this.alarmName = 'checkDownloads';
    this.lastCheckTime = 0;
    this.isChecking = false;
    this.isConnected = false;
    this.checkRetryCount = 0;
    this.maxRetryCount = 3;
    this.popupIsOpen = false;
    this.lastUpdateTime = null;
    this.refreshTimer = null;
    this.popupLastUpdateTime = null;
    this.isAltSpeedMode = false;
    this.pendingCheckPromise = null;
    this.initialize();
    this.loadSettings();
    this.setupAlarmListener();
  }
  
  initialize() {
    this.isConnected = false;
    
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'connectionStatusChanged') {
        this.handleConnectionStatusChange(request.connected);
      }
    });
  }

  setupAlarmListener() {
    if (this.alarmListenerSetup) return;
    
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === this.alarmName) {
        this.checkDownloadStatus();
      }
    });
    
    this.alarmListenerSetup = true;
  }

  async loadSettings() {
    try {
      const settings = await chrome.storage.sync.get([
        'activeRefreshInterval', 'inactiveRefreshInterval', 'autoRefresh'
      ]);

      const activeSec = parseInt(settings.activeRefreshInterval) || 5;
      const inactiveSec = parseInt(settings.inactiveRefreshInterval) || 0;
      
      this.activeInterval = activeSec * 1000;
      this.inactiveInterval = inactiveSec === 0 ? 0 : inactiveSec * 1000;
      this.isAutoRefresh = settings.autoRefresh || false;
      
      return true;
    } catch (error) {
      return false;
    }
  }

  handleConnectionStatusChange(connected) {
    if (connected == this.isConnected) {
      return;
    }

    if (connected && !this.isConnected) {
      this.isConnected = true;
      this.checkRetryCount = 0;
      
      if (this.isAutoRefresh) {
        this.startMonitoring();
      }
    } else if (!connected && this.isConnected) {
      this.isConnected = false;
      this.stopMonitoring();
      this.clearDownloads();
    }
  }

  startMonitoring() {
    this.restartMonitoring();
  }
  
  stopMonitoring() {
    chrome.alarms.clear(this.alarmName);

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  restartMonitoring() {
    this.stopMonitoring();
    if (!this.isConnected || !this.isAutoRefresh) {
      return;
    }
    sendMessageSafely({action: 'refreshIntervalUpdate', interval: this.currentInterval});
    this.checkDownloadStatus(true);

    if (
      this.currentInterval == null ||
      isNaN(Number(this.currentInterval)) ||
      Number(this.currentInterval) <= 0
    ) {
      return;
    }
    try {
      const periodInMinutes = this.currentInterval / 60000;
      chrome.alarms.create(this.alarmName, {
        periodInMinutes: Math.max(periodInMinutes, 0.0167)
      });
    } catch (error) {
      this.refreshTimer = setInterval(() => {
        if (this.isConnected) {
          this.checkDownloadStatus();
        }
      }, this.currentInterval);
    }
  }
  
  clearDownloads() {
    this.activeDownloads.clear();
    this.updateExtensionBadge();
    this.updatePopupStatus();
  }

  adjustInterval(hasActiveDownloads) {
    let newInterval = hasActiveDownloads ? this.activeInterval : this.inactiveInterval;

    if (newInterval !== this.currentInterval) {
      this.currentInterval = newInterval;
      this.restartMonitoring();
    }
  }

  cancelCurrentCheck() {
    if (this.pendingCheckPromise) {
      this.isChecking = false;
      this.pendingCheckPromise = null;
    }
  }
  
  async checkDownloadStatus(force = false, skipUpdateUI = false) {
    if (this.isChecking && this.pendingCheckPromise) {
      return this.pendingCheckPromise;
    }

    const now = Date.now();
    if (!force && now - this.lastCheckTime < this.currentInterval - 200) {
      return null;
    }
    
    this.isChecking = true;
    this.lastCheckTime = now;
    
    this.pendingCheckPromise = (async () => {
      try {
        if (!qbtClient.baseURL) {
          const server = await getServerInfo();
          if (!server.qbitUrl) {
            this.checkRetryCount++;
            return null;
          }
          qbtClient.initialize(server);
        }
        
        const response = await qbtClient.makeRequest('/api/v2/torrents/info', {
          method: 'GET',
          timeout: 10000
        });

        if (response.ok) {
          this.checkRetryCount = 0;
          this.lastUpdateTime = new Date();
          const torrents = await response.clone().json();
          this.updateActiveDownloads(torrents);

          if(!skipUpdateUI){
            this.updateExtensionBadge();
            this.updatePopupStatus();
          }

          const hasActiveDownloads = this.hasActiveDownloads(torrents);
          this.adjustInterval(hasActiveDownloads);

          return response;
        } else {
          this.checkRetryCount++;
          
          if (response.status === 401 || response.status === 403) {
            this.isTestClient || downloadManager.handleConnectionStatusChange(false);
          }
          if (this.checkRetryCount >= this.maxRetryCount) {
            this.isConnected = false;
            this.stopMonitoring();
          }
          
          return response;
        }
      } catch (error) {
        this.checkRetryCount++;
        
        if (error.name === 'TypeError' || error.name === 'TimeoutError') {
          this.isConnected = false;
          this.stopMonitoring();
        }
        
        return {
          ok: false,
          status: error.name === 'AbortError' ? 408 : 0,
          statusText: error.message,
          error: error
        };
      } finally {
        this.isChecking = false;
        this.pendingCheckPromise = null;
      }
    })();
    
    return this.pendingCheckPromise;
  }
  
  hasActiveDownloads(torrents) {
    const activeStates = [
      'downloading',
      'forcedDL',
      'stalledDL',
      'queuedDL',
      'metaDL',
      'checkingDL',
      'queued'
    ];
    
    return torrents.some(torrent => 
      activeStates.includes(torrent.state)
    );
  }

  setAutoRefresh(enabled) {
    this.isAutoRefresh = enabled;
    
    if (enabled) {
      this.startMonitoring();
    } else {
      this.stopMonitoring();
    }
  }

  updateActiveDownloads(torrents) {
    const newActiveDownloads = new Map();
    const newlyCompleted = [];

    torrents.forEach(torrent => {
      const isDownloading = ['downloading', 'forcedDL', 'metaDL'].includes(torrent.state);
      const isPaused = torrent.state === 'stoppedDL' || torrent.state === 'pausedUP';
      const isSeeding = torrent.state === 'uploading' || torrent.state === 'stalledUP';
      const isChecking = torrent.state === 'checking';
      const isQueued = torrent.state === 'queued' || torrent.state === 'stalledDL';
      const isMoving = torrent.state === 'moving';
      const isError = torrent.state === 'error';

      const shouldShow = isDownloading || isPaused || isSeeding || isChecking || isQueued || isMoving || isError;

      if (shouldShow) {
        newActiveDownloads.set(torrent.hash, {
          hash: torrent.hash,
          name: torrent.name,
          progress: torrent.progress,
          size: torrent.size,
          downloaded: torrent.completed,
          downloadSpeed: isPaused ? 0 : torrent.dlspeed,
          uploadSpeed: isPaused ? 0 : torrent.upspeed,
          state: torrent.state,
          isDownloading: isDownloading,
          isPaused: isPaused,
          isError: isError,
          seqDownload: torrent.seq_dl || false,
          addedTime: new Date(torrent.added_on * 1000).toLocaleString(),
          ratio: torrent.ratio,
          estimatedTime: isPaused ? 0 : torrent.eta,
          savePath: torrent.save_path
        });
      }

      if (this.activeDownloads.has(torrent.hash) && torrent.progress >= 1) {
        const oldDownload = this.activeDownloads.get(torrent.hash);
        if (oldDownload.progress < 1) {
          newlyCompleted.push({
            name: torrent.name,
            size: torrent.size,
            completedTime: new Date().toLocaleString(),
            savePath: torrent.save_path
          });
        }
      }

      if (torrent.progress >= 1 && this.activeDownloads.has(torrent.hash)) {
        const oldDownload = this.activeDownloads.get(torrent.hash);
        if (oldDownload.progress < 1) {
          newlyCompleted.push({
            name: torrent.name,
            size: torrent.size,
            completedTime: new Date().toLocaleString(),
            savePath: torrent.save_path
          });
        }
      }
    });
    
    this.activeDownloads = newActiveDownloads;
    
    newlyCompleted.forEach(completed => {
      this.showDownloadCompleteNotification(completed);
    });
  }

  showDownloadCompleteNotification(download) {
    const title = getMessage('downloadComplete');
    const savedToText = getMessage('savedTo');
    
    showNotification(`✅ ${title}`, `${download.name}\n${savedToText}: ${download.savePath}`);
    
    this.updateExtensionBadge();
  }
  
  updateExtensionBadge() {
    const activeCount = this.activeDownloads.size;
    if (activeCount > 0) {
      let badgeColor = this.isAltSpeedMode ? '#f9931fff' : '#5ed651ff'
      chrome.action.setBadgeText({ text: activeCount.toString() });
      
      let totalProgress = 0;
      let downloadSpeed = 0;
      let hasStalledDownloads = false;
      let hasErrorDownloads = false;
      
      this.activeDownloads.forEach(download => {
        totalProgress += download.progress;
        downloadSpeed += download.downloadSpeed;
        if (download.isError) {
          hasErrorDownloads = true;
          badgeColor = '#ff0000ff';
        }
        if (download.progress < 1 && download.downloadSpeed === 0 && 
            (['metaDL', 'stalledDL'].includes(download.state) && Date.now() - new Date(download.addedTime).getTime() > 30000
             || download.state === 'downloading')) {
          hasStalledDownloads = true;
          badgeColor = '#c15448ff';
        }
      });

      chrome.action.setBadgeBackgroundColor({ color: badgeColor });
      chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
      
      const avgProgress = Math.round((totalProgress / activeCount) * 100);

      let speedText = '';
      if (downloadSpeed > 0) {
        speedText = `${getMessage('speed')}:\t${formatSpeed(downloadSpeed)}`;
      }

      let statusIndicator = '';
      if (hasErrorDownloads) {
        statusIndicator = ` [${getMessage('error')}]`;
      } else if (hasStalledDownloads) {
        statusIndicator = ` [${getMessage('stalled')}]`;
      } else if (this.isAltSpeedMode) {
        statusIndicator = ` [${getMessage('altSpeedMode')}]`;
      }

      let title = `${getMessage('extensionName')}${statusIndicator}
        ${getMessage('taskCountTooltip')}:  ${activeCount}
        ${getMessage('totalProgressTip')}:    ${avgProgress}%
        ${speedText}`
      
      chrome.action.setTitle({ title: title });
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: getMessage('extensionName') });
    }
  }
  
  updatePopupStatus() {
    if (!this.popupIsOpen) {
      return;
    }
    sendMessageSafely({
      action: 'downloadStatusUpdate',
      downloads: Array.from(this.activeDownloads.values()),
      activeCount: this.activeDownloads.size,
      lastUpdateTime: this.lastUpdateTime ? this.lastUpdateTime.toISOString() : null
    });
  }

  setPopupOpenStatus(isOpen) {
    this.popupIsOpen = isOpen;
  }

  stop() {
    chrome.alarms.clear(this.alarmName);
    this.activeDownloads.clear();
    this.updateExtensionBadge();
  }
}

function showNotification(title, message, silent = false) {
  const notificationId = 'noti-' + Date.now();

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message,
    priority: silent ? 1 : 2,
    silent: silent ? true : false
  });

  return notificationId;
}

function showConfigNotification(magnetLink, isSequential, errorMessage) {
  const notificationId = 'config-required-' + Date.now();
  
  const buttonClickHandler = (id, buttonIndex) => {
    if (id !== notificationId) return;
    handleNotificationAction();
  };
  
  const notificationClickHandler = (id) => {
    if (id !== notificationId) return;
    handleNotificationAction();
  };
  
  const handleNotificationAction = () => {
    chrome.notifications.clear(notificationId);

    chrome.storage.local.set({
      pendingMagnetLink: {
        link: magnetLink,
        sequential: isSequential,
        timestamp: Date.now()
      }
    });

    chrome.runtime.openOptionsPage();

    chrome.notifications.onButtonClicked.removeListener(buttonClickHandler);
    chrome.notifications.onClicked.removeListener(notificationClickHandler);
  };

  chrome.notifications.onButtonClicked.addListener(buttonClickHandler);
  chrome.notifications.onClicked.addListener(notificationClickHandler);

  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: getMessage('configurationRequired'),
    message: `${errorMessage || getMessage('noAddressSet')}\n${getMessage('clickToConfigure')}`,
    buttons: [{ title: getMessage('openSettings') || 'Open Settings' }],
    priority: 2,
    requireInteraction: true
  });
  
  setTimeout(() => {
    chrome.notifications.onButtonClicked.removeListener(buttonClickHandler);
    chrome.notifications.onClicked.removeListener(notificationClickHandler);
    chrome.notifications.clear(notificationId);
  }, 10000);
}

async function addMagnetToServer(magnetLink, options = {}) {
  const data = await chrome.storage.sync.get(['servers', 'currentServerId']);
  let targetServerId = options.serverId || data.currentServerId;
  const server = await getServerInfo(targetServerId);
  
  if (!server || !server.qbitUrl) {
    return { success: false, error: getMessage('noAddressSet') };
  }
  
  const finalSettings = {
    category: options.category || server.defaultCategory || '',
    tags: options.tags || server.defaultTags || '',
    savepath: options.savepath || server.defaultSavePath || ''
  };
  
  qbtClient.initialize(server);
  
  await qbtClient.restoreSession(server.qbitUrl);
  
  const connectionResult = await qbtClient.testConnection();

  if (!connectionResult.success || !connectionResult.connected) {
    return { 
      success: false, 
      error: getMessage('serverUnreachable'),
      connectionFailed: true
    };
  }

  if (connectionResult.canLogin && !connectionResult.authenticated && 
      (!server.qbitUsername || !server.qbitPassword)) {
    return { 
      success: false, 
      error: getMessage('authRequiredNoCreds'),
      needsAuth: true
    };
  }
  
  const result = await qbtClient.addMagnet(magnetLink, finalSettings);
  
  if (result.success) {
    let sequentialSuccess = false;
    let retryCount = 0;
    while (retryCount < 5) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        const torrentsResponse = await downloadManager.checkDownloadStatus(true);
        if (torrentsResponse.ok) {
          const torrents = await torrentsResponse.json();
          const infohash = extractInfoHash(magnetLink);
          if (infohash) {
            const newTorrent = torrents.find(t => t.hash.toLowerCase() === infohash);
            if (newTorrent && options.sequential) {
              const seqResponse = await qbtClient.makeRequest('/api/v2/torrents/toggleSequentialDownload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `hashes=${newTorrent.hash}&value=true`
              });
              sequentialSuccess = seqResponse.ok;
            }
            if (newTorrent) { break }
          }
        }
      } catch (error) {
        console.log('Toggle sequential download:', error);
      }
      retryCount++;
    }
    if (options.sequential) {
      result.sequentialSuccess = sequentialSuccess;
    }
  }
  
  return result;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'send-magnet-normal',
      title: getMessage('contextMenuTitle'),
      contexts: ['link', 'selection']
    });

    chrome.contextMenus.create({
      id: 'send-magnet-sequential',
      title: getMessage('contextMenuSequentialTitle'),
      contexts: ['link', 'selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const magnetLink = info.linkUrl || info.selectionText;
  
  if (!magnetLink || !magnetLink.includes('magnet:')) {
    showNotification(getMessage('tip'), getMessage('noMagnetDetected'));
    return;
  }

  const isSequential = info.menuItemId === 'send-magnet-sequential';
  const notificationId = showNotification(
    getMessage('processing'),
    isSequential ? getMessage('sendingSequential') : getMessage('sendingMagnet'),
    true
  );

  setTimeout(() => {chrome.notifications.clear(notificationId)}, 2000);

  try {
    const result = await addMagnetToServer(magnetLink, {
      sequential: isSequential
    });
      
    if (result.success) {
      if (isSequential && result.sequentialSuccess) {
        showNotification(getMessage('success'), getMessage('magnetAddedSequential'));
      } else if (isSequential) {
        showNotification(getMessage('warning'), getMessage('magnetAdded') + "\n" + getMessage('sequentialSetFailed'));
      } else {
        showNotification(getMessage('success'), getMessage('magnetAdded'));
      }
    } else {
      if (result.error === getMessage('noAddressSet') || result.connectionFailed) {
        showConfigNotification(magnetLink, isSequential, result.error);
      } else {
        showNotification(getMessage('failed'), getMessage('addFailedDetail', [result.error || getMessage('unknownError')]));
      }
    }
  } catch (error) {
    showNotification(getMessage('error'), getMessage('processFailedDetail', [error.message]));
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const actions = {
    popupClosed: async () => {
      downloadManager.setPopupOpenStatus(false);
      sendResponse({ success: true });
    },

    popupOpened: async () => {
      downloadManager.setPopupOpenStatus(true);
      sendResponse({ success: true });
    },

    logout: async () => {
      const result = await qbtClient.logout(request.serverUrl);
      sendResponse(result);
    },

    saveServerConfig: async () => {
      const serverId = await saveServerConfig(request.config);
      sendResponse({ success: true, serverId });
    },

    deleteServer: async () => {
      const data = await chrome.storage.sync.get(['servers', 'currentServerId']);
      let servers = data.servers || [];

      const serverToDelete = servers.find(s => s.id === request.serverId);
      
      servers = servers.filter(s => s.id !== request.serverId);
      
      let currentServerId = data.currentServerId;
      if (currentServerId === request.serverId) {
        currentServerId = servers.length > 0 ? servers[0].id : null;
      }

      await chrome.storage.sync.set({ servers, currentServerId });
      
      if (serverToDelete && serverToDelete.qbitUrl) {
        const sessionData = await chrome.storage.local.get(['serverSessions']);
        const allSessions = sessionData.serverSessions || {};
        
        if (allSessions[serverToDelete.qbitUrl]) {
          delete allSessions[serverToDelete.qbitUrl];
          await chrome.storage.local.set({ serverSessions: allSessions });
        }

        if (request.serverId === data.currentServerId) {
          qbtClient.session = {
            cookie: null,
            csrfToken: null,
            lastLogin: 0
          };
          qbtClient.baseURL = null;
          downloadManager.handleConnectionStatusChange(false);

          if (currentServerId) {
            const newCurrentServer = servers.find(s => s.id === currentServerId);
            if (newCurrentServer) {
              await chrome.storage.sync.set({
                qbitUrl: newCurrentServer.qbitUrl,
                qbitUsername: newCurrentServer.qbitUsername || '',
                qbitPassword: newCurrentServer.qbitPassword || ''
              });
              qbtClient.initialize(newCurrentServer);

              await qbtClient.restoreSession(newCurrentServer.qbitUrl);
            }
          } else {
            await chrome.storage.sync.set({
              qbitUrl: '',
              qbitUsername: '',
              qbitPassword: ''
            });
          }
        }

        if (qbtClient.serverSessions.has(serverToDelete.qbitUrl)) {
          qbtClient.serverSessions.delete(serverToDelete.qbitUrl);
        }
      }
      
      sendResponse({ success: true });
    },
  
    switchServer: async () => {
      try {
        if (request.serverId === qbtClient.serverId) {
          sendResponse({ success: true });
          return true;
        }

        downloadManager.cancelCurrentCheck();
        qbtClient.cancelAllRequests();

        const server = await getServerInfo(request.serverId);

        if (server) {
          qbtClient.saveSession();
          await chrome.storage.sync.set({ currentServerId: request.serverId });
          
          qbtClient.initialize(server);
          qbtClient.restoreSession(server.qbitUrl);

          sendResponse({ success: true });
        }
      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message
        });
      }
      return true;
    },

    testConnection: async () => {
      const server = await getServerInfo();

      if (!server.qbitUrl) {
        sendResponse({ success: false, error: getMessage('noAddressSet') });
        return;
      }
      
      if (qbtClient.baseURL !== server.qbitUrl) {
        qbtClient.initialize(server);
      }

      const result = await qbtClient.testConnection();
      sendResponse(result);
      return true;
    },

    testServerConnectionDirect: async () => {
      const server = request.server;
  
      if (!server.qbitUrl) {
        sendResponse({ success: false, error: getMessage('noAddressSet') });
        return true;
      }
    
      const tempClient = new QBittorrentClient();
      tempClient.initialize(server);

      tempClient.isTestClient = true;
      await tempClient.restoreSession(server.qbitUrl);

      const connectionResult = await tempClient.testConnection();

      if (connectionResult.connected && (connectionResult.authenticated || !connectionResult.canLogin)) {
        sendResponse(connectionResult);
        return true;
      }
      
      if (server.qbitUsername && server.qbitPassword && connectionResult.canLogin) {
        const loginResult = await tempClient.login(server.qbitUsername, server.qbitPassword);
        
        if (loginResult.success) {
          sendResponse({
            ...connectionResult,
            authenticated: true,
            csrfEnabled: true,
            loginSuccess: true,
            message: getMessage('loginTestSuccess')
          });
        } else {
          sendResponse({
            ...connectionResult,
            loginSuccess: false,
            loginError: loginResult.error,
            message: getMessage('connectionOkLoginFailed')
          });
        }
      } else {
        sendResponse(connectionResult);
      }
      
      return true;
    },

    setAutoRefresh: async () => {
      downloadManager.setAutoRefresh(request.enabled);
      sendResponse({ success: true });
    },

    getCurrentInterval: async () => {
      sendResponse({
        interval: downloadManager.currentInterval
      });
    },
    
    getLastUpdateTime: async () => {
      sendResponse({
        interval: downloadManager.lastUpdateTime
      });
    },

    getSpeedLimits: async () => {
      try {
        const transferResponse = await qbtClient.makeRequest('/api/v2/transfer/info');
        if (!transferResponse.ok) {
          throw new Error(`Failed to get transfer info: HTTP ${transferResponse.status}`);
        }
        
        const transferInfo = await transferResponse.json();
        const dlLimit = transferInfo.dl_rate_limit || 0;
        const upLimit = transferInfo.up_rate_limit || 0;
        const isAltSpeedMode = await qbtClient.getSpeedLimitsMode(); 

        sendResponse({
          success: true,
          downloadLimit: dlLimit,
          uploadLimit: upLimit,
          isEnabled: isAltSpeedMode,
          downloadLimitDisplay: dlLimit > 0 ? formatSpeed(dlLimit) : '∞',
          uploadLimitDisplay: upLimit > 0 ? formatSpeed(upLimit) : '∞'
        });

      } catch (error) {
        sendResponse({ 
          success: false,
          error: error.message,
          downloadLimit: 0,
          uploadLimit: 0,
          isEnabled: false,
          downloadLimitDisplay: '∞',
          uploadLimitDisplay: '∞'
        });
      }
    },

    toggleSpeedLimit: async () => {
      try {
        const response = await qbtClient.makeRequest('/api/v2/transfer/toggleSpeedLimitsMode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (!response.ok) {
          throw new Error(`Toggle failed: HTTP ${response.status}`);
        }

        const newModeResponse = await qbtClient.makeRequest('/api/v2/transfer/speedLimitsMode');
        const newSpeedMode = await newModeResponse.text();
        const newIsEnabled = newSpeedMode === '1';
        downloadManager.isAltSpeedMode = newIsEnabled;

        downloadManager.updateExtensionBadge();

        sendResponse({ 
          success: true,
          isEnabled: newIsEnabled,
          speedMode: newSpeedMode
        });

      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message
        });
      }
    },

    setSpeedLimitValues: async () => {
      try {
        const { downloadLimit, uploadLimit } = request;
        
        let dlSuccess = true;
        let upSuccess = true;
        
        if (downloadLimit !== undefined) {
          const dlResponse = await qbtClient.makeRequest('/api/v2/transfer/setDownloadLimit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `limit=${downloadLimit}`
          });
          dlSuccess = dlResponse.ok;
        }
        
        if (uploadLimit !== undefined) {
          const upResponse = await qbtClient.makeRequest('/api/v2/transfer/setUploadLimit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `limit=${uploadLimit}`
          });
          upSuccess = upResponse.ok;
        }
        
        sendResponse({ 
          success: dlSuccess && upSuccess,
          downloadLimit: downloadLimit || 0,
          uploadLimit: uploadLimit || 0
        });
      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message
        });
      }
    },

    setSequentialDownload: async () => {
      try {
        const response = await qbtClient.makeRequest('/api/v2/torrents/toggleSequentialDownload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `hashes=${request.hash}&value=${request.enabled}`
        });
        
        sendResponse({ success: response.ok });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    },

    addMagnet: async () => {
      const result = await addMagnetToServer(request.magnetLink, {
        sequential: request.sequential || false
      });
      sendResponse(result);
    },
    
    getDownloadStatus: async () => {
      try {
        const downloads = Array.from(downloadManager.activeDownloads.values());
        sendResponse({
          success: true,
          downloads: downloads,
          activeCount: downloads.length,
          lastUpdate: downloadManager.lastUpdateTime ? 
            downloadManager.lastUpdateTime.toISOString() : null,
          isConnected: downloadManager.isConnected
        });
      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message,
          downloads: [],
          activeCount: 0
        });
      }
    },

    refreshDownloads: async () => {
      try {
        await downloadManager.checkDownloadStatus(request.force || false, request.skipUpdateUI || false);
        
        const downloads = Array.from(downloadManager.activeDownloads.values());
        sendResponse({
          success: true,
          downloads: downloads,
          activeCount: downloads.length,
          lastUpdate: downloadManager.lastUpdateTime ? 
            downloadManager.lastUpdateTime.toISOString() : null,
          refreshed: true
        });
      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message,
          refreshed: false
        });
      }
    },

    pauseAllDownloads: async () => {
      try {
        const hashes = request.hashes.split('|');
        const promises = hashes.map(hash => 
          qbtClient.makeRequest('/api/v2/torrents/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `hashes=${hash}`
          })
        );
        
        await Promise.all(promises);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    },
    
    resumeAllDownloads: async () => {
      try {
        const hashes = request.hashes.split('|');
        const promises = hashes.map(hash => 
          qbtClient.makeRequest('/api/v2/torrents/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `hashes=${hash}`
          })
        );
        
        await Promise.all(promises);
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    },

    pauseDownload: async () => {
      try {
        const response = await qbtClient.makeRequest('/api/v2/torrents/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `hashes=${request.hash}`
        });
        
        sendResponse({ 
          success: response.ok,
          status: response.status
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    },
    
    resumeDownload: async () => {
      try {
        const response = await qbtClient.makeRequest('/api/v2/torrents/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `hashes=${request.hash}`
        });
        
        sendResponse({ 
          success: response.ok,
          status: response.status
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    },
    
    deleteDownload: async () => {
      try {
        const deleteFiles = request.deleteFiles || false;
        const endpoint = deleteFiles ? '/api/v2/torrents/delete' : '/api/v2/torrents/delete';
        
        const response = await qbtClient.makeRequest(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `hashes=${request.hash}&deleteFiles=${deleteFiles}`
        });
        
        sendResponse({ 
          success: response.ok,
          status: response.status
        });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    }
  };
  
  if (actions[request.action]) {
    actions[request.action]();
    return true;
  }
  
  sendResponse({ error: getMessage('unknownAction') });
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    if (changes.activeRefreshInterval || changes.inactiveRefreshInterval) {
      downloadManager.loadSettings().then(() => {
        if (downloadManager.isAutoRefresh) {
          downloadManager.restartMonitoring();
        }
      });
    }
    
    if (changes.autoRefresh) {
      downloadManager.setAutoRefresh(changes.autoRefresh.newValue);
    }
  }
});

function initialize(){
  qbtClient.loadSession().then(() => {
    qbtClient.testConnection().then(result => {
      const status = result.success ? 
        (result.authenticated || !result.canLogin ? 'connected' : 'needs-auth') : 
        'disconnected';
      status == 'connected' && qbtClient.getSpeedLimitsMode();
    });
  });
}

const qbtClient = new QBittorrentClient();
const downloadManager = new DownloadManager();

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    initialize();
  }
});