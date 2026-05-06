# Repository Agent Instructions

## Deployment

Unattended agents may deploy this repository only through the tracked deployment entrypoint:

```bash
npm run deploy -- --stage canary
npm run deploy -- --stage remaining
```

Use `npm run deploy -- --stage all` only when the current task explicitly allows deploying every configured target in one run. The script always orders `all` as canary targets first, then remaining targets.

Before any real deployment, run the same stage with `--dry-run` and run `npm test`.

Deployment target details must come from one of these private sources:

- `.tmux-cc-deploy.json`
- a path in `TMUX_CC_DEPLOY_CONFIG`
- inline JSON in `TMUX_CC_DEPLOY_CONFIG_JSON`

Do not commit deployment target names, hostnames, private paths, secrets, command arguments, or operational logs. Do not paste real deployment output into Linear, PR comments, commits, or docs. Summaries should use generic target classes such as `canary` and `remaining`.

Do not run raw `ssh`, `scp`, `rsync`, or remote-shell deployment commands directly from an unattended session. Put target-specific commands in the private deployment config and invoke only the `npm run deploy` entrypoint above.

## Git Hygiene

Push feature branches to `origin` and open PRs against `main`. Do not push directly to `main`.
