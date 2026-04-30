---
name: commit
description:
  Create a safe git commit for tmux-cc changes; use when asked to commit,
  finalize staged work, or prepare a commit after implementation.
---

# Commit

## Core rule

Create a commit that reflects only intentional repo changes and contains no
private deployment details, conversation transcripts, local-only scaffolding, or
internal tracking references.

## Preconditions

- Read `AGENTS.md` first and treat its git hygiene policy as mandatory.
- Inspect `git status`, `git diff`, and `git diff --staged`.
- If unrelated user changes exist, leave them unstaged.

## Steps

1. Identify the exact files that belong to the current task.
2. Stage files explicitly by path. Never use `git add -A`.
3. Inspect the staged diff:
   - `git diff --cached --check`
   - `git diff --cached --name-status`
   - `git diff --cached`
4. Run the privacy gate before committing:
   - no real deployment target names,
   - no host-specific paths,
   - no internal ticket IDs,
   - no verbatim conversation/session content,
   - no local-only agent scaffolding,
   - no secrets, tokens, or auth material.
5. If any forbidden content appears, unstage or edit before committing.
6. Write a conventional commit subject in English, <= 72 characters.
7. Body must describe the generic bug/root cause/fix and validation, not private
   operational context.
8. Append exactly this trailer:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

9. Commit with a message file: `git commit -F <file>`.

## Message template

```text
<type>(<scope>): <short summary>

Summary:
- <generic description of what changed>

Rationale:
- <generic reason for the change>

Validation:
- <command or "not run (<reason>)">

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Stop conditions

- Do not commit if the staged diff contains unrelated user work.
- Do not commit if privacy gate findings remain unresolved.
- Do not commit local-only ignored scaffolding unless the issue explicitly asks
  to add tracked Symphony workflow files.

