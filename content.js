let scannedMagnets = [];

function scanPageForMagnets() {
  const magnets = [];
  const seenLinks = new Set();
  
  const links = document.querySelectorAll('a[href^="magnet:"]');
  
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
      } catch {}
    }
  });
  
  return magnets;
}

function extractSizeInfo(element) {
  let current = element;
  const sizeRegex = /(?:[\(\[]([\d.]+)[\s\u00A0]*([KMGTP])(?![a-zA-Z])[\)\]]|([\d.]+)[\s\u00A0]*([KMGTP](?:B|iB)))/gi;
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scanMagnets') {
    const magnets = scanPageForMagnets();
    scannedMagnets = magnets;
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
});