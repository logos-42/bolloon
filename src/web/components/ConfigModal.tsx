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
  const [temperature, setTemperature] = useState(String(data.provider.temperature ?? 0.7));
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saveIndicator, setSaveIndicator] = useState(false);

  const hasExistingApiKey = Boolean(data.provider.apiKey);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

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
        setTestMessage(result.error || '连接失败');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : '测试失败');
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
        onClose();
        onSave();
      }, 800);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title-group">
            <div className="modal-icon">
              {data.info.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h2>配置 {data.info.name}</h2>
              <p className="modal-subtitle">{data.info.description}</p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSave} className="modal-form">
          <div className="form-group">
            <label>
              <span className="label-icon">🔑</span>
              API Key
              {hasExistingApiKey && <span className="configured-tag">已配置</span>}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingApiKey ? '已有 Key（输入新值以更新）' : '输入 API Key'}
              autoComplete="off"
            />
            <p className="form-hint">留空则保留当前配置的 Key</p>
          </div>

          <div className="form-group">
            <label>
              <span className="label-icon">🌐</span>
              Base URL
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
            />
            <p className="form-hint">留空使用默认地址</p>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>
                <span className="label-icon">🤖</span>
                模型
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="如 gpt-4"
              />
            </div>
            <div className="form-group form-group-small">
              <label>
                <span className="label-icon">🌡️</span>
                温度
              </label>
              <input
                type="number"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                min="0"
                max="2"
                step="0.1"
              />
            </div>
          </div>

          <div className="form-group">
            <button type="button" onClick={handleTest} className="test-btn" disabled={testStatus === 'testing'}>
              {testStatus === 'testing' ? (
                <>
                  <span className="spinner"></span>
                  测试中...
                </>
              ) : '⚡ 测试连接'}
            </button>

            {testStatus !== 'idle' && (
              <div className={`test-result test-${testStatus}`}>
                <span className="result-icon">{testStatus === 'success' ? '✓' : '✗'}</span>
                {testMessage}
              </div>
            )}
          </div>

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn-cancel">取消</button>
            <button type="submit" className="btn-save">
              {saveIndicator ? '✓ 已保存' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
