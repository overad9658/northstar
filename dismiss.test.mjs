import assert from 'node:assert/strict';
import test from 'node:test';
import { createDismissGroup } from './public/dismiss.js';

// Just enough DOM for the helper: nodes that know their parent, <details> that fire "toggle".
function fakeDocument() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    dispatch(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); return event; },
  };
}

function node(parent = null) {
  return { parent, focused: false, focus() { this.focused = true; }, contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; } };
}

function details() {
  const element = node();
  const summary = node(element);
  const panel = node(element);
  const handlers = [];
  element.summary = summary;
  element.panel = panel;
  element._open = false;
  Object.defineProperty(element, 'open', {
    get() { return this._open; },
    set(value) { const changed = this._open !== value; this._open = value; if (changed) handlers.forEach((handler) => handler()); },
  });
  element.querySelector = (selector) => (selector === 'summary' ? summary : null);
  element.addEventListener = (type, handler) => { if (type === 'toggle') handlers.push(handler); };
  summary.attributes = {};
  summary.setAttribute = (name, value) => { summary.attributes[name] = value; };
  return element;
}

const key = (name) => ({ key: name, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

test('a click outside closes the open menu, a click inside keeps it open', () => {
  const doc = fakeDocument();
  const menus = createDismissGroup(doc);
  const menu = details();
  menus.details(menu);
  menu.open = true;
  doc.dispatch('click', { target: menu.panel });
  assert.equal(menu.open, true);
  doc.dispatch('click', { target: node() });
  assert.equal(menu.open, false);
});

test('Esc closes the open menu and returns focus to its toggle', () => {
  const doc = fakeDocument();
  const menus = createDismissGroup(doc);
  const menu = details();
  menus.details(menu);
  menu.open = true;
  const event = doc.dispatch('keydown', key('Escape'));
  assert.equal(menu.open, false);
  assert.equal(menu.summary.focused, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.summary.attributes['aria-expanded'], 'false');
});

test('Esc with nothing open is left alone, and other keys do nothing', () => {
  const doc = fakeDocument();
  const menus = createDismissGroup(doc);
  const menu = details();
  menus.details(menu);
  assert.equal(doc.dispatch('keydown', key('Escape')).defaultPrevented, false);
  menu.open = true;
  doc.dispatch('keydown', key('Enter'));
  assert.equal(menu.open, true);
});

test('opening one menu closes any other, including a custom popover', () => {
  const doc = fakeDocument();
  const menus = createDismissGroup(doc);
  const first = details();
  const second = details();
  menus.details(first);
  menus.details(second);
  let popoverOpen = false;
  const popoverPanel = node();
  const popover = menus.add({ isOpen: () => popoverOpen, close: () => { popoverOpen = false; }, contains: (target) => popoverPanel.contains(target) });

  first.open = true;
  second.open = true;
  assert.equal(first.open, false);
  assert.equal(second.open, true);
  assert.equal(second.summary.attributes['aria-expanded'], 'true');

  popoverOpen = true;
  menus.opened(popover);
  assert.equal(second.open, false);
  first.open = true;
  assert.equal(popoverOpen, false);
});

test('closeAll closes everything and a missing element is ignored', () => {
  const doc = fakeDocument();
  const menus = createDismissGroup(doc);
  const menu = details();
  menus.details(menu);
  assert.equal(menus.details(null), null);
  menu.open = true;
  menus.closeAll();
  assert.equal(menu.open, false);
});
