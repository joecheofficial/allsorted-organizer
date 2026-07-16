# All Sorted Organizer

The Organizer keeps your AI second brain fresh. It indexes your projects, capabilities, and tools into a small local database and a capability index, so your agent gets smarter about your work the more you build. There is no manual upkeep: you tell it to re-index and it updates itself.

## What it needs

- Node.js version 20 or newer
- The `sqlite3` command line tool

Those two are the only hard requirements.

## Install

```
git clone https://github.com/josephtandle/allsorted-organizer.git
cd allsorted-organizer
node install/install-organizer.js
node install/validate-organizer.js
```

By default it installs into `$HOME/.myos-dispatch`. It backs up anything it replaces and writes safely.

## Use it

Index your work folder, then audit it against what is really on disk:

```
node "$HOME/.myos-dispatch/organizer/bin/organizer.js" index --dir <your-work-folder> --workspace "$HOME/.myos-dispatch"
node "$HOME/.myos-dispatch/organizer/bin/organizer.js" audit --workspace "$HOME/.myos-dispatch"
```

Whenever you build something new, just re-run `index` and your agent stays current.

## Uninstall

`node install/install-organizer.js --uninstall` restores files that existed before installation. Backups are retained under `.allsorted-organizer-backups/` for manual recovery.
