# GitHub Projects Board

Shows a GitHub Projects v2 board inside BB, with columns taken from the
project's own Status field in the project's own order, and GitHub's filter
syntax for saved views such as `assignee:@me -status:Done!`.

Reads through the machine's signed-in `gh` CLI and stores no token. Needs a
token that can read Projects — a classic token with `read:project` is the
reliable choice, since fine-grained tokens cannot read user-owned projects at
all.

Read-only in this release: changing a card's status needs a write scope and
comes later.
