import type { Provider, ProviderInfo } from './types.js';

export interface ProviderCardData {
  key: string;
  provider: Provider;
  info: ProviderInfo;
  isActive: boolean;
}

export class ProviderCard extends HTMLElement {
  private data: ProviderCardData | null = null;
  private shadow = this.attachShadow({ mode: 'open' });

  static get observedAttributes() {
    return ['provider-key', 'provider-enabled', 'provider-api-key', 'provider-base-url',
            'provider-model', 'provider-temperature', 'provider-requires-api-key',
            'provider-name', 'provider-description', 'is-active'];
  }

  connectedCallback(): void {
    this.render();
    this.attachEvents();
  }

  private getCSS(): string {
    return `
      :host {
        display: block;
      }

      .card {
        background: var(--bg-sidebar);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 16px;
        cursor: pointer;
        transition: var(--transition);
      }

      .card:hover {
        border-color: var(--accent);
      }

      .card.active {
        border-color: var(--accent);
        background: var(--bg-active);
      }

      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }

      .card-name {
        font-size: 16px;
        font-weight: 600;
        color: var(--text);
      }

      .badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--accent);
        color: var(--bg);
      }

      .badge.active {
        background: var(--success);
      }

      .card-desc {
        font-size: 12px;
        color: var(--text-secondary);
        margin-bottom: 12px;
      }

      .card-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--text-muted);
      }

      .status-dot.enabled {
        background: var(--success);
      }

      .status-dot.disabled {
        background: var(--text-muted);
      }
    `;
  }

  private render(): void {
    const key = this.getAttribute('provider-key') || '';
    const enabled = this.getAttribute('provider-enabled') === 'true';
    const apiKey = this.getAttribute('provider-api-key') || '';
    const name = this.getAttribute('provider-name') || key;
    const description = this.getAttribute('provider-description') || '供应商';
    const isActive = this.getAttribute('is-active') === 'true';

    this.data = {
      key,
      provider: { enabled, apiKey } as Provider,
      info: { name, description } as ProviderInfo,
      isActive,
    };

    this.shadow.innerHTML = `
      <style>${this.getCSS()}</style>
      <div class="card ${isActive ? 'active' : ''}">
        <div class="card-header">
          <span class="card-name">${name}</span>
          ${isActive ? '<span class="badge active">使用中</span>' : ''}
        </div>
        <div class="card-desc">${description}</div>
        <div class="card-status">
          <span class="status-dot ${enabled ? 'enabled' : 'disabled'}"></span>
          <span>${enabled ? '已启用' : '未启用'}</span>
          ${enabled && apiKey ? ' · 已配置' : ''}
          ${enabled && !apiKey ? ' · 未配置' : ''}
          ${!enabled ? ' · 点击配置' : ''}
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    const card = this.shadow.querySelector('.card');
    card?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('provider-click', {
        detail: { key: this.data?.key },
        bubbles: true,
        composed: true,
      }));
    });
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    if (oldValue !== newValue) {
      this.render();
      this.attachEvents();
    }
  }
}

customElements.define('provider-card', ProviderCard);
