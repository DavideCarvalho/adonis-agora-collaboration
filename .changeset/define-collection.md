---
'@adonis-agora/collaboration': minor
---

`defineCollection(prefix, declaration?)` and a boot-time warning for patterns without a `:segment`.

A `documents` pattern only matches many documents when it has a `:segment` — a bare `'whiteboards'`
matches exactly one document named `whiteboards`, and `whiteboards/42` falls through to the globals.
That rule lived only inside the matcher, and getting it wrong was silent.

- `...defineCollection('whiteboards', { engine, authorize })` declares `'whiteboards/:id'` with
  `params.id` typed, so the common shape cannot be written without the `:id`. The prefix is the
  literal part of the name; a `:param` or a leading/trailing `/` throws.
- `CollaborationManager` warns once at boot for every declared pattern that has no `:segment`,
  naming the pattern and the fix (`logger.warn` when the installed logger has one, else
  `console.warn`). `CollabLogger` gains an optional `warn`.
- `documentPatternParams(pattern)` and `reportCollaborationWarning` are exported.
