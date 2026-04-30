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
- Prefer editing persistent `## Codex Workpad` and `## Review Handoff` comments
  over creating extra progress comments.
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

1. Search existing comments for the marker header.
2. Update that comment when found.
3. Create a new marked comment only when none exists.
4. Update the workpad first, then update the handoff last.

