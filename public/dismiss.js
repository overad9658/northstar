// One dismiss behaviour for every dropdown and popover: a click or tap outside closes the open
// one, Esc closes it and returns focus to its toggle, and opening one closes any other.

export function createDismissGroup(doc = globalThis.document) {
  const items = [];
  const closeItem = (item, { focus = false } = {}) => {
    if (!item.isOpen()) return;
    item.close();
    if (focus) item.toggle()?.focus?.();
  };
  // Capture phase, so the check runs before a handler re-renders (and detaches) the clicked node.
  doc.addEventListener('click', (event) => {
    items.forEach((item) => { if (item.isOpen() && !item.contains(event.target)) closeItem(item); });
  }, true);
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = items.filter((item) => item.isOpen());
    if (!open.length) return;
    event.preventDefault();
    open.forEach((item) => closeItem(item, { focus: true }));
  });

  const group = {
    // isOpen/close/toggle are functions; contains(node) says whether a node belongs to the item
    // (its panel and its toggle). Call group.opened(item) whenever it opens.
    add({ isOpen, close, toggle = () => null, contains }) {
      const item = { isOpen, close, toggle, contains };
      items.push(item);
      return item;
    },
    opened(item) {
      items.forEach((other) => { if (other !== item) closeItem(other); });
    },
    closeAll() {
      items.forEach((item) => closeItem(item));
    },
    // A <details> menu: its <summary> is the toggle.
    details(element) {
      if (!element) return null;
      const summary = () => element.querySelector('summary');
      const item = group.add({
        isOpen: () => element.open,
        close: () => { element.open = false; },
        toggle: summary,
        contains: (node) => element.contains(node),
      });
      element.addEventListener('toggle', () => {
        summary()?.setAttribute('aria-expanded', String(element.open));
        if (element.open) group.opened(item);
      });
      return item;
    },
  };
  return group;
}
