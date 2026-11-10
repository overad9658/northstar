// Card order inside a column: ranked cards first by rank, then unranked cards by position; ties by id.
// The API sorts the same way (kanban-service list); the page sorts again because "All boards"
// merges columns from several teams.
export function compareCards(a, b) {
  const ra = a.rank ?? null;
  const rb = b.rank ?? null;
  if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  if ((ra === null) !== (rb === null)) return ra === null ? 1 : -1;
  if (ra === null && a.position !== b.position) return (a.position ?? 0) - (b.position ?? 0);
  return a.id - b.id;
}

// The ranks to write so `cardId` shows at `index` in its column, where `column` is the column's
// cards in display order. Returns [{ id, rank }] for the cards whose rank must change: the moved card
// takes a rank between its new neighbours (their midpoint when there is room). Unranked cards above
// it are ranked in their current order, and ranked cards below are pushed down only when they would
// otherwise come first. Cards further down keep their ranks; unranked cards below stay unranked.
export function ranksForMove(column, cardId, index) {
  const moving = column.find((card) => card.id === cardId);
  if (!moving) return [];
  const others = column.filter((card) => card.id !== cardId);
  const target = Math.max(0, Math.min(index, others.length));
  const order = [...others.slice(0, target), moving, ...others.slice(target)];
  const changes = [];
  const assign = (card, rank) => { if ((card.rank ?? null) !== rank) changes.push({ id: card.id, rank }); };
  let previous = -1;
  for (let at = 0; at < order.length; at += 1) {
    const card = order[at];
    if (at < target) {
      const rank = card.rank ?? null;
      previous = rank !== null && rank > previous ? rank : previous + 1;
      assign(card, previous);
    } else if (at === target) {
      const below = order[at + 1]?.rank ?? null;
      const current = card.rank ?? null;
      // Keep the moved card's rank when it already sits between its neighbours.
      if (current !== null && current > previous && (below === null || current < below)) previous = current;
      else previous = below !== null && below - previous >= 2 ? Math.floor((previous + below) / 2) : previous + 1;
      assign(card, previous);
    } else {
      const rank = card.rank ?? null;
      if (rank === null || rank > previous) break;
      previous += 1;
      assign(card, previous);
    }
  }
  return changes;
}
