import type { Provider, ProviderInfo } from './types.js';
import { testProviderConnection, saveProviderConfig } from './types.js';
import { cn } from '../utils/cn.js';

export interface ConfigModalData {
  key: string;
  provider: Provider;
  info: ProviderInfo;
}

export class ConfigModal extends HTMLElement {
  private currentProvider: string | null = null;
  private config: ConfigModalData | null = null;
  private hasExistingApiKey: boolean = false;
  private shadow = this.attachShadow({ mode: 'open' });

  connectedCallback(): void {
    this.render();
    this.attachEvents();
  }

  show(data: ConfigModalData): void {
    this.currentProvider = data.key;
    this.config = data;
    this.hasExistingApiKey = Boolean(data.provider.apiKey);

    const titleEl = this.shadow.getElementById('modal-title');
    const apiKeyEl = this.shadow.getElementById('api-key') as HTMLInputElement;
    const baseUrlEl = this.shadow.getElementById('base-url') as HTMLInputElement;
    const modelEl = this.shadow.getElementById('model') as HTMLInputElement;
    const tempEl = this.shadow.getElementById('temperature') as HTMLInputElement;
    const testResultEl = this.shadow.getElementById('test-result');

    if (titleEl) titleEl.textContent = `配置 ${data.info.name}`;
    if (apiKeyEl) {
      apiKeyEl.value = '';
      apiKeyEl.placeholder = this.hasExistingApiKey ? '已有 Key（输入新值以更新）' : '输入 API Key';
    }
    if (baseUrlEl) baseUrlEl.value = data.provider.baseUrl || '';
    if (modelEl) modelEl.value = data.provider.model || '';
    if (tempEl) tempEl.value = String(data.provider.temperature || 0.7);
    if (testResultEl) {
      testResultEl.classList.remove('show', 'success', 'error');
      testResultEl.textContent = '';
    }

    this.classList.add('show');
  }

  hide(): void {
    this.classList.remove('show');
    this.currentProvider = null;
    this.config = null;
  }

  private render(): void {
    // Tailwind 类名定义
    const hostClasses = 'hidden fixed inset-0 bg-black/70 z-50 items-center justify-center';
    const hostShowClasses = 'flex';
    const modalClasses = 'w-[90%] max-w-[480px] max-h-[90vh] overflow-y-auto bg-bg-sidebar border border-border rounded p-6';
    const headerClasses = 'flex items-center justify-between mb-6';
    const titleClasses = 'text-lg font-semibold text-text';
    const closeBtnClasses = 'bg-transparent border-none text-text-secondary cursor-pointer p-1 text-xl hover:text-text';
    const formGroupClasses = 'mb-4';
    const labelClasses = 'block text-sm font-medium text-text-secondary mb-1.5';
    const inputClasses = 'w-full px-3 py-2.5 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent';
    const hintClasses = 'text-xs text-text-muted mt-1';
    const formRowClasses = 'flex gap-3';
    const btnGroupClasses = 'flex gap-3 mt-6';
    const btnBaseClasses = 'flex-1 px-4 py-3 rounded text-sm font-medium cursor-pointer transition-all duration-200';
    const btnPrimaryClasses = 'bg-accent text-bg hover:opacity-90';
    const btnSecondaryClasses = 'bg-bg-active text-text border border-border hover:border-accent';
    const btnTestClasses = 'bg-transparent text-accent border border-accent px-4 py-2 text-xs mt-4 cursor-pointer hover:bg-accent hover:text-bg';
    const testResultClasses = 'mt-3 p-3 text-sm rounded hidden';
    const testSuccessClasses = 'bg-success-bg border border-success text-success';
    const testErrorClasses = 'bg-error-bg border border-error text-error';
    const saveIndicatorClasses = 'hidden items-center gap-1.5 text-sm text-success';
    const saveIndicatorShowClasses = 'flex';

    this.shadow.innerHTML = `
      <div class="${hostClasses} ${hostShowClasses}">
        <div class="${modalClasses}">
          <div class="${headerClasses}">
            <h2 id="modal-title" class="${titleClasses}">配置供应商</h2>
            <button class="${closeBtnClasses}" id="modal-close">&times;</button>
          </div>

          <form id="config-form">
            <div class="${formGroupClasses}">
              <label class="${labelClasses}">API Key</label>
              <input type="password" id="api-key" class="${inputClasses}" placeholder="输入 API Key" autocomplete="off">
              <div class="${hintClasses}">留空则保留当前配置的 Key</div>
            </div>

            <div class="${formGroupClasses}">
              <label class="${labelClasses}">Base URL</label>
              <input type="text" id="base-url" class="${inputClasses}" placeholder="https://api.example.com/v1">
              <div class="${hintClasses}">留空使用默认地址</div>
            </div>

            <div class="${formRowClasses}">
              <div class="${formGroupClasses} flex-1">
                <label class="${labelClasses}">模型</label>
                <input type="text" id="model" class="${inputClasses}" placeholder="如 gpt-4">
              </div>
              <div class="${formGroupClasses}">
                <label class="${labelClasses}">温度</label>
                <input type="number" id="temperature" class="${inputClasses}" min="0" max="2" step="0.1" value="0.7">
              </div>
            </div>

            <button type="button" class="${btnTestClasses}" id="test-btn">测试连接</button>
            <div id="test-result" class="${testResultClasses}"></div>

            <div class="${btnGroupClasses}">
              <button type="button" class="${btnBaseClasses} ${btnSecondaryClasses}" id="cancel-btn">取消</button>
              <button type="submit" class="${btnBaseClasses} ${btnPrimaryClasses}">
                <span class="${saveIndicatorClasses}" id="save-indicator">
                  ✓ 已保存
                </span>
                <span id="save-text">保存</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    const closeBtn = this.shadow.getElementById('modal-close');
    const cancelBtn = this.shadow.getElementById('cancel-btn');
    const testBtn = this.shadow.getElementById('test-btn');
    const form = this.shadow.getElementById('config-form');

    closeBtn?.addEventListener('click', () => this.hide());
    cancelBtn?.addEventListener('click', () => this.hide());
    testBtn?.addEventListener('click', () => this.testConnection());

    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveConfig();
    });

    this.addEventListener('click', (e) => {
      if (e.target === this) this.hide();
    });
  }

  private async testConnection(): Promise<void> {
    if (!this.currentProvider) return;

    const testBtn = this.shadow.getElementById('test-btn') as HTMLButtonElement;
    const resultEl = this.shadow.getElementById('test-result');

    if (testBtn) testBtn.disabled = true;
    if (resultEl) {
      resultEl.classList.add('show');
      resultEl.classList.remove('success', 'error');
      resultEl.textContent = '测试中...';
    }

    try {
      const result = await testProviderConnection(this.currentProvider);

      if (result.success) {
        if (resultEl) {
          resultEl.classList.remove('error');
          resultEl.classList.add('success');
          resultEl.textContent = `连接成功！延迟: ${result.latency}ms`;
        }
      } else {
        if (resultEl) {
          resultEl.classList.remove('success');
          resultEl.classList.add('error');
          resultEl.textContent = `连接失败: ${result.error}`;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      if (resultEl) {
        resultEl.classList.add('show', 'error');
        resultEl.textContent = `测试失败: ${message}`;
      }
    } finally {
      if (testBtn) testBtn.disabled = false;
    }
  }

  private async saveConfig(): Promise<void> {
    if (!this.currentProvider || !this.config) return;

    const apiKeyEl = this.shadow.getElementById('api-key') as HTMLInputElement;
    const baseUrlEl = this.shadow.getElementById('base-url') as HTMLInputElement;
    const modelEl = this.shadow.getElementById('model') as HTMLInputElement;
    const tempEl = this.shadow.getElementById('temperature') as HTMLInputElement;
    const indicatorEl = this.shadow.getElementById('save-indicator');
    const saveTextEl = this.shadow.getElementById('save-text');

    const currentConfig = this.config.provider;
    const newApiKey = apiKeyEl?.value?.trim();
    const updateData: Partial<Provider> = {
      enabled: true,
      apiKey: newApiKey || currentConfig.apiKey || '',
      baseUrl: baseUrlEl?.value || currentConfig.baseUrl || '',
      model: modelEl?.value || currentConfig.model || '',
      temperature: parseFloat(tempEl?.value || '0.7'),
    };

    try {
      await saveProviderConfig(this.currentProvider, updateData);

      if (indicatorEl) indicatorEl.classList.add('show');
      if (saveTextEl) saveTextEl.textContent = '保存';

      setTimeout(() => {
        this.hide();
        this.dispatchEvent(new CustomEvent('config-saved', {
          detail: { provider: this.currentProvider },
          bubbles: true,
          composed: true,
        }));
      }, 800);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }
}

customElements.define('config-modal', ConfigModal);