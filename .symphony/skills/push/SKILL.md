---
name: push
description:
  Push tmux-cc branch changes and create or update a GitHub PR; use when asked
  to publish work, open a PR, or update an existing PR.
---

# Push

## Core rule

Push feature branches to `origin` and open PRs against `origin/main`. Do not use
an `upstream` remote.

## Preconditions

- `gh auth status` succeeds.
- Local validation from `run-tests` has passed or the blocker is documented.
- Commit history and current diff pass the privacy gate from `commit`.

## Steps

1. Identify current branch:
   - `git branch --show-current`
2. Refuse to push directly from `main` unless explicitly requested.
3. Confirm the branch contains only intentional commits for this task.
4. Push:
   - `git push -u origin HEAD`
5. If push is rejected due to stale branch state, run `pull`, revalidate, then
   push again.
6. Use `--force-with-lease` only after intentional local history rewrite.
7. Create or update the PR:
   - base: `main`
   - head: current branch on `origin`
   - title: concise English summary of the shipped behavior
   - body: summary, validation, risk/notes
8. Before submitting PR title/body, apply the same privacy gate:
   - no deployment target names,
   - no host-specific paths,
   - no internal ticket IDs,
   - no verbatim conversation/session content,
   - no secrets or local-only scaffolding details.
9. Return the PR URL from `gh pr view --json url -q .url`.

## PR body template

```md
## Summary

- <generic outcome>

## Validation

- <command/result>

## Risks/Notes

- <public-safe caveat or None>
```

## Stop conditions

- Stop if GitHub auth/permission failures cannot be resolved in-session.
- Stop if the only available PR body would expose private operational context.
- Stop if validation is required but blocked and no explicit blocked handoff has
  been written.

