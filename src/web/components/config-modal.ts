import type { Provider, ProviderInfo } from './types.js';
import { testProviderConnection, saveProviderConfig } from './types.js';

export interface ConfigModalData {
  key: string;
  provider: Provider;
  info: ProviderInfo;
}

export class ConfigModal extends HTMLElement {
  private currentProvider: string | null = null;
  private config: ConfigModalData | null = null;
  private hasExistingApiKey: boolean = false; // 改进: 使用布尔标志跟踪是否有现有 Key
  private shadow = this.attachShadow({ mode: 'open' });

  connectedCallback(): void {
    this.render();
    this.attachEvents();
  }

  show(data: ConfigModalData): void {
    this.currentProvider = data.key;
    this.config = data;
    // 记录是否有现有 API Key
    this.hasExistingApiKey = Boolean(data.provider.apiKey);

    const titleEl = this.shadow.getElementById('modal-title');
    const apiKeyEl = this.shadow.getElementById('api-key') as HTMLInputElement;
    const baseUrlEl = this.shadow.getElementById('base-url') as HTMLInputElement;
    const modelEl = this.shadow.getElementById('model') as HTMLInputElement;
    const tempEl = this.shadow.getElementById('temperature') as HTMLInputElement;
    const testResultEl = this.shadow.getElementById('test-result');

    if (titleEl) titleEl.textContent = `配置 ${data.info.name}`;
    // 改进: 不再显示掩码，改为空字段让用户决定是否更新
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

  private getCSS(): string {
    return `
      :host {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.7);
        z-index: 1000;
        align-items: center;
        justify-content: center;
      }

      :host(.show) {
        display: flex;
      }

      .modal {
        background: var(--bg-secondary, #222220);
        border: 1px solid var(--border, #3a3a36);
        border-radius: 12px;
        padding: 24px;
        width: 90%;
        max-width: 480px;
        max-height: 90vh;
        overflow-y: auto;
      }

      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
      }

      .modal-header h2 {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary, #d8d8c8);
        margin: 0;
      }

      .modal-close {
        background: none;
        border: none;
        color: var(--text-secondary, #909088);
        cursor: pointer;
        padding: 4px;
        font-size: 20px;
      }

      .modal-close:hover {
        color: var(--text-primary, #d8d8c8);
      }

      .form-group {
        margin-bottom: 16px;
      }

      .form-group label {
        display: block;
        font-size: 13px;
        font-weight: 500;
        margin-bottom: 6px;
        color: var(--text-secondary, #909088);
      }

      .form-group input,
      .form-group select {
        width: 100%;
        padding: 10px 12px;
        background: var(--bg-primary, #1a1a18);
        border: 1px solid var(--border, #3a3a36);
        border-radius: 6px;
        color: var(--text-primary, #d8d8c8);
        font-size: 14px;
        font-family: inherit;
        box-sizing: border-box;
      }

      .form-group input:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--accent, #c4d640);
      }

      .form-group input[type="password"] {
        font-family: monospace;
      }

      .form-hint {
        font-size: 11px;
        color: var(--text-muted, #606058);
        margin-top: 4px;
      }

      .form-row {
        display: flex;
        gap: 12px;
      }

      .form-row .form-group {
        flex: 1;
      }

      .btn-group {
        display: flex;
        gap: 12px;
        margin-top: 24px;
      }

      .btn {
        flex: 1;
        padding: 12px;
        border: none;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }

      .btn-primary {
        background: var(--accent, #c4d640);
        color: var(--bg-primary, #1a1a18);
      }

      .btn-primary:hover {
        opacity: 0.9;
      }

      .btn-secondary {
        background: var(--bg-tertiary, #333330);
        color: var(--text-primary, #d8d8c8);
        border: 1px solid var(--border, #3a3a36);
      }

      .btn-secondary:hover {
        border-color: var(--accent, #c4d640);
      }

      .btn-test {
        background: transparent;
        color: var(--accent, #c4d640);
        border: 1px solid var(--accent, #c4d640);
        padding: 8px 16px;
        font-size: 12px;
        margin-top: 16px;
      }

      .btn-test:hover {
        background: var(--accent, #c4d640);
        color: var(--bg-primary, #1a1a18);
      }

      .test-result {
        margin-top: 12px;
        padding: 12px;
        border-radius: 6px;
        font-size: 13px;
        display: none;
      }

      .test-result.show {
        display: block;
      }

      .test-result.success {
        background: rgba(34, 197, 94, 0.1);
        border: 1px solid #22c55e;
        color: #22c55e;
      }

      .test-result.error {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid #ef4444;
        color: #ef4444;
      }

      .save-indicator {
        display: none;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #22c55e;
      }

      .save-indicator.show {
        display: flex;
      }
    `;
  }

  private render(): void {
    this.shadow.innerHTML = `
      <style>${this.getCSS()}</style>
      <div class="modal">
        <div class="modal-header">
          <h2 id="modal-title">配置供应商</h2>
          <button class="modal-close" id="modal-close">&times;</button>
        </div>

        <form id="config-form">
          <div class="form-group">
            <label>API Key</label>
            <input type="password" id="api-key" placeholder="输入 API Key" autocomplete="off">
            <div class="form-hint">留空则保留当前配置的 Key</div>
          </div>

          <div class="form-group">
            <label>Base URL</label>
            <input type="text" id="base-url" placeholder="https://api.example.com/v1">
            <div class="form-hint">留空使用默认地址</div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>模型</label>
              <input type="text" id="model" placeholder="如 gpt-4">
            </div>
            <div class="form-group">
              <label>温度</label>
              <input type="number" id="temperature" min="0" max="2" step="0.1" value="0.7">
            </div>
          </div>

          <button type="button" class="btn btn-test" id="test-btn">测试连接</button>
          <div class="test-result" id="test-result"></div>

          <div class="btn-group">
            <button type="button" class="btn btn-secondary" id="cancel-btn">取消</button>
            <button type="submit" class="btn btn-primary">
              <span class="save-indicator" id="save-indicator">
                ✓ 已保存
              </span>
              <span id="save-text">保存</span>
            </button>
          </div>
        </form>
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
    // 改进: 只有用户输入新值时才更新 API Key，否则保留现有值
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
