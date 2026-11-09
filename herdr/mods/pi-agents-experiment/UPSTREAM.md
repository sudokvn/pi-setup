# Agents sidebar experiment

This mod adds Pi status records to Herdr’s existing Agents tree. Native terminal children, grouping, pinning, folding and parent navigation remain in place. Pi child rows use the same status symbols as native children. Clicking a Pi child opens a read-only output preview, sized like Herdr’s terminal peek. Use `/subagents` in Pi to send instructions or cancel a child.

`main.js` starts from the shipped Agents mod in Herdr 0.1.14, under the [Apache-2.0 license](https://github.com/herdrdev/herdr-app/blob/master/LICENSE). The unmodified file’s SHA-256 is `6ccd4a1a0ec6899b1a5c10a4305b395b61357d90599a40a0bb5a48726a767c15`. Its source is [`defaults/mods/agents/main.js`](https://github.com/herdrdev/herdr-app/blob/master/defaults/mods/agents/main.js). Upstream formatting is retained to keep the local changes identifiable.

Local changes are the helper imports, tree construction, status-record rows, output preview and the sort popup’s mod name. No Pi or herdr-core changes are required. The status publisher’s existing terminal-reset limitation remains. Child rows reuse Herdr’s status renderer without adding redraw timers.

The preview uses the existing Node.js runtime (`node`) on the machine running Pi. It adds no runtime dependency. It reads the selected run’s saved snapshot on that machine and shows assistant text and current tool names, not the original task, thinking or tool arguments. Reads are bounded and run ids are validated. An open preview refreshes every two seconds while the saved snapshot or the run's status record says the run is working, then stops. If a finished run is restarted with an instruction, its record changes back to working and the open preview resumes. Closing the preview stops refreshes. The directory follows `PI_SUBAGENT_STATE_DIR` or `PI_CODING_AGENT_DIR`, with `~/.pi/agent/state/subagents` as the default. Local reads use the Herdr app’s environment; remote reads use that machine’s herdr-core environment. If a particular Pi process overrides those variables independently, the preview may be unavailable; inspect that child through `/subagents` instead.

Run the focused tests with:

```sh
node --test herdr/mods/pi-agents-experiment/*.test.js
```

The live experiment uses a separate layout, `pi-subagents-experiment`, copied from `main` with only the Agents mod reference changed. The shipped layout and mod are untouched. Return to the stock layout with:

```sh
herdr-app do layout.switch --name main
```

This is an experiment, not an automatically maintained replacement. Herdr updates its original Agents mod, not this copy. Review upstream changes before updating the experiment.
