# Organizer brain

## Mission

Build and maintain your capability index: a sqlite database (`myos-brain.db`)
plus a generated `capabilities-index.json`, listing every recipe, skill,
workflow, and project this module can find under a scanned directory, each
with aliases, use/avoid hints, and its own source path. The routing system
that reads this index depends on it being accurate. Nothing else rebuilds it.
If the index is wrong or stale, every downstream routing decision that
trusts it is wrong too.

## When to re-index

Re-index after adding or editing a `*.recipe.json`, `SKILL.md`,
or `*.workflow.json` file -- anything the scanner
actually reads. Indexing is idempotent (every row is an upsert keyed on a
deterministic id), so running it twice in a row is harmless and cheap. That
does NOT mean it should be run reflexively on every trivial edit, commit, or
save. A fresh recipe with a typo fixed a minute later does not need two index
runs. The right cadence is event-driven, not continuous: index after a batch
of capability changes lands, not after each keystroke.

`check-index-freshness` exists precisely so a caller can ask "does this need
a re-index" cheaply (a modification-time comparison) before paying for a
full walk. Prefer that check before running a full `index-workspace` pass
when the caller isn't sure whether anything changed.

## Reconcile the index

Run `reconcile-index` any time you want to catch up with new projects. It adds
folders under `projects/` to `projects/_index.json` with a `needs-review` status,
writes a starter `CONTEXT.md` where a new project has none, and marks missing
folders without deleting their entries. Replace each starter with your own
project context when you are ready. Existing context files stay exactly as they are.

It also refreshes your capability index when skills, recipes, or workflows have
changed. It is safe to run any time. Once installed, the nightly schedule runs it for you.
Use `--dry-run` to see the plan without changing any files. Recipe callers can
set `args.dryRun` to `true`. `args.dir` selects the workspace to scan, including
its `projects/` folder; `args.workspace` selects where the capability index lives,
just as it does for `index-workspace`.

## Keep the nightly refresh running

Run `schedule-nightly --dir <directory-to-index> --workspace <data-directory>`
after installation and validation. On Mac and Windows, it schedules
`reconcile-index` for 03:30 local time, using the Node runtime you used for setup.
Running setup again replaces the existing job. Use `schedule-nightly --remove`
to remove it. Your computer must be available for scheduled work to run.

`status` reports the last successful refresh. A `RED FLAG` means no successful
run is recorded, the timestamp cannot be checked, or more than 36 hours have
passed. After moving computers or reinstalling, run `reconcile-index`, then
`schedule-nightly` again. A manual successful reconciliation also updates this
time; a dry run does not. Mac refresh logs are in the organizer's `data` folder.

## What makes a good index

- **Recipes need real trigger phrases.** A recipe with no `phrases`, or
  phrases that are just the recipe's own id restated, will never actually
  route anything. Shipped recipes are held to a minimum of five phrases with
  at least two that omit the owner name -- an indexed recipe that fails that
  bar needs fixing at the source, not something this indexer can paper over.
- **Aliases should be genuinely distinguishing.** An alias like "run" or
  "check" on every capability makes every capability look equally relevant
  to every query, which is the same as having no aliases at all. Good
  aliases are the words a person would actually type for that specific
  capability and no other.
- **Don't index scratch or test fixtures as if they were real capabilities.**
  Sample projects, throwaway demo recipe files used for tests, and temp
  directories should never end up in a production index. The scanner already
  skips dotfiles, `node_modules`, `.git`, `dist`, `build`, and `.next` by
  convention -- when scanning your real project tree, point `dir` at the
  real source tree, not at a test fixtures directory.

## How to tell when the index is stale

Compare the modification time of every indexable source file (`*.recipe.json`,
`SKILL.md`, `*.workflow.json`) against the modification time of the
`capabilities-index.json` artifact itself. If any source file is newer than
the index, the index is stale. `check-index-freshness` does exactly this
comparison and nothing else -- it is read-only and does not touch the
database.

A capability count of zero after a real run against a real directory is a
red flag, not a clean bill of health. It usually means `dir` pointed at an
empty or wrong directory, or that every file in scope failed to parse. Never
report a zero-capability index as healthy -- surface it as a warning that
needs investigation, exactly as `check-index-freshness` does.

## What this module refuses to do

- It never deletes or rewrites the source recipe, skill, or workflow files it
  indexes. Reconciliation updates `projects/_index.json` and creates missing
  starter `CONTEXT.md` files only for newly indexed projects. Capability indexing
  writes its own database and generated `capabilities-index.json`.
- It never routes on your behalf. It only builds the index another system
  reads to make routing decisions. Deciding which capability to run for a
  given request belongs to that system, not this indexer.
- `audit-capability-index` is read-only: it runs read queries only and never
  repairs what it finds. A dead source path or an orphan capability gets
  reported, not silently dropped from the database.
- It does not invent capabilities. Everything in the index traces back to a
  real file on disk; nothing is synthesized from guesswork.

## The second brain folder

The capability index above is for routing. The second brain is for you: a plain
folder of markdown notes at `<data-directory>/brain`, one note per project,
person, company, topic and source document. It is a git repository and nothing
else. Copy or move that one folder and the whole brain moves with it. No
database, no account and no particular app is needed to read it.

Commands (each prints one JSON result):

- `organizer brain init --root <data-directory>` creates the folder. Add
  `--viewer` to also write minimal Obsidian settings.
- `organizer brain build --root <data-directory> --from <folder>` reads the
  markdown and text files in the folders you name and writes the notes, one at
  a time, so an open graph view shows them arriving.
- `organizer brain add --root <data-directory> --json <file>` adds notes your
  assistant understood from your documents. The file is a JSON array of
  `{type, title, summary, body, relations: [{type, target}], source}`.
  Adding a note again with `relations` replaces the relations `add` gave it
  before (links the build found in your files stay); leave `relations` out to
  keep them as they are.
- `organizer brain graph --root <data-directory>` saves the folder to its local
  git history, builds the Atelier knowledge graph and prints the counts.
- `organizer brain open --root <data-directory>` opens the folder in Obsidian,
  straight into the graph view. Add `--install` to install Obsidian first when
  it is missing (Homebrew when present, otherwise the official disk image,
  copied only when it is signed by Obsidian's publisher and notarized by Apple). Without `--install` a missing viewer only gets
  the one line that installs it.
- `organizer brain status --root <data-directory>` reports counts and last runs.

What it holds to, every time:

- It reads markdown and text only. It never opens `.env` files, key files or
  anything named like a password or token, never reads `node_modules` or `.git`,
  and never follows a link that points outside the folders you named.
- It never overwrites a note you edited. When a rebuild has something new for a
  note you changed, the new version is saved beside it as `name.proposed.md`.
- The brain and every file stay on this computer. Nothing is copied to any
  server, account or sync service, the brain repository has no remote, and
  every note is marked private. An AI assistant you ask to build or read the
  brain reads the documents to do that work, as it does for anything else.
- A source note holds the text of its document under a Content heading, up to
  200 KB (`--max-note-bytes`), so the knowledge moves with the folder. Lines
  that look like keys are replaced with `[removed: looked like a key]`, and a
  link to something that is not a note in the brain becomes plain text.
- It reads at most 2,000 files per build (`--max-files`), shared across the
  folders you name, and says `LIMIT REACHED` with the counts when that cuts in.
- A build that is stopped part way carries on when you run it again.
- Atelier is only ever run from `<data-directory>/.external/atelier`.
- Atelier and Obsidian are both optional. Without Atelier the notes and their
  links are still complete and `graph` reports `degraded: true`. Obsidian is
  only a viewer; nothing depends on it, it is installed only by `open --install`,
  and a failed install never stops the brain from building.
- `build` and `add` write notes one at a time with a pause between them, so an
  open graph view shows the brain growing. The pause is a few hundred
  milliseconds for a small brain and shrinks as the count grows, so the pauses
  never add up to more than about ninety seconds. `--pace-ms` sets it by hand.

Each note carries its links twice on purpose: as `kg` relations in the front
matter, which Atelier reads, and as a Related list of `[[wikilinks]]`, which
people and the Obsidian graph view read. Relation types are `related`,
`supports`, `belongs_to`, `depends_on`, `implements`, `evidences`, `supersedes`
and `contradicts`.

## Pulling connected accounts into the brain

`organizer brain pull` brings what the customer's connected accounts hold into
the brain as linked notes: one note per contact or customer with their recent
interactions, one per mail thread or chat, one per month of payments, one per
month of calendar events, one per recently changed Drive file and one per month
of email sent through Resend.

- `organizer brain pull --root <data-directory> --source mail --account <their address>`
  reads Gmail thread headers through the Google module. Other sources:
  `calendar` (Google module), `messages` (the WhatsApp module's own message
  database, opened read-only), `payments` (the Stripe module), `drive` (Google
  Drive through the Google module: the name, kind and last change of each file
  changed in the window, plus a short opening excerpt of Google Docs only, at
  most 25 documents opened per pull) and `sent` (the Resend module's list of
  sent emails: one note per month with counts, delivery events and subjects,
  never the recipients' addresses or the body). `drive` needs `--account` like
  mail and calendar.
- `--plan` reads the sources and lists the notes it would write, removes and
  leaves alone. It writes nothing and makes no folder.
- `--days N` (30 by default, a year at most) or `--since YYYY-MM-DD` sets the
  window. `--max N` caps each source (100 by default, 500 at most). When the cap
  cuts in, the result says `LIMIT REACHED` and nothing is tidied.
- `--remember` saves the chosen sources (and account) to
  `<data-directory>/state/brain-refresh-settings.json`, so later pulls and the
  refresh can run without naming them.
- `--forget --source <name>` removes every note that source wrote, except notes
  a person edited and notes something else still links to.

What it holds to, every time:

- Read only against every source. It reuses the adapters the installed modules
  ship and lets only their search, list and GET calls through: it never calls a
  write API, never sends, and has no sign-in of its own. A source that is not
  installed or not connected is reported as skipped.
- Opt in, per source. With no source named and none remembered it reads nothing.
- A message, subject or charge description that looks like it carries a
  password, key, sign-in code, reset link or long number is left out whole, and
  the note says how many were left out. Event descriptions, card details,
  addresses and full phone numbers are never read into a note. A Drive file
  whose name or opening text looks like it holds passwords, keys or recovery
  codes gets no note at all, and the result counts it under `leftOut`.
- Every pulled note carries its source as provenance (`pulled/<source>` tag and
  the state record), so the next pull of that source tidies away what it no
  longer produces. A pulled note never takes over a note `build`, `add`, another
  source or a person wrote; it is written beside it as a source note and linked.
- Running it again with the same data changes nothing.

## Keeping the brain current

`organizer brain refresh --root <data-directory>` re-runs, in order, `build`
over the folders listed under `from` in the settings file, the pull for the
remembered sources, every registered pass under `passes`, and `graph`. A pass is
a recipe inside the install root, such as a product, regulatory or page pass a
module ships, whose `runRecipe` returns `{ notes: [...] }` in the `brain add`
shape. Its notes carry the pass name as their source, so the next refresh tidies
them the same way. `--plan` shows what would run.

The schedule is off by default. `--schedule template` writes the schedule file
to `<data-directory>/state/schedules/` for review and turns nothing on.
`--schedule on` turns on a daily refresh (04:15 unless the settings say
otherwise) and `--schedule off` turns it off. A scheduled run does nothing while
`schedule.enabled` is false in the settings. The shipped
`brain-refresh.example.json` shows every setting.


## Cover the whole approved second brain

Inventory the user's canonical knowledge folders and existing Obsidian vaults before building. Name each nonoverlapping folder with `--from`, add `--exclude <folder>` for generated copies and backups, and set `--max-files` above the eligible document count. Use `--max-note-bytes 1048576` for supported documents and `--remember` to retain selected roots, exclusions and limits for later builds and refreshes. This remembers settings without turning on a schedule.

The build result and `state/brain-build.json` contain a coverage receipt: selected roots, explicit exclusions, eligible and read documents, truncated documents and completeness. Missing, unreadable, oversized, capped or protected inputs keep coverage incomplete. The receipt covers supported local Markdown and text documents. PDFs, office files and attachments need a local extraction pass with provenance; account pulls retain their own window and caps. Zero broken links does not prove complete source coverage. Originals are read only and edited brain notes remain protected.

## Graph freshness

`brain freshness --root <root> [--months 6] [--vault <folder> ...] [--write]` says when the graph was last built, which notes are live and which are archival (older than the window, in an archive folder, or marked archived), and lists old notes that hold facts likely to change: age, city, role and prices. A generated note is dated by its sources, not by the last rebuild. It is read-only; `--write` adds one view note, `brain/FRESHNESS.md`, with wikilinks so Obsidian shows it, and `state/brain-freshness.json`. It never edits a note, and a customer vault passed with `--vault` is only read. Use it in the final report's stale-data pass: list the notes it names and ask the customer only about facts that matter.

One unified graph is the default: every source lands in the one brain, and businesses and personal areas are partitions recorded as tags and source rows, not separate graphs. A separate brain under `partitions/<name>` is only for material whose audience must never mix (for example a client's confidential data), and only with the customer's explicit choice.
