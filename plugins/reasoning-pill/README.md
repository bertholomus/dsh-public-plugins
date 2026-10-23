# Reasoning pill

One reasoning control for DeepSeek Harness Desktop. A **Reasoning: …** pill sits beside the model name in the
composer and opens the model's effort levels (Default, Low, Medium, High, …). While it runs, DSH's own Effort row in
the model menu and the effort badge on the model button are hidden, so there is one place to set reasoning.

The pill changes only the session's reasoning effort, through DSH's own model directory, the same call DSH's Effort
row makes. A model with no effort levels shows a disabled "Reasoning: None". In a narrow composer the pill shrinks to
its gauge icon.

It has no config and no host code; turn it off in Settings → Plugins (or remove it from the profile) and DSH's own
Effort row comes back.

## Files

- `lib/client.js`: the pill, the Effort-row hider and their styles, hand-written React (no build step).
- `lib/index.js`: an empty host half, so DSH can load the bundle.
