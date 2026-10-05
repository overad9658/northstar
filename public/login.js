import { requestJson } from './browser-utils.js';
import { safeReturnTo } from './login-utils.js';
const form = document.querySelector('#auth-form');
const status = await requestJson('/api/auth/status');
if (status.authenticated) location.replace('/');
const setup = status.setupRequired;
let signup = false;
const params = new URLSearchParams(location.search);
const returnTo = safeReturnTo(params.get('returnTo'));
if (params.has('ssoError')) document.querySelector('#auth-error').textContent = 'Single sign-on failed or expired. Please try again. If it continues, contact your administrator.';
if (!setup && status.ssoProviders?.length) {
  const providers = document.querySelector('#sso-providers');
  providers.hidden = false;
  for (const provider of status.ssoProviders) {
    const link = document.createElement('a');
    link.className = 'button secondary button-link';
    link.textContent = `Continue with ${provider.name}`;
    link.href = `/api/auth/sso/${encodeURIComponent(provider.id)}/login?returnTo=${encodeURIComponent(returnTo)}`;
    providers.append(link);
  }
  const divider = document.createElement('p'); divider.className = 'subtitle sso-divider'; divider.textContent = 'Or sign in with a Northstar account'; providers.append(divider);
}
if (setup) {
  document.querySelector('#auth-kicker').textContent = 'First-run setup';
  document.querySelector('#auth-title').textContent = 'Create the first admin';
  document.querySelector('#auth-copy').textContent = 'This account can manage users, edit projects, and control visibility.';
  document.querySelector('#auth-submit').textContent = 'Create admin account';
  form.elements.password.autocomplete = 'new-password';
}
const signupToggle = document.querySelector('#signup-toggle');
signupToggle.hidden = setup || !status.signupAllowed;
signupToggle.addEventListener('click', () => {
  signup = !signup;
  document.querySelector('#auth-kicker').textContent = signup ? 'Welcome to Northstar' : 'Welcome back';
  document.querySelector('#auth-title').textContent = signup ? 'Create an account' : 'Sign in';
  document.querySelector('#auth-copy').textContent = signup ? 'Your new account will have read-only access.' : 'Use your Northstar account to open the portfolio.';
  document.querySelector('#auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  document.querySelector('#auth-error').textContent = '';
  signupToggle.textContent = signup ? 'Already have an account? Sign in' : 'Create an account';
  form.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
});
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const error = document.querySelector('#auth-error'); error.textContent = ''; const button = document.querySelector('#auth-submit'); button.disabled = true;
  try {
    await requestJson(setup ? '/api/auth/setup' : signup ? '/api/auth/signup' : '/api/auth/login', { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(Object.fromEntries(new FormData(form))) });
    location.replace(returnTo);
  } catch (caught) { error.textContent = caught.message; button.disabled = false; }
});
