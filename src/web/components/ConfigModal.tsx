import React, { useState, useEffect } from 'react';
import type { Provider, ProviderInfo } from './ApiConfig';
import { saveProviderConfig, testProviderConnection } from './ApiConfig';
import { cn } from '../utils/cn';

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
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const hasExistingApiKey = Boolean(data.provider.apiKey);

  useEffect(() => {
    requestAnimationFrame(() => setIsVisible(true));
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, []);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(onClose, 200);
  };

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
        handleClose();
        onSave();
      }, 800);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  };

  return (
    <div className={cn(
      'fixed inset-0 z-50 flex items-center justify-center p-4',
      'transition-opacity duration-200',
      isClosing ? 'opacity-0' : 'opacity-100'
    )}>
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={handleClose}
      />
      <div
        className={cn(
          'relative w-full max-w-lg rounded-2xl overflow-hidden',
          'bg-gradient-to-b from-bg-sidebar to-bg',
          'border border-border/50 shadow-2xl shadow-black/50',
          'transition-all duration-300',
          isVisible && !isClosing
            ? 'translate-y-0 opacity-100 scale-100'
            : 'translate-y-4 opacity-0 scale-95'
        )}
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-accent to-transparent" />

        <div className="relative px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20 flex items-center justify-center">
                <span className="text-accent font-bold text-lg">{data.info.name.charAt(0).toUpperCase()}</span>
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text">配置 {data.info.name}</h2>
                <p className="text-xs text-text-muted">{data.info.description}</p>
              </div>
            </div>
            <button
              onClick={handleClose}
              className="w-8 h-8 rounded-lg bg-bg-active/50 border border-border/50 flex items-center justify-center text-text-muted hover:text-text hover:border-border transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <form onSubmit={handleSave} className="px-6 pb-6">
          <div className="mb-5">
            <label className="flex items-center gap-2 text-sm font-medium text-text-secondary mb-2">
              <svg className="w-4 h-4 text-accent/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              API Key
              {hasExistingApiKey && (
                <span className="ml-auto text-xs text-green-400/70 bg-green-400/10 px-2 py-0.5 rounded-full">已配置</span>
              )}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasExistingApiKey ? '已有 Key（输入新值以更新）' : '输入 API Key'}
              className={cn(
                'w-full px-4 py-3 rounded-xl',
                'bg-bg border border-border/50',
                'text-text text-sm placeholder:text-text-muted/50',
                'focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20',
                'transition-all duration-200'
              )}
              autoComplete="off"
            />
            <p className="text-xs text-text-muted/60 mt-1.5">留空则保留当前配置的 Key</p>
          </div>

          <div className="mb-5">
            <label className="flex items-center gap-2 text-sm font-medium text-text-secondary mb-2">
              <svg className="w-4 h-4 text-accent/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Base URL
            </label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              className={cn(
                'w-full px-4 py-3 rounded-xl',
                'bg-bg border border-border/50',
                'text-text text-sm placeholder:text-text-muted/50',
                'focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20',
                'transition-all duration-200'
              )}
            />
            <p className="text-xs text-text-muted/60 mt-1.5">留空使用默认地址</p>
          </div>

          <div className="flex gap-4 mb-5">
            <div className="flex-1">
              <label className="flex items-center gap-2 text-sm font-medium text-text-secondary mb-2">
                <svg className="w-4 h-4 text-accent/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                模型
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="如 gpt-4"
                className={cn(
                  'w-full px-4 py-3 rounded-xl',
                  'bg-bg border border-border/50',
                  'text-text text-sm placeholder:text-text-muted/50',
                  'focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20',
                  'transition-all duration-200'
                )}
              />
            </div>
            <div className="w-28">
              <label className="flex items-center gap-2 text-sm font-medium text-text-secondary mb-2">
                <svg className="w-4 h-4 text-accent/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707" />
                </svg>
                温度
              </label>
              <input
                type="number"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                min="0"
                max="2"
                step="0.1"
                className={cn(
                  'w-full px-4 py-3 rounded-xl',
                  'bg-bg border border-border/50',
                  'text-text text-sm',
                  'focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20',
                  'transition-all duration-200'
                )}
              />
            </div>
          </div>

          <div className="mb-6">
            <button
              type="button"
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium',
                'border transition-all duration-200',
                testStatus === 'testing'
                  ? 'bg-accent/10 border-accent/30 text-accent/70 cursor-not-allowed'
                  : 'bg-transparent border-accent/30 text-accent hover:bg-accent/10 hover:border-accent/50'
              )}
            >
              {testStatus === 'testing' ? (
                <>
                  <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                  测试中...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  测试连接
                </>
              )}
            </button>

            {testStatus !== 'idle' && (
              <div
                className={cn(
                  'mt-3 p-4 rounded-xl border backdrop-blur-sm',
                  testStatus === 'success'
                    ? 'bg-green-500/10 border-green-500/30'
                    : 'bg-red-500/10 border-red-500/30'
                )}
              >
                <div className="flex items-center gap-2">
                  {testStatus === 'success' ? (
                    <svg className="w-5 h-5 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                  )}
                  <span className={testStatus === 'success' ? 'text-green-400' : 'text-red-400'}>
                    {testMessage}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-5.5">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-4 py-3 rounded-xl text-sm font-medium cursor-pointer transition-all duration-200 bg-bg-active/50 text-text border border-border/50 hover:border-border"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-3 rounded-xl text-sm font-medium cursor-pointer transition-all duration-200 bg-gradient-to-r from-accent to-accent/80 text-bg hover:opacity-90 shadow-lg shadow-accent/20"
            >
              {saveIndicator ? (
                <span className="flex items-center justify-center gap-1.5">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  已保存
                </span>
              ) : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
