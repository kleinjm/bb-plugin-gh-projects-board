// Standalone harness: exercises the GraphQL layer without a running bb server.
//
//   npx tsx src/cli-check.ts my-org 1 "assignee:@me -status:Done!"
//
// Kept out of the plugin's own surface on purpose — it is a development tool,
// not a `bb` command.
import { checkAuth } from "./github/cli.js";
import {
  fetchProjectBoard,
  fetchViewerLogin,
  resolveOwnerKind,
} from "./github/projects.js";
import { buildBoard } from "./board.js";

async function main(): Promise<number> {
  const [login, numberArg, filter = ""] = process.argv.slice(2);
  if (login === undefined || numberArg === undefined) {
    process.stderr.write(
      'Usage: tsx src/cli-check.ts <owner> <project-number> ["filter"]\n',
    );
    return 1;
  }

  const number = Number.parseInt(numberArg, 10);
  if (!Number.isInteger(number) || number <= 0) {
    process.stderr.write(`Not a project number: ${numberArg}\n`);
    return 1;
  }

  const auth = await checkAuth();
  if (!auth.ok) {
    process.stderr.write(`gh is not usable: ${auth.reason}\n`);
    return 1;
  }

  const ownerKind = await resolveOwnerKind(login);
  const viewerLogin = await fetchViewerLogin();
  const project = await fetchProjectBoard({ ownerKind, login, number });
  const board = buildBoard(project, {
    filter,
    viewerLogin,
    includeEmptyColumns: false,
  });

  const lines = [
    `${board.title}  (${ownerKind} ${login}, #${number})`,
    `signed in as ${auth.login}; grouped by ${board.groupedBy ?? "nothing"}`,
    `${project.items.length} items in project, ${board.total} match ${
      filter === "" ? "(no filter)" : JSON.stringify(filter)
    }`,
    "",
  ];

  for (const column of board.columns) {
    lines.push(`## ${column.name}  ${column.items.length}`);
    if (column.description !== null) lines.push(`   ${column.description}`);
    for (const item of column.items.slice(0, 10)) {
      const labels =
        item.labels.length === 0
          ? ""
          : `  [${item.labels.map((label) => label.name).join(", ")}]`;
      lines.push(`   ${item.reference ?? item.kind}  ${item.title}${labels}`);
    }
    if (column.items.length > 10) {
      lines.push(`   … ${column.items.length - 10} more`);
    }
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
