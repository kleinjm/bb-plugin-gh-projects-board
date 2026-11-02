#!/usr/bin/env node
// Return prefiltered GitHub responses without implementing another filter engine.
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const { setTimeout } = require("node:timers/promises");

async function main() {
  const fixture = JSON.parse(
    readFileSync(process.env.GH_BOARD_FIXTURE, "utf8"),
  );
  const args = process.argv.slice(2);
  const variables = {};
  const flags = {};
  for (let index = 2; index < args.length; index += 2) {
    const flag = args[index];
    const field = args[index + 1];
    const separator = field.indexOf("=");
    const key = field.slice(0, separator);
    let value = field.slice(separator + 1);
    if (flag === "-F") {
      if (value.startsWith("@")) throw new Error("Unexpected file variable");
      if (/^(true|false|null|-?\d+)$/.test(value)) value = JSON.parse(value);
    }
    variables[key] = value;
    flags[key] = flag;
  }
  const query = variables.query;
  const kind = query.includes("repositoryOwner")
    ? "owner"
    : query.includes("viewer {")
      ? "viewer"
      : query.includes("shortDescription")
        ? "fields"
        : "items";
  appendFileSync(
    process.env.GH_BOARD_CALLS,
    JSON.stringify({ kind, variables, flags }) + "\n",
  );

  const respond = (data) => process.stdout.write(JSON.stringify({ data }));
  const fail = (message) =>
    process.stdout.write(JSON.stringify({ errors: [{ message }] }));
  if (kind === "viewer") {
    if (fixture.viewerError) return fail("Authentication failed");
    return respond({ viewer: { login: fixture.viewerLogin } });
  }
  if (kind === "owner") {
    return respond({
      repositoryOwner: {
        __typename: fixture.ownerKind === "user" ? "User" : "Organization",
      },
    });
  }
  const root = fixture.ownerKind ?? "organization";
  if (kind === "fields") {
    return respond({
      [root]: {
        projectV2: {
          id: "p",
          title: "Example board",
          number: variables.number,
          url: "https://example.invalid/project",
          closed: false,
          shortDescription: null,
          items: { totalCount: fixture.totalCount },
          fields: {
            nodes: [
              {
                __typename: "ProjectV2SingleSelectField",
                id: "status",
                name: "Status",
                options: ["Todo", "In Progress", "Done!"].map((name) => ({
                  id: name,
                  name,
                })),
              },
            ],
          },
        },
      },
    });
  }
  if (!query.includes("query: $filter"))
    throw new Error("Missing native item query");
  if (fixture.errors?.[variables.filter])
    return fail(fixture.errors[variables.filter]);
  const pages =
    fixture.byViewer?.[fixture.viewerLogin]?.[variables.filter] ??
    fixture.pages[variables.filter];
  if (pages === undefined)
    throw new Error(`Unexpected filter: ${JSON.stringify(variables.filter)}`);
  const page = Number(variables.cursor ?? 0);
  const nodes = pages[page];
  if (nodes === undefined)
    throw new Error(`Unexpected cursor: ${variables.cursor}`);
  if (fixture.blockedFilters?.includes(variables.filter)) {
    while (!existsSync(process.env.GH_BOARD_RELEASE)) await setTimeout(10);
  }
  return respond({
    [root]: {
      projectV2: {
        items: {
          nodes,
          pageInfo: {
            hasNextPage: page + 1 < pages.length,
            endCursor: String(page + 1),
          },
        },
      },
    },
  });
}

main().catch((error) => {
  process.stderr.write(error.message);
  process.exitCode = 1;
});
