# All Sorted Organizer

The Organizer gives your AI assistant a second brain: a plain folder of linked markdown notes about your projects, people, companies, decisions and ideas, built from your own documents. It keeps the folder fresh, builds a knowledge graph over it with Atelier, and opens it in Obsidian so you can see the graph. It also keeps the capability index that MyOS Dispatch routes with.

Everything stays on your Mac. The brain is a local git folder that is never pushed anywhere.

## What it needs

- macOS (the Obsidian install step is macOS only; the notes work anywhere)
- Node.js 22 or newer
- `git` and the `sqlite3` command line tool (both ship with macOS developer tools)

## Install

```sh
git clone https://github.com/joecheofficial/allsorted-organizer.git ~/allsorted-organizer
```

There are no npm dependencies. Optional, for the knowledge graph file:

```sh
npm install --prefix "$HOME/.myos-dispatch/.external/atelier" @mnstry/atelier@0.2.0-alpha.12
```

The default root is `~/.myos-dispatch`, the same folder MyOS Dispatch uses. The brain lives in `<root>/brain`. Pass `--root <folder>` to use another one.

## Build your second brain

```sh
B="node $HOME/allsorted-organizer/bin/brain.js"
$B init                                   # create the brain folder
$B build --from ~/Documents --dry-run     # preview: lists files, reads nothing
$B build --from ~/Documents               # write source notes (repeat --from, use --exclude)
$B graph                                  # save history, run Atelier, check links
$B open --install                         # install Obsidian if needed and open the graph view
$B status                                 # counts and last build
```

`build` turns documents into source notes. Your assistant then adds projects, people, companies, decisions and ideas with `brain add`, citing the source notes, so the graph shows how your work connects. `graph` should report `brokenWikilinks: 0`, and with Atelier installed, `degraded: false`.

Rules the commands follow: they write only inside `<root>/brain` and `<root>/state`; they never move, rewrite or delete your own documents; `open --install` is the only step that installs anything outside the root (Obsidian, via Homebrew or the official signed disk image).

## Capability index

```sh
node ~/allsorted-organizer/bin/organizer.js index --workspace ~/.myos-dispatch
```

`organizer index` rebuilds the capability index (commands: index, audit, add, reconcile-index, schedule-nightly, brain) that routing reads. Only index your Dispatch root into your Dispatch root; to look at any other folder, use a scratch `--workspace`.

## Tests

```sh
node --test tests/*.test.js
```

## License

All Sorted Personal Use License. Use it for yourself and your own business; do not share, resell or redistribute it. See LICENSE.
