import type { LLMConfig } from './types.js';
import { ProviderCard, type ProviderCardData } from './provider-card.js';
import { ConfigModal, type ConfigModalData } from './config-modal.js';

export class ProviderGrid extends HTMLElement {
  private config: LLMConfig | null = null;
  private shadow = this.attachShadow({ mode: 'open' });
  private modal: ConfigModal | null = null;

  connectedCallback(): void {
    this.render();
    this.attachEvents();
    this.loadConfig();
  }

  private getCSS(): string {
    return `
      :host {
        display: block;
        max-width: 900px;
        margin: 0 auto;
        padding: 24px;
      }

      .page-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 32px;
      }

      .page-header h1 {
        font-size: 24px;
        font-weight: 600;
        color: var(--text-primary, #d8d8c8);
        margin: 0;
      }

      .back-link {
        color: var(--text-secondary, #909088);
        text-decoration: none;
        font-size: 14px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .back-link:hover {
        color: var(--text-primary, #d8d8c8);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 16px;
      }

      .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 48px;
        color: var(--text-secondary, #909088);
        gap: 16px;
      }

      .loading-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--border, #3a3a36);
        border-top-color: var(--accent, #c4d640);
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .error-state {
        display: none;
        flex-direction: column;
        align-items: center;
        padding: 48px;
        color: var(--text-secondary, #909088);
        gap: 16px;
      }

      .error-state.show {
        display: flex;
      }

      .error-icon {
        font-size: 48px;
      }

      .error-message {
        font-size: 16px;
        color: var(--text-secondary, #909088);
      }

      .btn-retry {
        padding: 12px 24px;
        background: var(--bg-tertiary, #333330);
        color: var(--text-primary, #d8d8c8);
        border: 1px solid var(--border, #3a3a36);
        border-radius: 6px;
        cursor: pointer;
      }

      .btn-retry:hover {
        border-color: var(--accent, #c4d640);
      }
    `;
  }

  private render(): void {
    this.shadow.innerHTML = `
      <style>${this.getCSS()}</style>
      <div class="page-header">
        <h1>API 配置</h1>
        <a href="/" class="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          返回主页
        </a>
      </div>

      <div class="grid" id="provider-grid">
        <div class="loading-state">
          <div class="loading-spinner"></div>
          <span>加载中...</span>
        </div>
      </div>

      <div class="error-state" id="error-state">
        <div class="error-icon">⚠️</div>
        <div class="error-message">加载配置失败</div>
        <button class="btn-retry" id="retry-btn">重试</button>
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

    this.addEventListener('config-saved', ((e: CustomEvent) => {
      this.loadConfig();
    }) as EventListener);

    const retryBtn = this.shadow.getElementById('retry-btn');
    retryBtn?.addEventListener('click', () => this.loadConfig());
  }

  private async loadConfig(): Promise<void> {
    const grid = this.shadow.getElementById('provider-grid');
    const errorEl = this.shadow.getElementById('error-state');

    if (grid) {
      grid.innerHTML = `
        <div class="loading-state">
          <div class="loading-spinner"></div>
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
