export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\s\x00-\x1f\x7f]/.test(value)) return '/';
  try {
    const url = new URL(value, 'https://northstar.invalid');
    return url.origin === 'https://northstar.invalid' ? url.pathname + url.search + url.hash : '/';
  } catch { return '/'; }
}
