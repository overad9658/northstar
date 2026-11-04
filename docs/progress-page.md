# The Progress page

The Progress page answers five questions, in the order a reader asks them. Each part of the
page answers one question, and the eye moves through them in a Z: top left, across, down,
and bottom right. The text and the charts point at each other, so one pass answers all five.

| When | The reader asks | The page answers with |
| --- | --- | --- |
| First second | Are we OK? | A headline sentence and one status dot, top left |
| 1 to 5 seconds | What changed today? | Three bands of tiles, read left to right |
| 5 to 15 seconds | Why? | A "because" line under each change, linked to the day's report |
| After 15 seconds | How did we get here? | A focus chart with the full history and a milestone strip |
| End of the scan | What do I do now? | A "Waiting on you" list at the right of the tiles |

## 1. Are we OK? The headline

The headline says only what the tiles cannot: what is waiting on the reader, and, when it is
known, the cause of the day's worst move. For example: "Failed checks rose after the runner
update. 35 items are waiting on you." With nothing waiting, there is no headline.

The worst move is the biggest change in the wrong direction since the previous reading, divided
by the size of that reading (at least 1). Its cause is the tile's "because" line. Plurals follow
the count ("1 item is", "2 items are"). The status dot beside it uses the page's one accent color.

## 2. What changed today? Three bands

Metrics belong to one of three bands, read left to right as cause and effect: momentum (what
the team moved forward), health (whether the system is well) and trust (whether people can rely
on it). Each band is a column. Spacing separates the bands, so they need no headings. The bands
share one grid: a row of tiles lines up across the bands, and every row is as tall as its
tallest tile.

Each tile has the same layout, so the number sits in the same place in every tile:

1. A short label ("Shipped"). The full question ("How much have we shipped?") is the hover title.
2. The latest value in tabular figures, with its unit when the unit adds meaning.
3. The change since the previous reading as a signed number ("+3"). Its tint comes from the
   metric's direction, because up is good for some metrics and bad for others. No change shows
   no chip.
4. A small chart of the last 30 days. Values estimated from history are a dashed, lighter line.
5. The "because" line, or empty space when there is none.

A metric with no readings yet is an empty outline with a faint dotted baseline. The reason
("Not measured yet. Starts when …") is only in its hover title.

## 3. Why? The "because" line

Under each tile is one short line that explains the change. It comes from, in order: the note
on the day's reading, a line of the day's report that names the metric, or a milestone that day.
Hovering a report line highlights its tile, and hovering a tile highlights its report lines.

## 4. How did we get here? The focus chart

Selecting a tile opens its full history in a large chart, with the last 30 days, 90 days or
everything. Milestones are small flags on the line; a flag's label shows on hover, and in full
in the strip under the chart. A crosshair follows the pointer, or the arrow keys, and shows the
date, the value and the note. A table with the same numbers is one click away.

## 5. What do I do now? Waiting on you

The panel starts level with the first row of tiles and runs the height of the bands, so the Z
ends on its list. It lists the first three cards of one board column and links to the board.
The headline already gives the count, so the panel repeats neither the count nor a title. An
admin chooses the column with the settings button beside the page title. The panel's rule and
the status dot are the only places that use the accent color.

## Below the first screen: daily reports

Reports are a timeline, newest first. Each day opens in place to show its lines and its full
text. Report text is rendered as safe Markdown: HTML in a report is shown as text.

## Motion

Motion has a job or it is left out. On load, the tiles appear in reading order, 40 ms apart,
and their numbers count up in at most 600 ms. After that, things move only when the reader
acts: opening a report, choosing a tile, moving the crosshair. When the reader's system asks
for reduced motion, nothing animates.

## The first day

Before any metric is defined, the page explains what it will show and how to start: define
metrics and record the first day through the API or the MCP tools. Nothing on the page looks
broken or empty for no reason.

## Small screens

On a phone, the parts keep their order and stack: headline, waiting on you, the bands, the
focus chart, then the reports. Tiles are one column, with the chart beside the number, and a
wider gap separates the bands.

## Contrast

Text meets 4.5:1 and lines and dots meet 3:1 in both themes. `support/progress-contrast.mjs`
computes every pair from the CSS color tokens, and a test fails when one drops below.

## Writing

The page talks like a colleague giving a status update. It uses whole words and sentences,
no symbols in place of words, and no internal terms. A technical word that has to stay is
explained once, where it appears.
