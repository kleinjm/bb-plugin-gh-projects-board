// bb-plugin-gh-projects-board — backend entry.
//
// Reads a GitHub Projects v2 board through the machine's signed-in `gh` session
// and serves it to three surfaces: the board page (app.tsx, over RPC), the
// `bb gh-projects-board` CLI, and the skill that tells agents how to use it.
//
// Project items are cached in bb.storage.kv so opening the page is instant; a
// background service refreshes them, and any refresh publishes a realtime
// signal so every open page updates.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkAuth, GhProjectScopeError } from "./src/github/cli.js";
import {
  fetchProjectBoard,
  fetchViewerLogin,
  listProjects,
  resolveOwnerKind,
  type ProjectBoard,
} from "./src/github/projects.js";
import { buildBoard, NO_STATUS, type BuiltBoard } from "./src/board.js";
import { resolveFilter } from "./src/filter-contract.js";

// --- wire schemas -----------------------------------------------------------

const boardItemSchema = z.object({
  itemId: z.string(),
  kind: z.enum(["Issue", "PullRequest", "DraftIssue", "Unknown"]),
  number: z.number().int().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  repository: z.string().nullable(),
  reference: z.string().nullable(),
  state: z.string().nullable(),
  isDraft: z.boolean(),
  author: z.string().nullable(),
  assignees: z.array(
    z.object({ login: z.string(), avatarUrl: z.string().nullable() }),
  ),
  labels: z.array(z.object({ name: z.string(), color: z.string().nullable() })),
  milestone: z.string().nullable(),
  issueType: z.string().nullable(),
  updatedAt: z.string().nullable(),
  singleSelect: z.record(z.string(), z.string()),
  numbers: z.record(z.string(), z.number()),
  text: z.record(z.string(), z.string()),
});

const boardColumnSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  items: z.array(boardItemSchema),
});

const builtBoardSchema = z.object({
  title: z.string(),
  url: z.string(),
  groupedBy: z.string().nullable(),
  columns: z.array(boardColumnSchema),
  total: z.number().int(),
});

const boardStateSchema = z.object({
  /** Null until the plugin is configured or the first fetch succeeds. */
  board: builtBoardSchema.nullable(),
  /** Field names the project offers for grouping. */
  groupableFields: z.array(z.string()),
  /** Total items in the project, before filtering. */
  itemCount: z.number().int(),
  viewerLogin: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  /** A human-readable reason the board is empty, when it is. */
  problem: z.string().nullable(),
  /** True when `problem` is a token-scope failure, which has a known remedy. */
  scopeProblem: z.boolean(),
  configured: z.boolean(),
  owner: z.string(),
  projectNumber: z.number().int(),
  filter: z.string(),
  groupBy: z.string().nullable(),
});
export type BoardState = z.infer<typeof boardStateSchema>;
export type BoardItemView = z.infer<typeof boardItemSchema>;
export type BoardColumnView = z.infer<typeof boardColumnSchema>;

export const rpcContract = defineRpcContract({
  board_get: {
    input: z
      .object({
        filter: z.string().max(500).optional(),
        groupBy: z.string().max(80).nullish(),
      })
      .nullable(),
    output: boardStateSchema,
  },
  board_refresh: {
    input: z
      .object({
        filter: z.string().max(500).optional(),
        groupBy: z.string().max(80).nullish(),
      })
      .nullable(),
    output: boardStateSchema,
  },
  projects_list: {
    input: z.object({ owner: z.string().trim().min(1).max(100) }),
    output: z.object({
      projects: z.array(
        z.object({
          number: z.number().int(),
          title: z.string(),
          url: z.string(),
          closed: z.boolean(),
        }),
      ),
    }),
  },
});

/** Realtime channel app.tsx listens on. */
const BOARD_CHANGED = "board-changed";

const cacheSchema = z.object({
  owner: z.string(),
  projectNumber: z.number().int(),
  fetchedAt: z.string(),
  viewerLogin: z.string().nullable(),
  project: z.custom<ProjectBoard>(() => true),
});
type Cache = z.infer<typeof cacheSchema>;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    owner: {
      type: "string",
      label: "Owner",
      description:
        "The GitHub user or organization that owns the project, e.g. my-org.",
      default: "",
    },
    projectNumber: {
      type: "number",
      label: "Project number",
      description:
        "The number in the project URL, e.g. 1 in github.com/orgs/my-org/projects/1.",
      default: 0,
    },
    defaultFilter: {
      type: "string",
      label: "Default filter",
      description:
        "GitHub filter syntax, e.g. assignee:@me -status:Done! — @me is the signed-in account.",
      default: "assignee:@me",
    },
    hideNoStatus: {
      type: "boolean",
      label: "Hide the No Status column",
      description:
        "GitHub's saved views can hide it; the API does not expose that setting, so choose it here.",
      default: false,
    },
    hideEmptyColumns: {
      type: "boolean",
      label: "Hide empty columns",
      default: true,
    },
    refreshMinutes: {
      type: "number",
      label: "Refresh every (minutes)",
      description:
        "How often to re-read the project in the background. 0 disables it.",
      default: 15,
    },
    tokenFile: {
      type: "string",
      label: "Token file (optional)",
      description:
        "Path to a file holding a GitHub token to use instead of the server's own. " +
        "For a server whose environment carries a different token than you want the " +
        "board to use. The token is read at call time and never stored by the plugin.",
      default: "",
    },
  });

  const config = await settings.get();
  const owner = String(config.owner ?? "").trim();
  const projectNumber = Number(config.projectNumber ?? 0);
  const defaultFilter = String(config.defaultFilter ?? "");
  const tokenFileSetting = String(config.tokenFile ?? "").trim();
  const tokenFile = tokenFileSetting === "" ? null : tokenFileSetting;
  const configured =
    owner !== "" && Number.isInteger(projectNumber) && projectNumber > 0;

  // Owner kind rarely changes; resolving it costs a request, so keep it.
  let ownerKindCache: { login: string; kind: "organization" | "user" } | null =
    null;
  async function ownerKindFor(
    login: string,
    signal?: AbortSignal,
  ): Promise<"organization" | "user"> {
    if (ownerKindCache?.login === login) return ownerKindCache.kind;
    const kind = await resolveOwnerKind(login, { signal, tokenFile });
    ownerKindCache = { login, kind };
    return kind;
  }

  // A real board serializes to roughly a megabyte, well past the 256KB kv
  // ceiling, so the cache lives in the plugin's own SQLite database as a
  // single row of JSON.
  const db = bb.storage.database();
  db.exec(
    `CREATE TABLE IF NOT EXISTS board_cache (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       owner TEXT NOT NULL,
       project_number INTEGER NOT NULL,
       payload TEXT NOT NULL
     )`,
  );

  function readCache(): Cache | null {
    const row = db
      .prepare("SELECT payload FROM board_cache WHERE id = 1")
      .get() as { payload: string } | undefined;
    if (row === undefined) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload);
    } catch {
      return null;
    }
    const parsed = cacheSchema.safeParse(raw);
    if (!parsed.success) return null;
    // A changed target makes the cache meaningless.
    if (parsed.data.owner !== owner) return null;
    if (parsed.data.projectNumber !== projectNumber) return null;
    return parsed.data;
  }

  function writeCache(cache: Cache): void {
    db.prepare(
      `INSERT INTO board_cache (id, owner, project_number, payload)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner,
         project_number = excluded.project_number,
         payload = excluded.payload`,
    ).run(cache.owner, cache.projectNumber, JSON.stringify(cache));
  }

  async function fetchAndCache(signal?: AbortSignal): Promise<Cache> {
    const ownerKind = await ownerKindFor(owner, signal);
    const viewerLogin = await fetchViewerLogin({ signal, tokenFile }).catch(
      () => null,
    );
    const project = await fetchProjectBoard(
      { ownerKind, login: owner, number: projectNumber },
      { signal, tokenFile },
    );
    const cache: Cache = {
      owner,
      projectNumber,
      fetchedAt: new Date().toISOString(),
      viewerLogin,
      project,
    };
    writeCache(cache);
    bb.realtime.publish(BOARD_CHANGED, { itemCount: project.items.length });
    return cache;
  }

  function emptyState(
    problem: string | null,
    filter: string,
    scopeProblem = false,
  ): BoardState {
    return {
      board: null,
      groupableFields: [],
      itemCount: 0,
      viewerLogin: null,
      fetchedAt: null,
      problem,
      scopeProblem,
      configured,
      owner,
      projectNumber,
      filter,
      groupBy: null,
    };
  }

  function present(
    cache: Cache,
    filter: string,
    groupBy: string | null,
  ): BoardState {
    const built: BuiltBoard = buildBoard(cache.project, {
      filter,
      groupBy: groupBy ?? undefined,
      viewerLogin: cache.viewerLogin,
      includeEmptyColumns: !(config.hideEmptyColumns ?? true),
    });

    const keep = (config.hideNoStatus ?? false)
      ? built.columns.filter((column) => column.name !== NO_STATUS)
      : built.columns;
    const hidden = built.columns
      .filter((column) => !keep.includes(column))
      .reduce((sum, column) => sum + column.items.length, 0);

    return {
      board: { ...built, columns: keep, total: built.total - hidden },
      groupableFields: cache.project.singleSelectFields.map(
        (field) => field.name,
      ),
      itemCount: cache.project.items.length,
      viewerLogin: cache.viewerLogin,
      fetchedAt: cache.fetchedAt,
      problem: null,
      scopeProblem: false,
      configured,
      owner,
      projectNumber,
      filter,
      groupBy: built.groupedBy,
    };
  }

  async function getState(
    filter: string,
    groupBy: string | null,
    refresh: boolean,
    signal?: AbortSignal,
  ): Promise<BoardState> {
    if (!configured) {
      return emptyState(
        "Set the owner and project number in this plugin's settings.",
        filter,
      );
    }
    try {
      const cache = refresh
        ? await fetchAndCache(signal)
        : (readCache() ?? (await fetchAndCache(signal)));
      return present(cache, filter, groupBy);
    } catch (error) {
      bb.log.warn(`board read failed: ${String(error)}`);
      if (error instanceof GhProjectScopeError) {
        return emptyState(error.message, filter, true);
      }
      return emptyState(
        error instanceof Error ? error.message : String(error),
        filter,
      );
    }
  }

  bb.rpc.register(rpcContract, {
    board_get: (input) =>
      getState(
        resolveFilter(input?.filter, defaultFilter),
        input?.groupBy ?? null,
        false,
      ),
    board_refresh: (input) =>
      getState(
        resolveFilter(input?.filter, defaultFilter),
        input?.groupBy ?? null,
        true,
      ),
    projects_list: async ({ owner: login }) => {
      const kind = await ownerKindFor(login);
      const projects = await listProjects(kind, login, { tokenFile });
      return {
        projects: projects.map((project) => ({
          number: project.number,
          title: project.title,
          url: project.url,
          closed: project.closed,
        })),
      };
    },
  });

  // --- CLI --------------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb gh-projects-board board [--filter <query>] [--group-by <field>] [--json]",
    "  bb gh-projects-board refresh [--filter <query>] [--json]",
    "  bb gh-projects-board projects [--owner <login>] [--json]",
    "  bb gh-projects-board status [--json]",
  ].join("\n");

  function renderBoard(state: BoardState): string {
    if (state.board === null) return state.problem ?? "No board.";
    const lines = [
      `${state.board.title} — ${state.board.total} of ${state.itemCount} items`,
      `grouped by ${state.board.groupedBy ?? "nothing"}; filter: ${
        state.filter === "" ? "(none)" : state.filter
      }`,
      "",
    ];
    for (const column of state.board.columns) {
      lines.push(`## ${column.name}  ${column.items.length}`);
      if (column.description !== null) lines.push(`   ${column.description}`);
      for (const item of column.items) {
        lines.push(`   ${item.reference ?? item.kind}  ${item.title}`);
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  }

  function flagValue(argv: readonly string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    return argv[index + 1];
  }

  bb.cli.register({
    name: "gh-projects-board",
    summary: "Read a GitHub Projects v2 board",
    commands: [
      {
        name: "board",
        summary: "Show the board grouped into columns",
        usage:
          "bb gh-projects-board board [--filter <query>] [--group-by <field>] [--json]",
      },
      {
        name: "refresh",
        summary: "Re-read the project from GitHub now",
        usage: "bb gh-projects-board refresh [--filter <query>] [--json]",
      },
      {
        name: "projects",
        summary: "List an owner's projects",
        usage: "bb gh-projects-board projects [--owner <login>] [--json]",
      },
      {
        name: "status",
        summary: "Show configuration and gh auth state",
        usage: "bb gh-projects-board status [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      const [command] = rest;

      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "board":
        case "refresh": {
          const filter = flagValue(rest, "--filter") ?? defaultFilter;
          const groupBy = flagValue(rest, "--group-by") ?? null;
          const state = await getState(filter, groupBy, command === "refresh");
          if (state.board === null) {
            return {
              exitCode: 1,
              stderr: json
                ? JSON.stringify(state)
                : (state.problem ?? "No board."),
            };
          }
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(state) : renderBoard(state),
          };
        }

        case "projects": {
          const login = flagValue(rest, "--owner") ?? owner;
          if (login === "") {
            return {
              exitCode: 1,
              stderr: "No owner configured. Pass --owner <login>.",
            };
          }
          const kind = await ownerKindFor(login);
          const projects = await listProjects(kind, login, { tokenFile });
          const text =
            projects
              .map(
                (project) =>
                  `${project.number}\t${project.title}${
                    project.closed ? "\t(closed)" : ""
                  }`,
              )
              .join("\n") || "No projects.";
          return {
            exitCode: 0,
            stdout: json ? JSON.stringify(projects) : text,
          };
        }

        case "status": {
          const auth = await checkAuth({ tokenFile });
          const value = {
            configured,
            owner,
            projectNumber,
            defaultFilter,
            // The path only: never the token it holds.
            tokenFile,
            gh: auth.ok ? { signedInAs: auth.login } : { problem: auth.reason },
          };
          return {
            exitCode: auth.ok ? 0 : 1,
            stdout: json
              ? JSON.stringify(value)
              : [
                  `configured: ${configured ? "yes" : "no"}`,
                  `owner: ${owner === "" ? "(unset)" : owner}`,
                  `project: ${projectNumber === 0 ? "(unset)" : projectNumber}`,
                  `filter: ${defaultFilter === "" ? "(none)" : defaultFilter}`,
                  `token file: ${tokenFile ?? "(none — using the server's own)"}`,
                  auth.ok
                    ? `gh: signed in as ${auth.login}`
                    : `gh: ${auth.reason}`,
                ].join("\n"),
          };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // --- background refresh -----------------------------------------------------

  const refreshMinutes = Number(config.refreshMinutes ?? 15);
  if (configured && Number.isFinite(refreshMinutes) && refreshMinutes > 0) {
    const intervalMs = Math.max(1, refreshMinutes) * 60_000;
    bb.background.service("refresh", {
      async start(signal) {
        while (!signal.aborted) {
          try {
            await fetchAndCache(signal);
          } catch (error) {
            if (signal.aborted) return;
            bb.log.warn(`background refresh failed: ${String(error)}`);
          }
          // Must wake on abort, or a reload reports "service did not stop".
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, intervalMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      },
    });
  }

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
