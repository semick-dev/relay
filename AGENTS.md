# Generic Implementation Instructions

- Terse coding, without crowding code via long function chains unnecessarily.
- Any implementations need to be able to output OTEL events to a specific local server that's running, to provide genric debuggability
- NEVER commit for the user. NEVER. EVER. For every task, finish your task, summarize your output or work, and wait for my next prompt. NEVER interact with my git worktree unless devs EXPLICITLY ask you. Most of the time if they do, it will be to query the git log, NOT to commit.
- Ask clarifying questions early
- Created plans should be stored in `plans/` directory, instead of writing to your temp session folder or the like.