// Twind 配置 - 浏览器版本
twind.config({
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
      },
    },
  },
});