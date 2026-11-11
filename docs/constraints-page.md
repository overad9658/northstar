# The Constraints page

A register for the Theory of Constraints: find the #1 constraint, exploit it, subordinate the
rest to it, elevate it, then repeat with the next one. The page shows which constraint is #1, how
far it has come, whether its measure is moving, and what work is aimed at it. A scan answers:

| Where the eye goes | The reader asks | The page answers with |
| --- | --- | --- |
| The outlined row at the top | What limits us most right now? | The #1 constraint, the only row in the page's accent colour, with its rank, name and owner. |
| The five steps on each row | How far along is it? | Identify, Exploit, Subordinate, Elevate, Resolved. The current step is filled; earlier ones read as done. |
| The trend box | Is it getting better? | The measure in words, and when it names a Progress metric: the latest reading, the change since the one before (coloured by the metric's direction) and a 30-day line. |
| The counts and card list | Is the work aimed at it? | Open linked cards per rating (removes, eases, neutral, adds load, not rated), then each card with its rating, linking to it on the board. Done cards are struck through. |
| The line under the title | What does the board still owe? | How many open cards have no rating and how many sit on a resolved constraint. It links to the board in constraint order. |
| Evidence and history | Why do we believe this, and when did it move? | Evidence opens on the #1 and folds on the rest. The history lists each stage with its date; the note is on hover. |
| Resolved, at the bottom | What did we already clear? | Folded list of resolved constraints, each with its date and a link when cards still need re-rating. |

## Ranks and stages

- Open constraints hold the ranks 1..n with no gaps, so there is always exactly one #1. Placing a
  constraint at a rank moves the others down.
- Resolving a constraint takes it out of the order; the next one becomes #1. Its cards keep the
  link, so the board audit can ask for them to be re-rated against the new #1.
- Reopening a resolved constraint puts it back last, unless the call gives a rank.

## On the board

Each card linked to a constraint shows a small chip: the constraint's rank and the card's rating,
for example `#1 Removes`. Removes and eases read green, adds load reads coral, and a card on a
resolved constraint shows a dashed chip. **Order: Constraint first** (shown once any constraint
exists, kept in the address as `?order=constraint`) sorts each column by constraint rank, then
rating (removes, eases, neutral, adds load, not rated), then the usual board order. Dragging
within a column sets ranks only in board order.

## Data

The page reads `GET /api/constraints` and refreshes on `constraints` and `kanban` change events.
Agents write through the MCP tools `upsert_constraint`, `set_constraint_stage` and `upsert_card`;
see the API and MCP docs.
