import type { Provider, ProviderInfo } from './types.js';
import { cn } from '../utils/cn.js';

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

    // 使用 Tailwind 类名 + cn 工具函数
    const cardClasses = cn(
      'block border rounded-sm p-4 cursor-pointer transition-all duration-200',
      'bg-bg-sidebar border-border hover:border-accent',
      isActive && 'border-accent bg-bg-active'
    );

    const cardHeaderClasses = 'flex items-center justify-between mb-2';
    const cardNameClasses = 'text-base font-semibold text-text';
    const badgeClasses = cn(
      'text-xs px-1.5 py-0.5 rounded',
      'bg-accent text-bg'
    );
    const cardDescClasses = 'text-xs text-text-secondary mb-3';
    const cardStatusClasses = 'flex items-center gap-1.5 text-xs text-text-secondary';
    const statusDotClasses = cn(
      'w-1.5 h-1.5 rounded-full',
      enabled ? 'bg-success' : 'bg-text-muted'
    );

    this.shadow.innerHTML = `
      <div class="${cardClasses}">
        <div class="${cardHeaderClasses}">
          <span class="${cardNameClasses}">${name}</span>
          ${isActive ? `<span class="${badgeClasses}">使用中</span>` : ''}
        </div>
        <div class="${cardDescClasses}">${description}</div>
        <div class="${cardStatusClasses}">
          <span class="${statusDotClasses}"></span>
          <span>${enabled ? '已启用' : '未启用'}</span>
          ${enabled && apiKey ? ' · 已配置' : ''}
          ${enabled && !apiKey ? ' · 未配置' : ''}
          ${!enabled ? ' · 点击配置' : ''}
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    const card = this.shadow.querySelector('[class*="cursor-pointer"]');
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