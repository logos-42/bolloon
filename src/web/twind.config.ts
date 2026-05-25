import { defineConfig, css, shortcut } from '@twind/core';

export default defineConfig({
  mode: 'inject',
  hash: false,

  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-sidebar': 'var(--bg-sidebar)',
        'bg-main': 'var(--bg-main)',
        'bg-hover': 'var(--bg-hover)',
        'bg-active': 'var(--bg-active)',
        text: 'var(--text)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        accent: 'var(--accent)',
        'accent-dark': 'var(--accent-dark)',
        'accent-hover': 'var(--accent-hover)',
        'user-bg': 'var(--user-bg)',
        'user-text': 'var(--user-text)',
        'ai-bg': 'var(--ai-bg)',
        'ai-text': 'var(--ai-text)',
        border: 'var(--border)',
        'border-light': 'var(--border-light)',
        success: 'var(--success)',
        'success-bg': 'var(--success-bg)',
        error: 'var(--error)',
        'error-bg': 'var(--error-bg)',
        warning: 'var(--warning)',
        'warning-bg': 'var(--warning-bg)',
        info: 'var(--info)',
        'info-bg': 'var(--info-bg)',
      },
      fontFamily: {
        sans: "'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif",
        mono: "'JetBrains Mono', monospace",
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
      },
      transitionDuration: {
        DEFAULT: '200',
      },
    },
  },

  shortcuts: {
    // 布局
    'flex-center': 'flex items-center justify-center',
    'flex-between': 'flex items-center justify-between',
    'flex-col': 'flex flex-col',

    // 按钮基础
    'btn-base': 'px-4 py-2 rounded font-medium cursor-pointer transition-all duration-200',
    'btn-primary': 'btn-base bg-accent text-bg hover:opacity-90',
    'btn-secondary': 'btn-base bg-bg-active text-text border border-border',
    'btn-sm': 'px-3 py-1 text-sm rounded font-medium cursor-pointer transition-all duration-200',

    // 卡片
    'card': 'bg-bg-sidebar border border-border rounded',

    // 状态
    'status-dot': 'w-1.5 h-1.5 rounded-full',

    // 动效（设计规范要求）
    'fade-in': 'transition-opacity duration-200',
  },
});

// 导出 css 模板函数供组件使用
export { css, shortcut };