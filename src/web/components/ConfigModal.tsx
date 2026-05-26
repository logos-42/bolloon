import React, { useState, useEffect } from 'react';
import type { Provider, ProviderInfo } from './ApiConfig';
import { saveProviderConfig, testProviderConnection } from './ApiConfig';

interface ConfigModalProps {
  data: {
    key: string;
    provider: Provider;
    info: ProviderInfo;
  };
  onClose: () => void;
  onSave: () => void;
}

export function ConfigModal({ data, onClose, onSave }: ConfigModalProps) {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(data.provider.baseUrl || '');
  const [model, setModel] = useState(data.provider.model || '');
  const [temperature, setTemperature] = useState(String(data.provider.temperature || 0.7));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saveIndicator, setSaveIndicator] = useState(false);

  const hasExistingApiKey = Boolean(data.provider.apiKey);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const handleTest = async () => {
    setTestStatus('testing');
    setTestMessage('');

    try {
      const result = await testProviderConnection(data.key);
      if (result.success) {
        setTestStatus('success');
        setTestMessage(`连接成功！延迟: ${result.latency}ms`);
      } else {
        setTestStatus('error');
        setTestMessage(`连接失败: ${result.error}`);
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(`测试失败: ${err instanceof Error ? err.message : '未知错误'}`);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    const updateData: Partial<Provider> = {
      enabled: true,
      apiKey: apiKey.trim() || data.provider.apiKey || '',
      baseUrl: baseUrl.trim() || data.provider.baseUrl || '',
      model: model.trim() || data.provider.model || '',
      temperature: parseFloat(temperature) || 0.7,
    };

    try {
      await saveProviderConfig(data.key, updateData);
      setSaveIndicator(true);
      setTimeout(() => {
        onSave();
      }, 800);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  const testResultClasses = 'mt-3 p-3 text-sm rounded';
  const testSuccessClasses = 'bg-green-500/20 border border-green-500 text-green-500';
  const testErrorClasses = 'bg-red-500/20 border border-red-500 text-red-500';

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[90%] max-w-[480px] max-h-[90vh] overflow-y-auto bg-bg-sidebar border border-border rounded p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-text">配置 {data.info.name}</h2>
          <button
            onClick={onClose}
            className="bg-transparent border-none text-text-secondary cursor-pointer p-1 text-xl hover:text-text"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-text-secondary mb-1.5">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingApiKey ? '已有 Key（输入新值以更新）' : '输入 API Key'}
              className="w-full px-3 py-2.5 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
              autoComplete="off"
            />
            <div className="text-xs text-text-muted mt-1">留空则保留当前配置的 Key</div>
          </div>

          <div className="mb-4">
            <label className="block text-sm font-medium text-text-secondary mb-1.5">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className="w-full px-3 py-2.5 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
            />
            <div className="text-xs text-text-muted mt-1">留空使用默认地址</div>
          </div>

          <div className="flex gap-3 mb-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-secondary mb-1.5">模型</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="如 gpt-4"
                className="w-full px-3 py-2.5 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">温度</label>
              <input
                type="number"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                min="0"
                max="2"
                step="0.1"
                className="w-24 px-3 py-2.5 bg-bg border border-border rounded text-text text-sm focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleTest}
            disabled={testStatus === 'testing'}
            className="bg-transparent text-accent border border-accent px-4 py-2 text-xs mt-4 cursor-pointer hover:bg-accent hover:text-bg disabled:opacity-50"
          >
            {testStatus === 'testing' ? '测试中...' : '测试连接'}
          </button>

          {testStatus !== 'idle' && testMessage && (
            <div className={cn(testResultClasses, testStatus === 'success' ? testSuccessClasses : testErrorClasses)}>
              {testMessage}
            </div>
          )}

          <div className="flex gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-3 rounded text-sm font-medium cursor-pointer transition-all duration-200 bg-bg-active text-text border border-border hover:border-accent"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-3 rounded text-sm font-medium cursor-pointer transition-all duration-200 bg-accent text-bg hover:opacity-90"
            >
              {saveIndicator ? (
                <span className="flex items-center justify-center gap-1.5">
                  <span>✓</span>
                  <span>已保存</span>
                </span>
              ) : (
                '保存'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
