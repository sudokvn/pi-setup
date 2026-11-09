---
name: background-terminals
description: Run and manage long-lived shell commands in background terminals. Use for dev servers, watchers, streaming builds, and other commands that should keep running while the agent continues working.
---

# Background Terminals

Use `bg-start` for long-running commands; use regular `bash` for quick commands.

## Start

Call `bg-start` with:

- `command`: shell command to run
- `title`: short recognizable label
- `working_dir`: project directory when different from the current directory

Background commands receive no stdin. Never use them for interactive prompts.

After starting, continue useful work instead of polling. Exit results are never pushed into the conversation; collect them with `bg-wait` when progress or your answer depends on them. Until then the widget above the editor counts them as ready or failed.

## Wait, inspect and stop

- Use `bg-wait` when you cannot continue without the result. It returns the final output. Never poll with `sleep` or read the log files directly.
- Use `bg-status` only when current output or status is needed.
- Use `bg-list` to inventory all tracked terminals.
- Use `bg-kill` when a process is no longer needed or is stuck; termination continues even if the tool wait is aborted.
- Tell the user they can open `/ps` to inspect live output and kill terminals interactively.

Prefer meaningful titles and avoid starting duplicate servers or watchers. Full output is captured to spill files; tool output shows a concise tail. Terminals are session-scoped and are stopped during shutdown or reload.
