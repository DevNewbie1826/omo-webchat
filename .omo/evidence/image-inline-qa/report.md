# Inline image lazy-loading QA

## Proven on the real surface

The image renders decoded while the tool card is collapsed. On the live media path, the first viewport entry issues exactly one scoped request for its own `(wsId, chatId, toolCallId, contentIndex)`; disclosure toggles keep the count at one. A real unmount/remount was executed with `originalNodeDisconnected=true`, and the new node still rendered the image.

## Unreachable state

The state “image never seen -> zero scoped media requests” is UNREACHABLE on this surface for two independent, mechanically demonstrated reasons:

1. Live arrival: the transcript auto-follows, scrolling the newly arrived image row through the viewport, so its IntersectionObserver reports an intersection during streaming. Attempt 2 recorded `top=118.65625`, `scrollTop=4225`, and `isIntersecting=true`.
2. Unmounted arrival / return: when the chat is re-entered or reloaded, history re-hydrates the result as an inline `data:` image, so no media endpoint request exists. Both unmounted-arrival traces recorded counts `0 -> 0 -> 0 -> 0 -> 0`.

## Component-seam coverage

The zero-request-while-never-intersecting guarantee and the per-coordinate cache are covered at the component seam by mutation-proved assertions. Removing the visibility guard at `ChatTranscript.tsx:226` fails these two assertions: “issues zero media requests for an image_ref that only ever receives non-intersecting notifications, collapsed and expanded” and “intersects exactly one of two same-page images into exactly one scoped request while the other stays at zero”. With the guard intact, the full frontend suite is green.

## Screenshot index

- `collapsed.png`: transcript media area showing the decoded image while the tool card is collapsed.
- `entered.png`: transcript media area showing the decoded image after viewport entry.
- `toggled.png`: transcript media area showing the decoded image after disclosure toggles.
- `remounted.png`: transcript media area showing the decoded image after real remount.
- `unseen.png`: transcript media area showing the captured attempted unseen state.
