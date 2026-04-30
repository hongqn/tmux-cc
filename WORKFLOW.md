---
tracker:
  kind: linear
  project_slug: "tmux-cc-de8303dc6e48"
  assignee: me
  active_states:
    - Todo
    - In Progress
    - Rework
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 60000
workspace:
  root: $SYMPHONY_WORKSPACE_ROOT
hooks:
  after_create: |
    gh repo clone hongqn/tmux-cc .
    git fetch origin main --prune
agent:
  max_concurrent_agents: 1
  max_turns: 20
codex:
  command: codex --sandbox danger-full-access --ask-for-approval never --config shell_environment_policy.inherit=all --config 'model="gpt-5.5"' --config model_reasoning_effort=xhigh app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
---

You are working on a Linear ticket `{{ issue.identifier }}` for the personal `hongqn/tmux-cc` repository.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the ticket is still in an active state.
- Resume from the current workspace state instead of restarting from scratch.
- Do not repeat already-completed investigation or validation unless needed for new code changes.
- Do not end the turn while the issue remains in an active state unless blocked by missing required permissions, auth, secrets, or explicit human-confirmation gates.
{% endif %}

Issue context:

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Instructions:

1. This is an unattended orchestration session. Never ask a human for follow-up actions except through explicit requirement-confirmation, plan-confirmation, or blocked-access handoff.
2. Stop early only for a true blocker: missing required auth, permissions, secrets, unavailable tools, unclear requirements, or an unsafe deployment request.
3. Final message must report completed actions and blockers only. Do not include generic next steps for the user.
4. Work only in the provided `tmux-cc` repository copy. Do not touch other repositories or user files.

## Repository model

- This is a personal repository, not a fork-based organization workflow.
- `origin` is the source of truth: `https://github.com/hongqn/tmux-cc.git`.
- Do not configure or fetch an `upstream` remote.
- Default branch is `main`.
- Push feature branches to `origin` and open PRs against `origin/main`.
- Do not push directly to `main` unless the Linear ticket explicitly asks for a direct-main change and the working tree is clean after validation.

## Language and public-git hygiene

- Write Linear-facing notes in Chinese.
- Keep code, test names, commit messages, PR titles/bodies, and repository documentation in English.
- Repository-visible content must not contain:
  - real machine names or host-specific paths,
  - internal ticket IDs or private tracking references,
  - verbatim user conversation content,
  - local-only agent scaffolding paths or prompts.
- Use generic wording in commits and docs: describe the bug, root cause, behavior, and fix.
- The only allowed AI-assistance trailer is:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Local instructions source

- Read `AGENTS.md` at the start of every ticket when present, even if it is ignored by git.
- Obey `AGENTS.md` deployment and git hygiene rules.
- Do not copy ignored local-only instructions, private hostnames, or deployment target names into tracked files.

## Repo-local Symphony skills

Use `.symphony/skills` when the matching operation appears:

- `run-tests`: validation and deployment readiness checks.
- `commit`: safe commits with the repository privacy gate.
- `pull`: sync feature branches with `origin/main`.
- `push`: publish branches and create/update PRs on `origin`.
- `linear`: update persistent workpad and handoff comments.
- `debug`: investigate Symphony/Codex run failures without leaking logs.

## Default posture

- Start by reading the issue state, description, comments, attached PRs, and existing workpad/handoff comments.
- Treat two persistent Linear comments as the source of truth:
  - `## Codex Workpad` for detailed plan, notes, validation, and continuation state.
  - `## Review Handoff` for compact human-facing status and action needed.
- Keep ticket metadata current.
- Prefer small, surgical changes that fully address the ticket.
- Do not expand scope. If a useful out-of-scope improvement appears, create a separate Backlog issue instead of folding it in.

## Required workflow by issue state

- `Todo`: move to `In Progress`, create or update the workpad, plan, implement, validate, push, and prepare PR review.
- `In Progress`: continue from the existing workpad and current branch state.
- `Rework`: re-read PR comments, review summaries, checks, Linear comments, and the latest handoff before changing code.
- `Human Review`: do not code or change ticket content unless the human moved the ticket back to an active state.
- Terminal states: do nothing.

## Planning rules

Before implementation:

1. Confirm current branch, `git status`, and `HEAD`.
2. Read `AGENTS.md`, `package.json`, relevant source/tests, and any attached PR diff.
3. Update `## Codex Workpad` with:
   - current attempt,
   - plan checklist,
   - acceptance criteria,
   - validation commands,
   - risks/confusions.
4. For unclear requirements or risky behavior choices, stop with a compact `## Review Handoff` decision packet instead of guessing.

## Implementation rules

- Keep diffs minimal and directly tied to the issue.
- Do not modify ignored local-only scaffolding unless the issue explicitly asks.
- Do not include private machine names, private paths, or internal ticket refs in tracked files.
- Add or update tests for behavior changes.
- Use existing project style and patterns.
- Avoid broad catches, silent fallbacks, or success-shaped error handling.
- If a fix touches more than five files, stop and write a plan-confirmation handoff before continuing.

## Validation

Required local validation for code changes:

```bash
npm test
```

If the ticket or `AGENTS.md` requires a build/type-check command, run it when available. If a documented command is missing from `package.json`, do not invent project configuration unless the ticket asks for it; record the missing command clearly in the workpad validation notes.

For deployment-related tickets:

- Use only the repository deployment script named in `AGENTS.md`.
- Never use raw `rsync`, `scp`, or `ssh` deployment commands directly.
- Deploy only when the issue explicitly requests deployment or a human-confirmed plan requires it.
- Do not change CLI auth/config on hosts where `AGENTS.md` says it must not be configured.
- Do not write hostnames or host-specific deployment details into tracked files, commit messages, PR bodies, or public comments.

## Commit and PR rules

1. Before commit, inspect the diff and confirm no private hostnames, private paths, internal ticket IDs, or conversation text are present.
2. Stage only intentional files. Never use `git add -A`.
3. Use a concise conventional commit message when possible.
4. Include the Copilot co-author trailer.
5. Push the feature branch to `origin`.
6. Open or update a PR against `origin/main`.
7. If no GitHub Actions are configured, record `No remote PR checks configured` in the workpad and rely on local validation.

## PR feedback sweep

Before moving to `Human Review` for a ticket with a PR:

1. Gather top-level PR comments with `gh pr view --comments`.
2. Gather inline review comments with `gh api repos/hongqn/tmux-cc/pulls/<pr>/comments`.
3. Gather review summaries and states with `gh pr view --json reviews`.
4. Treat every actionable reviewer comment as blocking until addressed or explicitly pushed back with a justified reply.
5. Re-run validation after feedback-driven changes.
6. Confirm the branch is pushed and PR checks are green, or record that no remote checks are configured.

## Blocked-access escape hatch

Use only when completion is blocked by missing required tools, auth, permissions, secrets, or an unsafe operation that cannot be resolved in-session.

When blocked:

1. Update `## Codex Workpad` with:
   - what is missing,
   - why it blocks validation, push, PR feedback, deployment, or acceptance,
   - what was tried,
   - exact unblock action needed.
2. Update `## Review Handoff` last with `Status: Blocked`.
3. Move the issue to `Human Review`.

## Review handoff template

Use a separate persistent comment with this shape. Keep it compact.

````md
## Review Handoff

Status: Waiting for PR review

Review focus:
- <1-3 bullets naming what to inspect>

What changed:
- <1-3 bullets summarizing final behavior>

Validation:
- <commands/checks that passed, or clear caveat>

Risk/attention:
- <risky assumptions, skipped coverage, deployment caveats, or None>

Human action needed: <one explicit sentence>
````

For blocked handoffs:

````md
## Review Handoff

Status: Blocked

Blocker:
- <what blocks completion>

Impact:
- <what cannot be completed>

Tried:
- <fallbacks attempted>

Exact unblock action:
- <what human/environment must provide>

Human action needed: <one explicit sentence>
````

## Completion bar before Human Review

- Workpad checklist is complete and accurate.
- Acceptance criteria are met or explicitly blocked.
- Required local validation has passed or is explicitly blocked.
- PR branch is pushed to `origin` when code changed.
- PR feedback sweep is complete when a PR exists.
- PR checks are green, or the workpad states that no remote checks are configured.
- `## Review Handoff` is current, compact, and posted last.
