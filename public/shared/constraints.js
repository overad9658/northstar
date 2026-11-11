// Theory of Constraints vocabulary, shared by the server and the pages.
export const CONSTRAINT_STAGES = Object.freeze(['identify', 'exploit', 'subordinate', 'elevate', 'resolved']);
// Best first: a card that removes the constraint outranks one that eases it, and so on.
export const CONSTRAINT_RATINGS = Object.freeze(['removes', 'eases', 'neutral', 'adds_load']);
export const RATING_LABELS = Object.freeze({ removes: 'Removes', eases: 'Eases', neutral: 'Neutral', adds_load: 'Adds load' });

// Board order with the constraints first: cards on the highest-ranked open constraint, then by rating
// (removes, eases, neutral, adds_load, unrated), then `fallback`. constraintRanks maps a constraint id
// to its rank; a resolved constraint has none, so its cards sort with the unlinked ones.
export function compareByConstraint(constraintRanks, fallback) {
  const rankOf = (card) => constraintRanks.get(card.constraintId) ?? Infinity;
  const ratingOf = (card) => {
    const index = CONSTRAINT_RATINGS.indexOf(card.constraintRating);
    return index < 0 ? CONSTRAINT_RATINGS.length : index;
  };
  return (a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return ratingOf(a) - ratingOf(b) || fallback(a, b);
  };
}
