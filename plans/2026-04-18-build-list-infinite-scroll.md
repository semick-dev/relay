# Build List Infinite Scroll

## Goal

Extend the definition-scoped build list so it no longer stops at the first 10 builds. The pane should keep loading more builds as the user scrolls downward, and expose a `Batch Size` control that determines how many builds each fetch requests.

## Plan

- Add paged build loading in the backend using Azure DevOps build continuation tokens.
- Extend the build-list API response with continuation metadata.
- Track batch size, continuation token, and loading-more state in the panel.
- Render a `Batch Size` control in the definition build-list tab.
- Append additional builds on scroll-near-bottom instead of replacing the list.
- Keep refresh, definition switching, filters, and navigation coherent with the new paging state.
- Update `map.md` to reflect the infinite-scroll build list behavior.
