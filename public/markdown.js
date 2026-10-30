// A small Markdown renderer for Northstar's own docs. It parses into plain objects and builds DOM nodes
// with createElement and textContent only, so raw HTML in the source is shown as text, never parsed.

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// Only http(s) URLs and in-page anchors become links; anything else (javascript:, data:, relative paths) stays text.
export function safeHref(href) {
  const value = String(href || '').trim();
  if (/^#[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'section';
}

function plainText(nodes) {
  return nodes.map((node) => (node.children ? plainText(node.children) : node.text)).join('');
}

export function parseInline(source) {
  const nodes = [];
  let text = '';
  const flush = () => { if (text) nodes.push({ type: 'text', text }); text = ''; };
  for (let index = 0; index < source.length;) {
    const rest = source.slice(index);
    if (rest[0] === '\\' && /^[\\`*_[\]()#|!<>-]/.test(rest[1] || '')) { text += rest[1]; index += 2; continue; }
    const code = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/);
    if (code) { flush(); nodes.push({ type: 'code', text: code[2].trim() || code[2] }); index += code[0].length; continue; }
    const strong = rest.match(/^\*\*(?=\S)([\s\S]*?\S)\*\*/);
    if (strong) { flush(); nodes.push({ type: 'strong', children: parseInline(strong[1]) }); index += strong[0].length; continue; }
    const link = rest.match(/^\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/);
    if (link) {
      flush();
      const children = parseInline(link[1]);
      const href = safeHref(link[2]);
      if (href) nodes.push({ type: 'link', href, children });
      else nodes.push(...children);
      index += link[0].length;
      continue;
    }
    text += rest[0];
    index += 1;
  }
  flush();
  return nodes;
}

// Splits a table row on pipes outside code spans; `\|` is a literal pipe.
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '\\' && row[index + 1] === '|') { cell += '|'; index += 1; continue; }
    if (character === '`') inCode = !inCode;
    if (character === '|' && !inCode) { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line)
  || (line.trim().startsWith('|') && TABLE_RULE.test(next || ''));

export function parseMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const slugs = new Map();
  const uniqueId = (text) => {
    const base = slugify(text);
    const count = slugs.get(base) || 0;
    slugs.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  };

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) body.push(lines[index++]);
      index += 1;
      blocks.push({ type: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const children = parseInline(heading[2]);
      blocks.push({ type: 'heading', level: heading[1].length, id: uniqueId(plainText(children)), children });
      index += 1;
      continue;
    }

    if (line.trim().startsWith('|') && TABLE_RULE.test(lines[index + 1] || '')) {
      const head = splitRow(line).map(parseInline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) rows.push(splitRow(lines[index++]).map(parseInline));
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items = [];
      while (index < lines.length) {
        const current = lines[index].match(LIST_ITEM);
        if (current && /\d/.test(current[2]) === ordered) { items.push(current[3]); index += 1; continue; }
        if (!current && /^\s{2,}\S/.test(lines[index]) && items.length) { items[items.length - 1] += ` ${lines[index].trim()}`; index += 1; continue; }
        break;
      }
      blocks.push({ type: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) paragraph.push(lines[index++].trim());
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
  }
  return blocks;
}

function appendInline(doc, parent, nodes) {
  for (const node of nodes) {
    if (node.type === 'text') { parent.appendChild(doc.createTextNode(node.text)); continue; }
    const tag = { code: 'code', strong: 'strong', link: 'a' }[node.type];
    const element = doc.createElement(tag);
    if (node.type === 'code') element.textContent = node.text;
    else appendInline(doc, element, node.children);
    if (node.type === 'link') {
      element.setAttribute('href', node.href);
      if (!node.href.startsWith('#')) {
        element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer');
      }
    }
    parent.appendChild(element);
  }
}

// Returns the rendered fragment and the headings (for a table of contents).
export function renderMarkdown(source, doc = document) {
  const fragment = doc.createDocumentFragment();
  const headings = [];
  for (const block of parseMarkdown(source)) {
    if (block.type === 'heading') {
      const element = doc.createElement(`h${block.level}`);
      element.setAttribute('id', block.id);
      appendInline(doc, element, block.children);
      const anchor = doc.createElement('a');
      anchor.setAttribute('href', `#${block.id}`);
      anchor.setAttribute('class', 'heading-anchor');
      anchor.setAttribute('aria-label', 'Link to this section');
      anchor.textContent = '#';
      element.appendChild(anchor);
      headings.push({ level: block.level, id: block.id, text: plainText(block.children) });
      fragment.appendChild(element);
    } else if (block.type === 'paragraph') {
      const element = doc.createElement('p');
      appendInline(doc, element, block.children);
      fragment.appendChild(element);
    } else if (block.type === 'list') {
      const element = doc.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendInline(doc, li, item);
        element.appendChild(li);
      }
      fragment.appendChild(element);
    } else if (block.type === 'table') {
      const wrapper = doc.createElement('div');
      wrapper.setAttribute('class', 'docs-table');
      const table = doc.createElement('table');
      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const cell of block.head) {
        const th = doc.createElement('th');
        appendInline(doc, th, cell);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      const tbody = doc.createElement('tbody');
      for (const row of block.rows) {
        const tr = doc.createElement('tr');
        for (const cell of row) {
          const td = doc.createElement('td');
          appendInline(doc, td, cell);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(thead);
      table.appendChild(tbody);
      wrapper.appendChild(table);
      fragment.appendChild(wrapper);
    } else {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (block.lang) code.setAttribute('class', `language-${block.lang}`);
      code.textContent = block.text;
      pre.appendChild(code);
      fragment.appendChild(pre);
    }
  }
  return { fragment, headings };
}
