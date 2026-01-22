class CustomI18n {
  constructor() {
    this.currentLanguage = 'auto';
    this.translations = {};
  }

  async init() {
    const result = await chrome.storage.sync.get('selectedLanguage');
    this.currentLanguage = result.selectedLanguage || 'auto';
    
    if(this.currentLanguage !== 'auto'){
      await this.loadTranslations();
    }
  }

  async loadTranslations() {
    const response = await fetch(chrome.runtime.getURL(`_locales/${this.currentLanguage}/messages.json`));
    if (response.ok) {
      this.translations[this.currentLanguage] = await response.json();
    } else {
      this.currentLanguage = 'auto';
    }
  }

  getMessage(key, substitutions = []) {
    if (this.currentLanguage === 'auto') {
      return chrome.i18n.getMessage(key, substitutions);
    }
    const langData = this.translations[this.currentLanguage] || this.translations.en;
    
    if (!langData || !langData[key]) {
      return chrome.i18n.getMessage(key, substitutions);
    }
    
    let message = langData[key].message;
    
    if (substitutions.length > 0) {
      substitutions.forEach((sub, index) => {
        message = message.replace(new RegExp(`\\$${index + 1}`, 'g'), sub);
      });
    }
    
    return message;
  }

  async setLanguage(languageCode) {
    this.currentLanguage = languageCode;
    if(this.currentLanguage !== 'auto'){
        await this.loadTranslations();
    }
  }
}

const customI18n = new CustomI18n();
globalThis.customI18n = customI18n;