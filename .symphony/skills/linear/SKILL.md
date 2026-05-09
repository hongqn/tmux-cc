---
name: linear
description:
  Use Symphony's linear_graphql tool for Linear comment editing, issue lookup,
  and handoff updates during tmux-cc issue automation.
---

# Linear GraphQL

## Primary tool

Use Symphony's `linear_graphql` client tool when available. It reuses the
orchestrator's Linear auth.

Tool input:

```json
{
  "query": "query or mutation document",
  "variables": {
    "key": "value"
  }
}
```

## Rules

- Send one GraphQL operation per tool call.
- Treat top-level `errors` as failure even when the tool call returns normally.
- Query only fields needed for the current operation.
- Prefer editing the three persistent comments — `## Spec`, `## Codex Workpad`,
  and `## Review Handoff` — over creating extra progress comments. Spec and
  Workpad are edited in place; a new Handoff comment is created for every
  `Human Review` transition.
- Keep Linear-facing content in Chinese.
- Do not paste private deployment identifiers, host-specific paths, secrets, or
  conversation/session transcripts into Linear comments.

## Common issue lookup

```graphql
query IssueByKey($key: String!) {
  issue(id: $key) {
    id
    identifier
    title
    branchName
    url
    state {
      id
      name
      type
    }
    comments {
      nodes {
        id
        body
        createdAt
      }
    }
    links {
      nodes {
        id
        url
        title
      }
    }
  }
}
```

## Comment update pattern

1. Search existing comments for the marker header (`## Spec`, `## Codex Workpad`, or `## Review Handoff`).
2. For Spec and Workpad, update that comment in place when found; preserve the comment ID across attempts and full resets.
3. For Handoff, create a new marked comment for each `Human Review` transition; never edit or reuse a prior Handoff comment.
4. Create a new marked comment only when none exists for Spec/Workpad; for Handoff, always create new.
5. Update order at every stop for human action: Spec (only if scope/approach/acceptance/assumptions changed) -> Workpad -> new Handoff. The latest visible comment must be the compact Handoff.

