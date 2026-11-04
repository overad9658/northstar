// Board search: "#12" or "12" finds card 12; any text also matches the title or card key (any case).
export function cardMatches(card, query) {
  const text = String(query ?? '').trim().toLocaleLowerCase();
  if (!text) return true;
  const number = /^#?(\d+)$/.exec(text);
  if (number && card.id === Number(number[1])) return true;
  if (text.startsWith('#') && number) return false;
  return String(card.title ?? '').toLocaleLowerCase().includes(text) || String(card.key ?? '').toLocaleLowerCase().includes(text);
}

// The card a page URL asks to open (?card=<id>), or null.
export function requestedCard(search) {
  const value = new URLSearchParams(search).get('card');
  return /^\d+$/.test(value ?? '') && Number(value) > 0 ? Number(value) : null;
}
