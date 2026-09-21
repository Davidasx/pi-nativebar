# pi-nativebar

A [pi-powerbar](https://github.com/juanibiapina/pi-powerbar)-style status bar for the
[Pi coding agent](https://github.com/badlogic/pi-mono) that reads **Pi's native footer data**
(the same way pi-statusline / pi-starship do), so status chips written by other extensions
via `ctx.ui.setStatus()` — such as [@narumitw/pi-goal](https://github.com/narumiruna/pi-extensions) —
show up directly in the bar.

Rendering is ported from [pi-powerbar](https://github.com/juanibiapina/pi-powerbar) (MIT,
© Juan Ibiapina): left/right-aligned segments, progress bars, overflow shrinking.

The one deliberate deviation: the continuous bar style uses whole-cell glyphs only —
`█` (filled) + `░` (dim track) — instead of pi-powerbar's 1/8-width partial glyphs
(`▏▎▍▌▋▊▉`) and transparent track. Partial-width glyphs render narrower than a cell in
many fonts, leaving a visible hairline gap, and the transparent track is nearly invisible
against dim backgrounds.

## Data sources (vs pi-powerbar)

| Segment | pi-powerbar | pi-nativebar |
|---|---|---|
| `git-branch` | push event (own watcher) | native `footerData.getGitBranch()` |
| `tokens` | push event (own tally) | `ctx.sessionManager.getEntries()` (incremental cache) |
| `context-usage` | push event | native `ctx.getContextUsage()` |
| `provider` / `model` | push event | native `ctx.model` + `pi.getThinkingLevel()` |
| `status` | — | native `footerData.getExtensionStatuses()` (all `setStatus` chips, e.g. pi-goal) |
| others (e.g. `sub-hourly`) | push event | also accepts `powerbar:update` events (protocol superset; pi-usage works unchanged) |

`settings` are re-read from disk whenever `settings-extensions.json` changes, so edits made
in `/extension-settings` apply to the bar immediately — no reload needed.

In `belowEditor` placement the bar *is* the footer; in `aboveEditor` placement it mirrors
pi-powerbar: an editor-top widget plus an emptied native footer.

## Install

```bash
pi install npm:@davidasx/pi-nativebar
```
**Load order:** this package must be listed **after** `@juanibiapina/pi-extension-settings`
in the `packages` array of `~/.pi/agent/settings.json` (same requirement as pi-powerbar),
because it registers its settings with pi-extension-settings at load time.

**Mutually exclusive with pi-powerbar** — both claim the footer and both register settings
under the `powerbar` name. Uninstall one before installing the other.

## Settings

Managed through [@juanibiapina/pi-extension-settings](https://github.com/juanibiapina/pi-extension-settings)
via the **`/extension-settings`** command (interactive ordered multi-selects for segments,
cycling values for the rest). There is no dedicated command, by design — pi-powerbar works
the same way.

- Stored in `~/.pi/agent/settings-extensions.json` (project-level `.pi/settings-extensions.json`
  overrides), under the **`powerbar`** key — identical name and key to pi-powerbar, so
  existing powerbar settings are adopted as-is.
- Defaults: left `git-branch,tokens,context-usage`; right `provider,model,status`;
  separator ` │ `; placement `belowEditor`; bar style `blocks`; bar width `10`.

Segment ids: `git-branch` `tokens` `context-usage` `provider` `model` `status`
`sub-hourly` `sub-weekly` (the last two require a pi-usage event producer), plus any
pi-powerbar producer extension.

## License

MIT. Contains code ported from
[@juanibiapina/pi-powerbar](https://github.com/juanibiapina/pi-powerbar) (MIT, © Juan Ibiapina).
