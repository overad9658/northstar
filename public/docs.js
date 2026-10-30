import { $ } from './browser-utils.js';
import { renderMarkdown } from './markdown.js';

const DOCS = ['api', 'mcp'];
const body = $('#docs-body');
const toc = $('#docs-toc');

function currentDoc() {
  const name = new URLSearchParams(location.search).get('doc');
  return DOCS.includes(name) ? name : 'api';
}

function renderToc(headings) {
  const list = document.createElement('ul');
  for (const heading of headings.filter((item) => item.level === 2 || item.level === 3)) {
    const item = document.createElement('li');
    item.className = `toc-level-${heading.level}`;
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.text;
    item.appendChild(link);
    list.appendChild(item);
  }
  toc.replaceChildren(list);
}

async function load(name, { keepHash = false } = {}) {
  for (const tab of document.querySelectorAll('[data-doc]')) {
    const selected = tab.dataset.doc === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  body.replaceChildren(document.createTextNode('Loading…'));
  const response = await fetch(`/api/docs/${name}`, { credentials: 'same-origin', cache: 'no-cache' });
  if (response.status === 401) {
    location.replace(`/login.html?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
    return;
  }
  if (!response.ok) {
    body.replaceChildren(document.createTextNode('This document could not be loaded.'));
    toc.replaceChildren();
    return;
  }
  const { fragment, headings } = renderMarkdown(await response.text());
  body.replaceChildren(fragment);
  renderToc(headings);
  if (keepHash && location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
}

for (const tab of document.querySelectorAll('[data-doc]')) {
  tab.addEventListener('click', () => {
    history.replaceState(null, '', `?doc=${tab.dataset.doc}`);
    load(tab.dataset.doc);
  });
}

load(currentDoc(), { keepHash: true });
