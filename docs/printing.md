# Printing a track

<!-- description: Printing a timeline, or one track of a separation, as a vertical document of Letter or A4 pages, and saving it as a PDF, online or offline. -->

A timeline, or one track of a separated timeline, can be printed as a document: every moment and duration between the left and right edges of the view, one after another down the page, in time order. It works the same on the website, in the desktop app and in the offline file, and saves as a PDF wherever the browser's print dialog can.

## Printing

1. Move and zoom the timeline until its left and right edges hold what you want printed.
2. Right-click the timeline (or press and hold on a touch screen) and choose **Print as a document…**. On a separated timeline, right-click inside the track you want: the menu names it, as in **Print “Tagged war” as a document…**. Each track prints as its own document.
3. The preview shows the pages. Choose **Letter** or **A4** paper; Letter is the default, and the choice is remembered in this browser.
4. Choose **Print or save as PDF**. In the print dialog, pick a printer, or **Save as PDF** as the destination. Leave the margins at their defaults (or none) and turn on background graphics if the dialog offers it, so durations' colors print.

**Close**, or Escape, returns to the timeline.

## What a page shows

- **Order, not scale.** Items follow one another by time, each taking the room it needs, so a busy week and an empty century take what their contents need. At one time, a duration's start comes before moments, and a duration's end after them.
- **The first page** names the timeline, the track, the range printed and how many moments, durations and relationships the document holds.
- **Moments** show their marker as the timeline draws it (its icon, shape, color, size and dashed outline), their time and title, then their content as the reader shows it: images, tags, flags such as _Presumptive_, measures, notes (as Markdown when the timeline has rich-text notes), the plugins' fields, links and stack entries. A heading moment is a heading in its level and font.
- **Durations** appear at their start, with their span and content, and again at their end. A bar in the left margin joins the two, in the duration's color, dashed where its outline is; up to eight run side by side. When a duration crosses a page, its bar continues, and the right margin says where it continues to or began. A duration with no room for a bar says the same.
- **Relationships** between two items on the same page are drawn as connectors in the gutter to the right of the text, up to four side by side. Every other relationship is a note in the right margin beside each end it includes, naming the other end and its page: _Moment 40 (p. 6)_. An end outside the document (outside the range, or on another track) is named with its time: _Part 1 (2/1, not in this document)_. Arrows follow the relationship-arrows plugin: → toward the other end, ← from it, ↔ both, — neither. Notes stack downwards and never overlap; a page breaks early rather than let its notes run past its foot.
- **Long content** continues on the next page between paragraphs and other blocks; a block taller than a whole page, such as a very long list, is cut at the page's foot.
- **The timeline's theme** sets the text, marker and duration colors and fonts. Pages are otherwise printed light, whatever the app's color scheme. Background charts, the timeline's background image and the stage's decorations are left out.

## Limits

A document holds at most 2,000 moments and durations. When the view holds more, the preview says so: zoom in, separate the timeline by tags or relationships, or hide what you don't need, and print again. For a server timeline, relationships are read 200 items at a time, up to 5,000 for each group of 200; past that, the first page says some are left out.

## Times and dates

Times are written as the timeline's time display writes a time on its own, the same as the reader. The range on the first page uses the same display.
