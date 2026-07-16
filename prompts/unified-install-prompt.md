# Install Organizer

Install the Organizer module into the member's Dispatch home at `"$HOME/.myos-dispatch"`. Keep going until validation passes unless a hard blocker is reached.

## Install

Run `node install/install-organizer.js`. The installer uses `"$HOME/.myos-dispatch"` by default, or pass `--target <path>` for a test installation. It backs up existing files, writes atomically, supports `--dry-run`, and supports `--uninstall`.

## Re-index me

After installation, run `node "$HOME/.myos-dispatch/organizer/bin/organizer.js" index --dir <member-code-dir> --workspace "$HOME/.myos-dispatch"`, then run `organizer audit --workspace "$HOME/.myos-dispatch"`.

Ask the member's agent to do a brain-dump enrichment pass after indexing. It should register useful capabilities, projects, and agents using `organizer add --type capability|project|agent --json '<row>'`.

## Validate

Run `node install/validate-organizer.js`. Report the target path, index count, and validation result. Hard blockers are a missing Node runtime or missing system `sqlite3` command.
