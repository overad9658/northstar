(() => {
  const storageKey = 'northstar-theme';
  const root = document.documentElement;
  const systemTheme = () => window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

  let savedTheme = null;
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'light' || value === 'dark') savedTheme = value;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const dark = theme === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }

  applyTheme(savedTheme || systemTheme());

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(root.dataset.theme);
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        savedTheme = theme;
        try { localStorage.setItem(storageKey, theme); } catch { /* Keep the in-page choice. */ }
        applyTheme(theme);
      });
    });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (!savedTheme) applyTheme(event.matches ? 'dark' : 'light');
  });
})();
