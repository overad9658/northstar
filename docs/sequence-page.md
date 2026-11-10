# The Sequence page

One list, in order, of what happens next across every board. A scan answers:

| Where the eye goes | The reader asks | The page answers with |
| --- | --- | --- |
| Down the Now column | What happens today, and who does it? | One boxed step per row, its owner in bold. The reader's own steps use the page's one accent colour. |
| Across a row | Why here, and what does it unlock? | Left: place, objective mark and a one-line reason (the full reason on hover). Middle: the cards it unblocks, in light text. Right: the outcome the chain reaches, with a target mark (empty when the card has none). |
| Dimmed rows | What is waiting on the clock, not a person? | Rows with a `waitUntil` still ahead: dimmed, with a dashed Now box. |
| Top right | Who holds the queue? | A bar per step for each person. **Mine** keeps only the reader's steps. The time of the last pass, with its scores on hover. |
| Small marks | What moved since the last pass? | ↑n or ↓n under the reason; the reason on hover. |
| Footer | What do the marks mean, and what is not ours? | The objective marks, once. Cards a pass left out of the order, for their owners. A quiet Design link when one is set. |

## Rows

- **Now** is the card itself: its owner (the assignee, "You" for the reader) and its next step,
  or its title when it has none. It links to the card on the board (`/kanban.html?card=<id>`).
- **Then** is the chain of cards it unblocks: the cards whose `blockedBy` names it, then the
  cards those unblock, up to three levels. Each part links to its card.
- **Reaches** is the card's `outcome`, with a target mark. A card without one leaves it empty: the
  objective already shows as the mark beside the reason.
- Only ranked, open cards appear. Archived cards and cards in a column named Done drop out; the
  next pass re-ranks.
- Rows are a fixed 72 px tall on wide screens, so the brackets line up. A thin line runs from the
  Now box through Then to Reaches, under the text, when the row has a Then or an outcome.

## Brackets

A quiet bracket in the left gutter joins a ranked card to a ranked card it unblocks, with an
arrowhead at the card it frees. Hover names both cards. Brackets are drawn only when both rows
are on screen, so Mine hides the rest. Overlapping brackets take separate lanes.

## Marks and colours

Each objective has one mark colour, by its place in the alphabetical list of objectives, so a
mark stays the same from one pass to the next. The accent colour means "you" and nothing else.
Light and dark themes share the layout; only the colours change.

## Moves

A card moves only when the pass reordered it: the latest run and the one before are compared
among the cards both ranked, so a card closing above it or a new card arriving does not count
as a move.

## Empty and narrow

- Before the first pass: "No order yet. It appears after the first pass."
- On a phone each row stacks one line of place, mark, reason and move, then the Now box, then
  Then, then Reaches; Mine stays on top.

## Live updates

The page listens for change events. A new run, or a change to a ranked card's rank, reasons,
blockers, owner, step or column, sends a `sequence` event and the page reloads its order
(polling every 10 seconds when the event stream is unavailable).

## Data

Cards carry `rank`, `objective`, `blockedBy`, `rankReason`, `reasonFull`, `waitUntil` and
`outcome`. Each pass is stored in `sequence_runs` (time, skill version, scores and the order it
set). The design link is the page setting `sequence.designUrl`. See [api.md](api.md#sequence).
