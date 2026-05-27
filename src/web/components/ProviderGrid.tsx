import React, { useState } from 'react';
import type { LLMConfig } from './ApiConfig';
import { ProviderCard } from './ProviderCard';
import { ConfigModal } from './ConfigModal';

interface ProviderGridProps {
  config: LLMConfig;
  onConfigSaved: () => void;
}

export function ProviderGrid({ config, onConfigSaved }: ProviderGridProps) {
  const [modalData, setModalData] = useState<{
    key: string;
    provider: LLMConfig['providers'][string];
    info: LLMConfig['providerInfo'][string];
  } | null>(null);

  const handleProviderClick = (key: string) => {
    const provider = config.providers[key];
    const info = config.providerInfo[key] || { name: key, description: '供应商', requiresApiKey: true };
    setModalData({ key, provider, info });
  };

  const handleModalClose = () => {
    setModalData(null);
  };

  const handleConfigSaved = () => {
    setModalData(null);
    onConfigSaved();
  };

  const enabledCount = Object.values(config.providers).filter(p => p.enabled && p.apiKey).length;
  const totalCount = Object.keys(config.providers).length;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="relative">
            <h1 className="text-2xl font-bold text-text">API 配置</h1>
            <div className="absolute -bottom-1 left-0 w-full h-px bg-gradient-to-r from-accent/50 to-transparent" />
          </div>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20">
            <span className="text-xs text-accent/80 font-medium">
              {enabledCount}/{totalCount} 已配置
            </span>
          </div>
        </div>
        <a
          href="/"
          className="group flex items-center gap-2 text-sm text-text-muted no-underline hover:text-accent transition-colors duration-200"
        >
          <svg
            className="w-4 h-4 transition-transform duration-200 group-hover:-translate-x-1"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          返回主页
        </a>
      </div>

      <div className="grid gap-4">
        {Object.entries(config.providers).map(([key, p], index) => {
          const info = config.providerInfo[key] || { name: key, description: '供应商', requiresApiKey: true };
          const isActive = config.activeProvider === key;

          return (
            <div
              key={key}
              className="animate-in fade-in slide-in-from-bottom-2"
              style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'both' }}
            >
              <ProviderCard
                providerKey={key}
                provider={p}
                info={info}
                isActive={isActive}
                onClick={() => handleProviderClick(key)}
              />
            </div>
          );
        })}
      </div>

      {modalData && (
        <ConfigModal
          data={modalData}
          onClose={handleModalClose}
          onSave={handleConfigSaved}
        />
      )}
    </div>
  );
}
