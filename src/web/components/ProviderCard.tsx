import React from 'react';
import type { Provider, ProviderInfo } from './ApiConfig';
import { cn } from '../utils/cn';

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
  const cardClasses = cn(
    'block border rounded-sm p-4 cursor-pointer transition-all duration-200',
    'bg-bg-sidebar border-border hover:border-accent',
    isActive && 'border-accent bg-bg-active'
  );

  const badgeClasses = cn(
    'text-xs px-1.5 py-0.5 rounded',
    'bg-accent text-bg'
  );

  const statusDotClasses = cn(
    'w-1.5 h-1.5 rounded-full',
    provider.enabled ? 'bg-green-500' : 'bg-text-muted'
  );

  return (
    <div className={cardClasses} onClick={onClick}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-base font-semibold text-text">{info.name}</span>
        {isActive && <span className={badgeClasses}>使用中</span>}
      </div>
      <div className="text-xs text-text-secondary mb-3">{info.description}</div>
      <div className="flex items-center gap-1.5 text-xs text-text-secondary">
        <span className={statusDotClasses} />
        <span>{provider.enabled ? '已启用' : '未启用'}</span>
        {provider.enabled && provider.apiKey && ' · 已配置'}
        {provider.enabled && !provider.apiKey && ' · 未配置'}
        {!provider.enabled && ' · 点击配置'}
      </div>
    </div>
  );
}
