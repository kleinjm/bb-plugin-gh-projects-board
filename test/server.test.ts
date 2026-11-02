import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { type BoardState } from "../server.js";

const MINE = "assignee:@me -status:Done!";
const COMMA = 'custom_field:"value 1","value 2"';

function rawItem(id: string, status: string | null = "Todo") {
  return {
    id,
    isArchived: false,
    type: "ISSUE",
    fieldValues: {
      nodes:
        status === null
          ? []
          : [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue",
                name: status,
                field: { id: "status", name: "Status" },
              },
            ],
    },
    content: { __typename: "Issue", id, title: `Item ${id}`, state: "OPEN" },
  };
}

type Pages = Record<string, (ReturnType<typeof rawItem> | null)[][]>;
interface Fixture {
  viewerLogin: string;
  totalCount: number;
  pages: Pages;
  ownerKind?: "organization" | "user";
  byViewer?: Record<string, Pages>;
  viewerError?: boolean;
  errors?: Record<string, string>;
  blockedFilters?: string[];
}
interface GhCall {
  kind: string;
  variables: Record<string, string | number>;
  flags: Record<string, string>;
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return;
    await setTimeout(10);
  }
  assert.fail("Timed out waiting for the fake GitHub request");
}

async function setup(
  t: TestContext,
  settings: Record<string, string | number | boolean> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "gh-board-test-"));
  const fixtureFile = join(directory, "fixture.json");
  const callsFile = join(directory, "calls.jsonl");
  const releaseFile = join(directory, "release");
  const executable = join(directory, "gh");
  writeFileSync(
    executable,
    readFileSync(new URL("./fixtures/gh.cjs", import.meta.url)),
  );
  chmodSync(executable, 0o755);
  writeFileSync(callsFile, "");
  const environment = {
    PATH: directory + ":" + process.env.PATH,
    GH_BOARD_FIXTURE: fixtureFile,
    GH_BOARD_CALLS: callsFile,
    GH_BOARD_RELEASE: releaseFile,
  };
  const original = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, environment);
  const fixture: Fixture = {
    viewerLogin: "alice",
    totalCount: 12,
    pages: {
      [MINE]: [[rawItem("mine")]],
      [COMMA]: [[rawItem("one"), rawItem("two", "In Progress")]],
      "": [[rawItem("all")]],
    },
  };
  const save = () => writeFileSync(fixtureFile, JSON.stringify(fixture));
  save();
  const database = new DatabaseSync(":memory:");
  let host = createFakePluginHost({
    settings: {
      owner: "example",
      projectNumber: 1,
      defaultFilter: MINE,
      refreshMinutes: 0,
      ...settings,
    },
  });
  const load = async (bb: typeof host.bb) => {
    bb.storage.database = () =>
      database as unknown as ReturnType<typeof bb.storage.database>;
    await plugin(bb);
  };
  const pending = new Set<Promise<unknown>>();
  t.after(async () => {
    writeFileSync(releaseFile, "");
    await Promise.allSettled(pending);
    await host.harness.lifecycle.dispose();
    database.close();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await load(host.bb);
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GhCall);
  const call = async (
    method: "board_get" | "board_refresh",
    input: unknown = null,
  ) => {
    const result = host.harness.behavior.callRpc(method, input);
    pending.add(result);
    try {
      return (await result) as BoardState;
    } finally {
      pending.delete(result);
    }
  };
  return {
    fixture,
    save,
    database,
    calls,
    call,
    items: () => calls().filter((call) => call.kind === "items"),
    ids: (state: BoardState) =>
      state.board?.columns.flatMap((column) =>
        column.items.map((item) => item.itemId),
      ),
    signals: () => host.harness.inspection.realtimeSignals,
    harness: () => host.harness,
    release: () => writeFileSync(releaseFile, ""),
    reload: async () => {
      host = await host.harness.lifecycle.reload(load);
    },
  };
}

describe("native GitHub filtering", () => {
  it("keeps native custom-field matches and the unfiltered project count", async (t) => {
    const board = await setup(t);
    const state = await board.call("board_get", { filter: COMMA });
    assert.equal(state.problem, null);
    assert.deepEqual(board.ids(state), ["one", "two"]);
    assert.equal(state.board?.total, 2);
    assert.equal(state.itemCount, 12);
    assert.equal(state.filter, COMMA);
    assert.equal(board.items()[0].variables.filter, COMMA);
  });

  it("forwards the same literal filter on every page", async (t) => {
    const board = await setup(t);
    board.fixture.pages[COMMA] = [
      [rawItem("one"), null, { ...rawItem("archived"), isArchived: true }],
      [rawItem("two")],
    ];
    board.save();
    const state = await board.call("board_get", { filter: COMMA });
    assert.deepEqual(board.ids(state), ["one", "two"]);
    assert.deepEqual(
      board
        .items()
        .map(({ variables }) => [variables.filter, variables.cursor]),
      [
        [COMMA, undefined],
        [COMMA, "1"],
      ],
    );
  });

  it("passes advanced queries and string-like literals unchanged", async (t) => {
    const board = await setup(t);
    const filters = [
      "status:Todo,Done",
      '-status:"In Progress","Done!"',
      "assignee:@me",
      "has:priority",
      "points:>=3",
      "status:Todo OR label:bug",
      "iteration:@current",
      "repo:example/web",
      'title:"A quote, a colon: and spaces"',
      "123",
      "true",
      "null",
      "@someone",
    ];
    for (const filter of filters)
      board.fixture.pages[filter] = [[rawItem(filter)]];
    board.save();
    for (const filter of filters) {
      const state = await board.call("board_get", { filter });
      assert.deepEqual(board.ids(state), [filter]);
    }
    assert.deepEqual(
      board.items().map(({ variables }) => variables.filter),
      filters,
    );
    assert.ok(board.items().every(({ flags }) => flags.filter === "-f"));
  });

  it("preserves omitted defaults and deliberate empty filters", async (t) => {
    const board = await setup(t);
    for (const input of [null, {}, { groupBy: "Status" }]) {
      assert.deepEqual(board.ids(await board.call("board_get", input)), [
        "mine",
      ]);
    }
    assert.deepEqual(board.ids(await board.call("board_get", { filter: "" })), [
      "all",
    ]);
    assert.deepEqual(
      board.items().map(({ variables }) => variables.filter),
      [MINE, ""],
    );
  });

  it("keeps an empty native result instead of falling back to another query", async (t) => {
    const board = await setup(t);
    board.fixture.pages[COMMA] = [[]];
    board.save();
    const state = await board.call("board_get", { filter: COMMA });
    assert.equal(state.problem, null);
    assert.deepEqual(board.ids(state), []);
    assert.equal(state.board?.total, 0);
    assert.equal(state.itemCount, 12);
    assert.equal(board.items().length, 1);
  });

  it("keeps different queries cached across regrouping and reloads", async (t) => {
    const board = await setup(t);
    await board.call("board_get", { filter: COMMA });
    await board.call("board_get", { filter: "" });
    await board.reload();
    assert.deepEqual(
      board.ids(
        await board.call("board_get", { filter: COMMA, groupBy: "Status" }),
      ),
      ["one", "two"],
    );
    assert.deepEqual(board.ids(await board.call("board_get", { filter: "" })), [
      "all",
    ]);
    assert.equal(board.items().length, 2);
    assert.equal(
      board.signals().length,
      0,
      "cache misses must not cause realtime reload loops",
    );
  });

  it("isolates @me results by the current account and requires authentication", async (t) => {
    const board = await setup(t);
    await board.call("board_get");
    board.fixture.viewerLogin = "bob";
    board.fixture.byViewer = { bob: { [MINE]: [[rawItem("bobs-item")]] } };
    board.save();
    const state = await board.call("board_get");
    assert.equal(state.viewerLogin, "bob");
    assert.deepEqual(board.ids(state), ["bobs-item"]);
    assert.equal(board.items().length, 2);
    board.fixture.viewerLogin = "alice";
    board.save();
    assert.deepEqual(board.ids(await board.call("board_get")), ["mine"]);
    assert.equal(board.items().length, 2);
    board.fixture.viewerError = true;
    board.save();
    const failed = await board.call("board_get");
    assert.equal(failed.board, null);
    assert.match(failed.problem!, /Authentication failed/);
  });

  it("does not reuse results after changing the configured project", async (t) => {
    const board = await setup(t);
    await board.call("board_get", { filter: COMMA });
    await board
      .harness()
      .behavior.setSettings({ owner: "another-owner", projectNumber: 2 });
    await board.reload();
    board.fixture.pages[COMMA] = [[rawItem("another-project")]];
    board.save();
    const state = await board.call("board_get", { filter: COMMA });
    assert.equal(state.owner, "another-owner");
    assert.equal(state.projectNumber, 2);
    assert.deepEqual(board.ids(state), ["another-project"]);
    assert.equal(board.items().length, 2);
  });

  it("surfaces native query errors without falling back to all items or caching failure", async (t) => {
    const board = await setup(t);
    board.fixture.errors = { [COMMA]: "Invalid search query" };
    board.save();
    const state = await board.call("board_get", { filter: COMMA });
    assert.equal(state.board, null);
    assert.match(state.problem!, /Invalid search query/);
    delete board.fixture.errors[COMMA];
    board.save();
    assert.deepEqual(
      board.ids(await board.call("board_get", { filter: COMMA })),
      ["one", "two"],
    );
    assert.equal(board.items().length, 2);
  });

  it("refreshes the requested query and invalidates other query results", async (t) => {
    const board = await setup(t);
    await board.call("board_get", { filter: COMMA });
    await board.call("board_get", { filter: "" });
    board.fixture.pages[COMMA] = [[rawItem("changed")]];
    board.fixture.pages[""] = [[rawItem("new-all")]];
    board.fixture.totalCount = 13;
    board.save();
    const refreshed = await board.call("board_refresh", { filter: COMMA });
    assert.deepEqual(board.ids(refreshed), ["changed"]);
    assert.equal(refreshed.itemCount, 13);
    assert.deepEqual(board.ids(await board.call("board_get", { filter: "" })), [
      "new-all",
    ]);
    assert.deepEqual(board.signals(), [
      { channel: "board-changed", payload: { itemCount: 13 } },
    ]);
    assert.equal(board.items().length, 4);
  });

  it("does not let a read started before refresh overwrite refreshed data", async (t) => {
    const board = await setup(t);
    board.fixture.blockedFilters = [COMMA];
    board.save();
    const oldRead = board.call("board_get", { filter: COMMA });
    await waitFor(() => board.items().length === 1);
    board.fixture.blockedFilters = [];
    board.fixture.pages[COMMA] = [[rawItem("fresh")]];
    board.save();
    assert.deepEqual(
      board.ids(await board.call("board_refresh", { filter: COMMA })),
      ["fresh"],
    );
    board.release();
    await oldRead;
    assert.deepEqual(
      board.ids(await board.call("board_get", { filter: COMMA })),
      ["fresh"],
    );
    assert.equal(board.items().length, 2);
  });

  it("background refresh invalidates custom queries and stops cleanly on abort", async (t) => {
    const board = await setup(t, { refreshMinutes: 15 });
    await board.call("board_get", { filter: COMMA });
    board.fixture.pages[COMMA] = [[rawItem("background-change")]];
    board.save();
    const service = board.harness().behavior.runService("refresh");
    await waitFor(() => board.signals().length > 0);
    service.controller.abort();
    await service.done;
    assert.deepEqual(
      board.ids(await board.call("board_get", { filter: COMMA })),
      ["background-change"],
    );
    assert.deepEqual(
      board.items().map(({ variables }) => variables.filter),
      [COMMA, MINE, COMMA],
    );
  });

  it("uses native filters and counts through the CLI as well", async (t) => {
    const board = await setup(t);
    const result = await board
      .harness()
      .behavior.runCli(["board", "--filter", COMMA, "--json"]);
    assert.equal(result.exitCode, 0);
    const state = JSON.parse(result.stdout) as BoardState;
    assert.deepEqual(board.ids(state), ["one", "two"]);
    assert.equal(state.itemCount, 12);
    assert.equal(board.items()[0].variables.filter, COMMA);
  });

  it("supports user-owned projects and hiding the No Status column", async (t) => {
    const board = await setup(t, { hideNoStatus: true });
    board.fixture.ownerKind = "user";
    board.fixture.pages[COMMA] = [
      [rawItem("unassigned", null), rawItem("assigned")],
    ];
    board.save();
    const state = await board.call("board_get", { filter: COMMA });
    assert.deepEqual(board.ids(state), ["assigned"]);
    assert.equal(state.board?.total, 1);
    assert.equal(state.itemCount, 12);
    assert.match(
      String(board.items()[0].variables.query),
      /user\(login: \$login\)/,
    );
  });
});
