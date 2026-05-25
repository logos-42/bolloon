export class ProviderCard extends HTMLElement {
    data = null;
    shadow = this.attachShadow({ mode: 'open' });
    static get observedAttributes() {
        return ['provider-key', 'provider-enabled', 'provider-api-key', 'provider-base-url',
            'provider-model', 'provider-temperature', 'provider-requires-api-key',
            'provider-name', 'provider-description', 'is-active'];
    }
    connectedCallback() {
        this.render();
        this.attachEvents();
    }
    getCSS() {
        return `
      :host {
        display: block;
      }

      .card {
        background: var(--bg-secondary, #222220);
        border: 1px solid var(--border, #3a3a36);
        border-radius: 8px;
        padding: 16px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .card:hover {
        border-color: var(--accent, #c4d640);
      }

      .card.active {
        border-color: var(--accent, #c4d640);
        background: var(--bg-tertiary, #333330);
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
        color: var(--text-primary, #d8d8c8);
      }

      .badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--accent, #c4d640);
        color: var(--bg-primary, #1a1a18);
      }

      .badge.active {
        background: #22c55e;
      }

      .card-desc {
        font-size: 12px;
        color: var(--text-secondary, #909088);
        margin-bottom: 12px;
      }

      .card-status {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary, #909088);
      }

      .status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #888;
      }

      .status-dot.enabled {
        background: #22c55e;
      }

      .status-dot.disabled {
        background: #888;
      }
    `;
    }
    render() {
        const key = this.getAttribute('provider-key') || '';
        const enabled = this.getAttribute('provider-enabled') === 'true';
        const apiKey = this.getAttribute('provider-api-key') || '';
        const name = this.getAttribute('provider-name') || key;
        const description = this.getAttribute('provider-description') || '供应商';
        const isActive = this.getAttribute('is-active') === 'true';
        this.data = {
            key,
            provider: { enabled, apiKey },
            info: { name, description },
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
    attachEvents() {
        const card = this.shadow.querySelector('.card');
        card?.addEventListener('click', () => {
            this.dispatchEvent(new CustomEvent('provider-click', {
                detail: { key: this.data?.key },
                bubbles: true,
                composed: true,
            }));
        });
    }
    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue !== newValue) {
            this.render();
            this.attachEvents();
        }
    }
}
customElements.define('provider-card', ProviderCard);
