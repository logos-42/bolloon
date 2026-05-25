import type { LLMConfig } from './types.js';
import { ProviderCard } from './provider-card.js';
import { ConfigModal } from './config-modal.js';

export class ProviderGrid extends HTMLElement {
  private config: LLMConfig | null = null;
  private shadow = this.attachShadow({ mode: 'open' });
  private modal: ConfigModal | null = null;

  connectedCallback(): void {
    this.render();
    this.attachEvents();
    this.loadConfig();
  }

  private render(): void {
    const pageHeaderClasses = 'flex items-center justify-between mb-8';
    const pageTitleClasses = 'text-2xl font-semibold text-text';
    const backLinkClasses = 'flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-text';
    const gridClasses = 'grid gap-4';
    const loadingClasses = 'flex flex-col items-center justify-center py-12 text-text-secondary gap-4';
    const spinnerClasses = 'w-8 h-8 border-2 border-border border-t-accent rounded-full animate-spin';
    const errorClasses = 'hidden flex flex-col items-center py-12 text-text-secondary gap-4';
    const errorIconClasses = 'text-5xl';
    const errorMsgClasses = 'text-base';
    const retryBtnClasses = 'px-6 py-3 bg-bg-active text-text border border-border rounded cursor-pointer hover:border-accent';

    this.shadow.innerHTML = `
      <div class="${pageHeaderClasses}">
        <h1 class="${pageTitleClasses}">API 配置</h1>
        <a href="/" class="${backLinkClasses}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          返回主页
        </a>
      </div>

      <div class="${gridClasses}" id="provider-grid">
        <div class="${loadingClasses}">
          <div class="${spinnerClasses}"></div>
          <span>加载中...</span>
        </div>
      </div>

      <div class="${errorClasses}" id="error-state">
        <div class="${errorIconClasses}">⚠️</div>
        <div class="${errorMsgClasses}">加载配置失败</div>
        <button class="${retryBtnClasses}" id="retry-btn">重试</button>
      </div>
    `;

    this.modal = new ConfigModal();
    this.appendChild(this.modal);
  }

  private attachEvents(): void {
    this.addEventListener('provider-click', ((e: CustomEvent) => {
      const key = e.detail.key as string;
      this.openConfig(key);
    }) as EventListener);

    this.addEventListener('config-saved', (() => {
      this.loadConfig();
    }) as EventListener);

    const retryBtn = this.shadow.getElementById('retry-btn');
    retryBtn?.addEventListener('click', () => this.loadConfig());
  }

  private async loadConfig(): Promise<void> {
    const grid = this.shadow.getElementById('provider-grid');
    const errorEl = this.shadow.getElementById('error-state');

    const loadingClasses = 'flex flex-col items-center justify-center py-12 text-text-secondary gap-4';
    const spinnerClasses = 'w-8 h-8 border-2 border-border border-t-accent rounded-full animate-spin';

    if (grid) {
      grid.innerHTML = `
        <div class="${loadingClasses}">
          <div class="${spinnerClasses}"></div>
          <span>加载中...</span>
        </div>
      `;
      grid.classList.add('loading');
    }
    if (errorEl) errorEl.classList.remove('show');

    try {
      const { fetchLLMConfig } = await import('./types.js');
      this.config = await fetchLLMConfig();
      this.renderProviders();
    } catch (err) {
      console.error('loadConfig failed:', err);
      if (grid) {
        grid.innerHTML = '';
        grid.classList.remove('loading');
      }
      if (errorEl) errorEl.classList.add('show');
    }
  }

  private renderProviders(): void {
    const grid = this.shadow.getElementById('provider-grid');
    if (!grid || !this.config) return;

    grid.classList.remove('loading');
    grid.innerHTML = '';

    const { providers, providerInfo, activeProvider } = this.config;

    Object.entries(providers).forEach(([key, p]) => {
      const info = providerInfo[key] || { name: key, description: '供应商', requiresApiKey: true };
      const isActive = activeProvider === key;

      const card = new ProviderCard();
      card.setAttribute('provider-key', key);
      card.setAttribute('provider-enabled', String(p.enabled));
      card.setAttribute('provider-api-key', p.apiKey || '');
      card.setAttribute('provider-base-url', p.baseUrl || '');
      card.setAttribute('provider-model', p.model || '');
      card.setAttribute('provider-temperature', String(p.temperature || 0.7));
      card.setAttribute('provider-requires-api-key', String(info.requiresApiKey));
      card.setAttribute('provider-name', info.name);
      card.setAttribute('provider-description', info.description);
      card.setAttribute('is-active', String(isActive));

      grid.appendChild(card);
    });
  }

  private openConfig(key: string): void {
    if (!this.config || !this.modal) return;

    const provider = this.config.providers[key];
    const info = this.config.providerInfo[key] || { name: key, description: '供应商', requiresApiKey: true };

    this.modal.show({
      key,
      provider,
      info,
    });
  }
}

customElements.define('provider-grid', ProviderGrid);