let i18nCache = {
  normalSend: 'Send to qBit',
  sequentialSend: 'Sequential'
};

let scannedMagnets = [];
let buttonsContainer = null;
let currentHoverElement = null;
let currentMagnetData = null;
let hoverTimeout = null;
let floatyQuickButtonEnabled = true;
let i18nLoaded = false;

async function getQuickButtonSettings() {
  try {
    const result = await chrome.storage.sync.get(['enableFloatyQuickButton']);
    floatyQuickButtonEnabled = result.enableFloatyQuickButton === true;
    return floatyQuickButtonEnabled;
  } catch (error) {
    console.error('Failed to load scan settings:', error);
    return false;
  }
}

async function initialize() {
  await getQuickButtonSettings();

  if (!floatyQuickButtonEnabled) {
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      await loadI18nMessages();
      setTimeout(scanPageForMagnets, 100);
    });
  } else {
    setTimeout(async () => {
      await loadI18nMessages();
      scanPageForMagnets();
    }, 100);
  }
}

async function loadI18nMessages() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'getI18nMessages',
      keys: ['normalSendButton', 'sequentialSendButton']
    });

    if (response?.success) {
      i18nCache = {
        normalSend: response.messages.normalSendButton || i18nCache.normalSend,
        sequentialSend: response.messages.sequentialSendButton || i18nCache.sequentialSend
      };
      i18nLoaded = true;
    }
  } catch (error) {
    console.log('Failed to load i18n messages:', error);
  }
}

function initButtonsContainer(element) {
  if (buttonsContainer) return;
  buttonsContainer = document.createElement('div');
  buttonsContainer.style.cssText = `
    position: absolute;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    backdrop-filter: blur(4px);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    pointer-events: none;
  `;
  document.body.appendChild(buttonsContainer);
  const normalBtn = createButton(i18nCache.normalSend, false);

  const sequentialBtn = createButton(i18nCache.sequentialSend, true);
  normalBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToQBittorrent(element._magnetData.link, false);
    hideButtons();
  });

  sequentialBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToQBittorrent(element._magnetData.link, true);
    hideButtons();
  });
  buttonsContainer.appendChild(normalBtn);
  buttonsContainer.appendChild(sequentialBtn);
  buttonsContainer.addEventListener('mouseenter', () => {
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
  });
  buttonsContainer.addEventListener('mouseleave', () => {
    hoverTimeout = setTimeout(() => {
      hideButtons();
    }, 200);
  });
}

function createButton(text, isSequential) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `
    padding: 6px 12px;
    background: ${isSequential ? '#f5f5f5' : '#2196F3'};
    color: ${isSequential ? '#333' : 'white'};
    border: 1px solid ${isSequential ? '#ddd' : '#1976D2'};
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s ease;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    pointer-events: auto;
    font-family: inherit;
  `;
  btn.addEventListener('mouseenter', () => {
    btn.style.background = isSequential ? '#e8e8e8' : '#1976D2';
    btn.style.borderColor = isSequential ? '#ccc' : '#0d47a1';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.background = isSequential ? '#f5f5f5' : '#2196F3';
    btn.style.borderColor = isSequential ? '#ddd' : '#1976D2';
  });

  return btn;
}

function showButtons(element) {
  if (!element._hasContainer) {
    initButtonsContainer(element);
    element._hasContainer = true;
  }

  buttonsContainer.style.display = 'flex';
  const rect = element.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
  const containerHeight = buttonsContainer.offsetHeight;
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;

  let top;
  if (spaceAbove >= containerHeight + 10) {
    top = rect.top + scrollTop - containerHeight - 8;
  } else if (spaceBelow >= containerHeight + 10) {
    top = rect.bottom + scrollTop + 8;
  } else {
    top = rect.top + scrollTop - containerHeight - 8;
  }

  buttonsContainer.style.top = Math.max(5, top) + 'px';
  buttonsContainer.style.left = (rect.left + scrollLeft) + 'px';
  const containerRect = buttonsContainer.getBoundingClientRect();
  if (containerRect.right > window.innerWidth) {
    buttonsContainer.style.left = (window.innerWidth - containerRect.width - 10) + 'px';
  }
}

function setupMagnetElementEvents(magnet) {
  const element = magnet.element;
  if (magnet.isTextMagnet) return;
  element.removeEventListener('mouseenter', onMagnetMouseEnter);
  element.removeEventListener('mouseleave', onMagnetMouseLeave);
  element.addEventListener('mouseenter', onMagnetMouseEnter);
  element.addEventListener('mouseleave', onMagnetMouseLeave);
  element._magnetData = magnet;
}

function onMagnetMouseEnter(e) {
  const element = e.currentTarget;
  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }
  if (currentHoverElement && currentHoverElement !== element) {
    hideButtons();
  }
  currentHoverElement = element;
  showButtons(element);
}

function onMagnetMouseLeave(e) {
  hoverTimeout = setTimeout(() => {
    if (buttonsContainer && !buttonsContainer.matches(':hover')) {
      hideButtons();
    }
  }, 200);
}

function scanPageForMagnets() {
  const magnets = [];
  const seenLinks = new Set();

  const links = document.querySelectorAll('a[href^="magnet:"], a[href$=".torrent"], a[href*=".torrent?"]');

  links.forEach((link, index) => {
    const magnetLink = link.href;

    if (seenLinks.has(magnetLink)) return;
    seenLinks.add(magnetLink);

    let displayName = '';
    if (link.textContent && link.textContent.trim() &&
      !link.textContent.includes('magnet:')) {
      displayName = link.textContent.trim();
    }

    const sizeInfo = extractSizeInfo(link);

    magnets.push({
      link: magnetLink,
      displayName: displayName,
      element: link,
      index: index,
      size: sizeInfo
    });
  });

  scannedMagnets = magnets;
  if (floatyQuickButtonEnabled) {
    magnets.forEach(magnet => {
      if (magnet.element) {
        setupMagnetElementEvents(magnet);
      }
    });
  }

  const scripts = document.querySelectorAll('script');

  scripts.forEach(script => {
    const text = script.textContent;
    const base64Match = text.match(/["']([A-Za-z0-9+/=]+)["']/);
    if (base64Match) {
      try {
        const decoded = atob(base64Match[1]);
        if (decoded.startsWith('magnet:')) {
          magnets.push({
            link: decoded,
            displayName: 'Decoded magnet link',
            element: script
          });
        }
      } catch { }
    }
  });

  return magnets;
}

function hideButtons() {
  if (buttonsContainer) {
    buttonsContainer.style.display = 'none';
  }
  currentHoverElement = null;
  currentMagnetData = null;
}

function sendToQBittorrent(magnetLink, sequential) {
  chrome.runtime.sendMessage({
    action: 'addMagnet',
    magnetLink: magnetLink,
    sequential: sequential,
    force: false
  });
}

function extractSizeInfo(element) {
  let current = element;
  const sizeRegex = /(?:[\(\[]([\d.]+)[\s\u00A0]*([KMGT])(?![a-zA-Z])[\)\]]|([\d.]+)[\s\u00A0]*([KMGTP](?:B|iB)))/gi;
  const sizeSelectors = '.size-tag, [class*="size"], [class*="Size"], [id*="size"], [id*="Size"]';

  for (let i = 0, j = 0; i < 4, j < 10; i++, j++) {
    if (!current) break;

    if (j > 0 && current.children.length === 1) {
      current = current.parentElement;
      i--;
      continue;
    }

    const sizeTag = current.querySelector(sizeSelectors);
    if (sizeTag) {
      const tagText = sizeTag.textContent || sizeTag.innerText;
      const sizeMatch = tagText.match(sizeRegex);
      if (sizeMatch) {
        return sizeMatch[0];
      }
    }

    const text = current.textContent || '';
    const matches = text.match(sizeRegex);
    if (matches && matches[0]) {
      return matches[0];
    }
    current = current.parentElement;
  }

  return null;
}

function highlightMagnetElement(element) {
  const startRect = element.getBoundingClientRect();

  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      observer.disconnect();

      const endRect = element.getBoundingClientRect();
      const scrollDistance = Math.abs(startRect.top - endRect.top);
      const flashInterval = Math.max(100, Math.min(800, Math.log(scrollDistance + 1) * 100));

      let flashCount = 0;
      const flash = () => {
        element.style.boxShadow = '0 0 0 3px #00ff00 inset';

        setTimeout(() => {
          element.style.boxShadow = '';
          flashCount++;

          if (flashCount < 3) {
            setTimeout(flash, flashInterval);
          }
        }, flashInterval);
      };

      flash();
    }
  }, { threshold: 0.5 });

  observer.observe(element);
}

async function enableFloatingButton() {
  if (!i18nLoaded) await loadI18nMessages();
  if (scannedMagnets.length === 0) {
    scannedMagnets = scanPageForMagnets();
  }

  scannedMagnets.forEach(magnet => {
    if (magnet.element) {
      setupMagnetElementEvents(magnet);
    }
  });
}

function disableFloatingButton() {
  if (buttonsContainer) {
    buttonsContainer.remove();
    buttonsContainer = null;
  }

  scannedMagnets.forEach(magnet => {
    if (magnet.element) {
      magnet.element.removeEventListener('mouseenter', onMagnetMouseEnter);
      magnet.element.removeEventListener('mouseleave', onMagnetMouseLeave);
      delete magnet.element._magnetData;
      delete magnet.element._hasContainer;
    }
  });

  if (hoverTimeout) {
    clearTimeout(hoverTimeout);
    hoverTimeout = null;
  }

  currentHoverElement = null;
  currentMagnetData = null;
}

initialize();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanMagnets') {
    scannedMagnets = scanPageForMagnets();
    const magnets = scannedMagnets.map(magnet => {
      const { element, ...rest } = magnet;
      return rest;
    });

    sendResponse({ success: true, magnets });
    return true;
  }

  if (request.action === 'highlightMagnet') {
    const magnetIndex = request.magnetIndex;
    if (scannedMagnets[magnetIndex]) {
      highlightMagnetElement(scannedMagnets[magnetIndex].element);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Magnet not found' });
    }
    return true;
  }

  if (request.action === 'toggleFloatingButton') {
    floatyQuickButtonEnabled = request.enabled;

    if (floatyQuickButtonEnabled) {
      enableFloatingButton();
    } else {
      disableFloatingButton();
    }

    sendResponse({ success: true });
    return true;
  }
});