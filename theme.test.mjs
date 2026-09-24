import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const themeScript = await readFile(new URL('./public/theme.js', import.meta.url), 'utf8');

function runTheme({ systemDark = false, savedTheme = null } = {}) {
  const root = { dataset: {}, style: {} };
  const attributes = {};
  let clickListener;
  const button = {
    title: '',
    setAttribute(name, value) { attributes[name] = value; },
    addEventListener(type, listener) {
      assert.equal(type, 'click');
      clickListener = listener;
    },
  };
  let preferenceListener;
  const colorScheme = {
    matches: systemDark,
    addEventListener(type, listener) {
      assert.equal(type, 'change');
      preferenceListener = listener;
    },
  };
  let readyListener;
  let storedTheme = savedTheme;
  const context = {
    document: {
      documentElement: root,
      querySelectorAll(selector) {
        assert.equal(selector, '[data-theme-toggle]');
        return [button];
      },
      addEventListener(type, listener) {
        assert.equal(type, 'DOMContentLoaded');
        readyListener = listener;
      },
    },
    localStorage: {
      getItem(key) {
        assert.equal(key, 'northstar-theme');
        return storedTheme;
      },
      setItem(key, value) {
        assert.equal(key, 'northstar-theme');
        storedTheme = value;
      },
    },
    window: {
      matchMedia(query) {
        assert.equal(query, '(prefers-color-scheme: dark)');
        return colorScheme;
      },
    },
  };

  vm.runInNewContext(themeScript, context);
  readyListener();
  return {
    attributes,
    click: () => clickListener(),
    preferenceChange: (matches) => preferenceListener({ matches }),
    root,
    storedTheme: () => storedTheme,
  };
}

test('theme follows browser preference when the user has not chosen an override', () => {
  const theme = runTheme();
  const { root } = theme;
  assert.deepEqual(root.dataset, { theme: 'light' });
  assert.equal(root.style.colorScheme, 'light');

  theme.preferenceChange(true);
  assert.deepEqual(root.dataset, { theme: 'dark' });
  assert.equal(root.style.colorScheme, 'dark');
});

test('theme toggle stores a user override and ignores later browser changes', () => {
  const theme = runTheme({ systemDark: true, savedTheme: 'light' });
  const { root } = theme;
  assert.equal(root.dataset.theme, 'light');
  assert.equal(theme.attributes['aria-pressed'], 'false');

  theme.click();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(theme.storedTheme(), 'dark');
  assert.equal(theme.attributes['aria-pressed'], 'true');
  assert.equal(theme.attributes['aria-label'], 'Switch to light mode');

  theme.preferenceChange(false);
  assert.equal(root.dataset.theme, 'dark');
});
