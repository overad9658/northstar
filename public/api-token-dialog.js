// The legacy API access dialog has two states. Before: explain the effect and offer Generate/Replace or Cancel.
// After a token is created: show it once with Copy and Done, and nothing left to replace or cancel.
export function apiTokenDialogState({ created = false, configured = false } = {}) {
  if (created) {
    return {
      buttons: { cancel: false, generate: false, done: true, copy: true },
      explanation: '',
      status: 'Your new token is active. Copy it now; it cannot be shown again.',
    };
  }
  return {
    buttons: { cancel: true, generate: true, done: false, copy: false },
    generateLabel: configured ? 'Replace token' : 'Generate token',
    explanation: configured
      ? 'Replacing revokes the current token immediately. If an environment token is configured, the new token replaces it.'
      : 'Generating creates one write token for scripts and agents. Northstar stores only a hash and shows the token once.',
  };
}
