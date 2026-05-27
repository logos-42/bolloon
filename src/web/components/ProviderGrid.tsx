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
    <div className="api-config-page">
      <div className="page-header">
        <div className="page-title-group">
          <h1>API 配置</h1>
          <div className="config-count-badge">
            {enabledCount}/{totalCount} 已配置
          </div>
        </div>
        <a href="/" className="back-link">
          <span>←</span> 返回主页
        </a>
      </div>

      <div className="provider-grid">
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
