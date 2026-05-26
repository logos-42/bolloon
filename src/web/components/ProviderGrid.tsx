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

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold text-text">API 配置</h1>
        <a
          href="/"
          className="flex items-center gap-1.5 text-sm text-text-secondary no-underline hover:text-text"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          返回主页
        </a>
      </div>

      <div className="grid gap-4">
        {Object.entries(config.providers).map(([key, p]) => {
          const info = config.providerInfo[key] || { name: key, description: '供应商', requiresApiKey: true };
          const isActive = config.activeProvider === key;

          return (
            <ProviderCard
              key={key}
              providerKey={key}
              provider={p}
              info={info}
              isActive={isActive}
              onClick={() => handleProviderClick(key)}
            />
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
