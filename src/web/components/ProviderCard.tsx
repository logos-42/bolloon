import React from 'react';
import type { Provider, ProviderInfo } from './ApiConfig';

interface ProviderCardProps {
  providerKey: string;
  provider: Provider;
  info: ProviderInfo;
  isActive: boolean;
  onClick: () => void;
}

export function ProviderCard({
  providerKey,
  provider,
  info,
  isActive,
  onClick,
}: ProviderCardProps) {
  const isConfigured = provider.enabled && provider.apiKey;
  const isEnabled = provider.enabled;

  const getStatusBadge = () => {
    if (isActive) {
      return { text: '使用中', color: 'accent' };
    } else if (isEnabled && isConfigured) {
      return { text: '已启用', color: 'green' };
    } else if (isEnabled) {
      return { text: '已启用', color: 'yellow' };
    } else {
      return { text: '未启用', color: 'muted' };
    }
  };

  const badge = getStatusBadge();

  return (
    <div
      className="provider-card"
      onClick={onClick}
    >
      <div className="provider-header">
        <div className="provider-icon">
          {info.name.charAt(0).toUpperCase()}
        </div>
        <div className="provider-info">
          <h3 className="provider-name">{info.name}</h3>
          <p className="provider-desc">{info.description}</p>
        </div>
        <div className={`status-badge status-${badge.color}`}>
          <span className="status-dot"></span>
          {badge.text}
        </div>
      </div>

      <div className="provider-footer">
        <div className="config-status">
          <span className={`status-icon ${isConfigured ? 'configured' : 'not-configured'}`}>
            {isConfigured ? '✓' : '○'}
          </span>
          {isConfigured ? '已配置 API Key' : '未配置 API Key'}
        </div>
        {provider.model && (
          <div className="model-info">
            模型: {provider.model}
          </div>
        )}
        <div className="arrow-indicator">›</div>
      </div>
    </div>
  );
}
