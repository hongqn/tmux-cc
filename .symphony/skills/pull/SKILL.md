---
name: pull
description:
  Sync a tmux-cc feature branch with origin/main; use when the branch is stale,
  push is rejected, or merge conflicts need resolution.
---

# Pull

## Core rule

`tmux-cc` is a personal repo. Sync against `origin/main`; do not configure,
fetch, or merge an `upstream` remote.

## Steps

1. Confirm the current branch is not `main`.
2. Confirm the working tree is clean, or commit/stash only the current task's
   work first.
3. Enable rerere locally:
   - `git config rerere.enabled true`
   - `git config rerere.autoupdate true`
4. Fetch origin:
   - `git fetch origin main --prune`
   - `git fetch origin "$(git branch --show-current)" --prune`
5. Pull remote branch updates when the branch already exists:
   - `git pull --ff-only origin "$(git branch --show-current)"`
6. Merge latest main:
   - `git -c merge.conflictstyle=zdiff3 merge origin/main`
7. Resolve conflicts by understanding both sides before editing.
8. Run `git diff --check` and the validation required by `run-tests`.
9. Record the merge source, conflict summary, validation, and resulting `HEAD`.

## Conflict guidance

- Preserve public API behavior unless the ticket clearly changes it.
- For generated or derived files, resolve source files first, then regenerate.
- For import conflicts, keep both candidates temporarily, then let validation
  reveal unused or wrong imports.
- Do not choose `ours` or `theirs` for an entire file unless the intent is
  obvious.

## Privacy gate

Conflict resolutions must not introduce deployment target names, host-specific
paths, conversation/session content, internal ticket IDs, secrets, or local-only
agent scaffolding into tracked files.

