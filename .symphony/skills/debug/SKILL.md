---
name: debug
description:
  Investigate Symphony or Codex run failures for tmux-cc automation; use when
  runs stall, retry repeatedly, fail unexpectedly, or lose tool access.
---

# Debug Symphony Runs

## Goal

Find why a run stalled, retried, or failed without leaking private runtime
details into repository-visible artifacts.

## Log sources

- Primary runtime log: `log/symphony.log`
- Rotated logs: `log/symphony.log*`

## Triage flow

1. Search by issue identifier or Linear UUID in local logs.
2. Extract the related Codex/Symphony session identifier.
3. Trace lifecycle events for that one identifier only.
4. Classify the failure:
   - app-server startup,
   - tool/auth unavailable,
   - sandbox or filesystem denial,
   - network failure,
   - turn timeout/stall,
   - worker crash.
5. Record only the minimal sanitized evidence needed for the workpad/handoff.

## Useful commands

```bash
rg -n "issue_identifier=<issue-key>" log/symphony.log*
rg -n "issue_id=<linear-uuid>" log/symphony.log*
rg -o "session_id=[^ ;]+" log/symphony.log* | sort -u
rg -n "session_id=<session-id>" log/symphony.log*
rg -n "stalled|retry|timeout|failed|permission|sandbox|auth" log/symphony.log*
```

## Privacy gate

- Do not copy full prompts, chat transcripts, or model messages into tracked
  files, commits, PRs, tests, docs, or public comments.
- Do not copy deployment target names, host-specific paths, secrets, tokens, or
  local-only scaffolding details.
- Summarize failures generically: name the failing stage and class of error,
  then point to local logs for full details.

