---
name: run-tests
description:
  Run tmux-cc validation; use when verifying implementation changes, PR updates,
  merge conflict resolutions, or deployment readiness.
---

# Run Tests

## Core rule

Use project scripts that already exist. Do not invent new build, lint, or
type-check configuration while validating an unrelated change.

## Required validation

```bash
npm test
```

This runs `vitest run` through the package script.

## Optional validation

Run additional package scripts only when they exist or the ticket explicitly
requires them:

```bash
npm run build
npm run lint
npm run typecheck
```

If `AGENTS.md` names a validation command that is missing from `package.json`,
record it as a repository command mismatch instead of adding config just to make
the command exist.

## Deployment readiness

Before any deployment requested by the ticket:

1. Run `npm test`.
2. Confirm the working tree is clean or only contains intentional uncommitted
   deployment notes outside tracked files.
3. Use only the deployment script named in `AGENTS.md`.
4. Never run raw remote-copy or remote-shell deployment commands directly.

## Reporting

Record exact commands and outcomes in the workpad. Keep logs concise and do not
paste conversation/session content, deployment target names, host-specific paths,
or secrets into Linear, PR bodies, commits, docs, tests, or code comments.

