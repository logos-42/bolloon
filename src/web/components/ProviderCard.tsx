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
  const [isHovered, setIsHovered] = React.useState(false);

  const isConfigured = provider.enabled && provider.apiKey;
  const isEnabled = provider.enabled;

  return (
    <div
      className={cn(
        'relative group cursor-pointer rounded-xl transition-all duration-300',
        'border backdrop-blur-sm overflow-hidden',
        isActive
          ? 'border-accent/60 bg-gradient-to-br from-accent/10 via-bg-sidebar to-bg-sidebar shadow-lg shadow-accent/10'
          : 'border-border/50 bg-bg-sidebar/80 hover:border-border',
        isHovered && !isActive && 'border-accent/40 bg-bg-sidebar shadow-lg'
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onClick}
    >
      {/* Glow effect for active card */}
      {isActive && (
        <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent pointer-events-none" />
      )}

      {/* Hover shimmer effect */}
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent',
          'translate-x-[-100%] group-hover:translate-x-[200%] transition-transform duration-700',
          'pointer-events-none'
        )}
      />

      <div className="relative p-5">
        {/* Header row */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            {/* Provider icon placeholder */}
            <div
              className={cn(
                'w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold',
                'bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20',
                'text-accent'
              )}
            >
              {info.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <h3 className="text-base font-semibold text-text group-hover:text-white transition-colors">
                {info.name}
              </h3>
              <p className="text-xs text-text-muted mt-0.5">{info.description}</p>
            </div>
          </div>

          {/* Status badge */}
          <div
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
              'border backdrop-blur-sm transition-all duration-300',
              isActive
                ? 'bg-accent/20 border-accent/40 text-accent'
                : isEnabled
                ? 'bg-green-500/10 border-green-500/30 text-green-400'
                : 'bg-text-muted/10 border-text-muted/30 text-text-muted'
            )}
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                isActive ? 'bg-accent animate-pulse' : isEnabled ? 'bg-green-400' : 'bg-text-muted'
              )}
            />
            {isActive ? '使用中' : isEnabled ? '已启用' : '未启用'}
          </div>
        </div>

        {/* Status row */}
        <div className="flex items-center justify-between pt-3 border-t border-border/30">
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            {/* Config status */}
            <div className="flex items-center gap-1.5">
              <svg
                className={cn(
                  'w-3.5 h-3.5 transition-colors',
                  isConfigured ? 'text-green-400' : 'text-text-muted/50'
                )}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                {isConfigured ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                )}
              </svg>
              <span className={isConfigured ? 'text-green-400/80' : ''}>
                {isConfigured ? '已配置 API Key' : '未配置 API Key'}
              </span>
            </div>

            {/* Model info */}
            {provider.model && (
              <div className="flex items-center gap-1.5 text-text-muted">
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                <span>{provider.model}</span>
              </div>
            )}
          </div>

          {/* Arrow indicator */}
          <div
            className={cn(
              'flex items-center justify-center w-8 h-8 rounded-lg',
              'bg-bg-active/50 border border-border/50',
              'transition-all duration-300',
              'group-hover:translate-x-0.5 group-hover:bg-accent/20 group-hover:border-accent/40',
              isHovered && 'text-accent'
            )}
          >
            <svg
              className={cn(
                'w-4 h-4 text-text-muted transition-transform duration-300',
                'group-hover:text-accent'
              )}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
