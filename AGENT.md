# Comment Rules

A comment tells the reader why this code exists. The code already says what it does.

## What a comment carries

- **Scene & Background**: the situation around this code when it runs.
- **Intent**: what we want to be true.
- **Precondition**: what must already be true.
- **Condition**: when this applies, and when it does not.
- **Guarantee**: what stays true afterwards.

## What a comment avoids

- No step-by-step retelling. The code is the steps.
- No "how". Only "why".
- No history, no anecdotes, no essays.

## Shape

- One or two short sentences.
- Small words. One idea per sentence.
- If it needs a paragraph, it wants a better name, not a longer comment.

## Language

- English only.

## Examples

Good: the reader learns the scene and the reason.

```js
// Only after the cache is warm, so lookups never touch the network.
```

Bad: the reader learns nothing new.

```js
// Check flag, then load data, then set flag, then push rows into result.
```
