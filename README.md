# GitHub Projects Board

Your GitHub Projects v2 board inside BB: real columns from the project's own
Status field, in the project's own order, with the filters your saved views
already use.

BB's existing GitHub integrations read issues and pull requests, but not
Projects. That means everything assigned to you lands in one undifferentiated
column with no status and no priority — fine for noticing work, useless for
managing it. This plugin reads the project itself.

## What you get

- **Columns from the project's Status field**, in the order the project
  defines, with each option's description under the heading — the same layout
  you see on github.com.
- **GitHub's filter syntax**, so a view like `assignee:@me -status:Done!`
  behaves the way it does on GitHub. `@me` resolves to the signed-in account.
- **Any single-select field as the grouping**, not just Status.
- **Cards showing** the `repo #number` reference, title, labels, assignees,
  issue type and milestone.
- **Org and user projects**, resolved automatically.

## Requirements

The [GitHub CLI](https://cli.github.com) must be installed and signed in on the
machine running the BB server. The plugin shells out to your `gh` session and
**stores no token of its own**.

Your token needs to be able to read Projects, which is fussier than it sounds:

| Token kind | Org projects | User projects |
| --- | --- | --- |
| Classic PAT with `read:project` | Yes | Yes |
| Fine-grained PAT | Only in some org configurations | **Never** — a documented GitHub limitation |
| `gh auth login` (OAuth) | Yes, with the scope granted | Yes |

If you hit `Resource not accessible by personal access token`, that is the
scope talking. A classic token with `read:project` is the reliable fix; add
`repo` if your issues are in private repositories. Organizations that enforce
SSO also need the token authorized against the org.

## Development

```bash
npm install
npx tsc --noEmit          # typecheck
bb plugin build           # bundle
bb plugin install .       # register this directory
bb plugin dev             # rebuild and reload on save
```

A standalone harness exercises the GraphQL layer without a running BB server:

```bash
npx tsx src/cli-check.ts <owner> <project-number> ["filter"]
npx tsx src/cli-check.ts my-org 1 "assignee:@me -status:Done!"
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/github/cli.ts` | `gh` wrapper, GraphQL transport, typed auth and scope errors |
| `src/github/queries.ts` | GraphQL documents, generated per owner kind |
| `src/github/projects.ts` | Zod schemas, cursor pagination, item flattening |
| `src/board.ts` | Column grouping and the filter parser |
| `src/cli-check.ts` | Development harness |

## Notes and limits

- Projects v2 has **no server-side filtering on field values**, so the plugin
  reads every item and filters locally. A project of a few thousand items is a
  handful of sequential requests.
- Archived items are skipped.
- An unknown filter key matches nothing rather than everything, so a typo shows
  an empty board instead of silently ignoring the term.
- Changing a card's status is deliberately not implemented yet: it needs
  `updateProjectV2ItemFieldValue` and a write scope, and read-only is the safer
  first release.

## License

MIT — see [LICENSE](LICENSE).
