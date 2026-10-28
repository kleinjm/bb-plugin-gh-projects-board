// The filter parser and column grouping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBoard, itemMatches, parseFilter, NO_STATUS } from "../src/board.js";
import type { BoardItem, ProjectBoard } from "../src/github/projects.js";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    itemId: overrides.itemId ?? "i1",
    kind: "Issue",
    number: 1,
    title: "A title",
    url: null,
    repository: "web",
    reference: "web #1",
    state: "OPEN",
    isDraft: false,
    author: "someone",
    assignees: [],
    labels: [],
    milestone: null,
    issueType: null,
    updatedAt: null,
    singleSelect: {},
    numbers: {},
    text: {},
    ...overrides,
  };
}

const ME = "kleinjm";
const mine = [{ login: ME, avatarUrl: null }];

describe("parseFilter", () => {
  it("reads key:value terms", () => {
    const parsed = parseFilter("assignee:kleinjm status:QA");
    assert.deepEqual(parsed.terms, [
      { key: "assignee", value: "kleinjm", negated: false },
      { key: "status", value: "QA", negated: false },
    ]);
    assert.deepEqual(parsed.words, []);
  });

  it("reads a leading - as negation", () => {
    assert.deepEqual(parseFilter("-status:Done!").terms, [
      { key: "status", value: "Done!", negated: true },
    ]);
  });

  it("keeps quoted values whole", () => {
    assert.deepEqual(parseFilter('iteration:"Sprint 4"').terms, [
      { key: "iteration", value: "Sprint 4", negated: false },
    ]);
    assert.deepEqual(parseFilter("label:'needs design'").terms, [
      { key: "label", value: "needs design", negated: false },
    ]);
  });

  it("lowercases keys but preserves value case", () => {
    assert.deepEqual(parseFilter("Status:In Progress").terms[0], {
      key: "status",
      value: "In",
      negated: false,
    });
  });

  it("collects bare words for title matching", () => {
    const parsed = parseFilter("memory leak status:QA");
    assert.deepEqual(parsed.words, ["memory", "leak"]);
    assert.equal(parsed.terms.length, 1);
  });

  it("parses the saved view this plugin opens on", () => {
    const parsed = parseFilter("assignee:@me -status:Done!");
    assert.deepEqual(parsed.terms, [
      { key: "assignee", value: "@me", negated: false },
      { key: "status", value: "Done!", negated: true },
    ]);
  });

  it("returns nothing for an empty filter", () => {
    assert.deepEqual(parseFilter(""), { terms: [], words: [] });
  });
});

describe("itemMatches", () => {
  const match = (filter: string, candidate: BoardItem) =>
    itemMatches(candidate, parseFilter(filter), ME);

  it("resolves @me to the signed-in login", () => {
    assert.equal(match("assignee:@me", item({ assignees: mine })), true);
    assert.equal(
      match("assignee:@me", item({ assignees: [{ login: "other", avatarUrl: null }] })),
      false,
    );
  });

  it("matches a project field by name, ignoring case", () => {
    const candidate = item({ singleSelect: { Status: "In Progress" } });
    assert.equal(match("status:In Progress", candidate), false, "value is not quoted");
    assert.equal(match('status:"In Progress"', candidate), true);
    assert.equal(match('STATUS:"in progress"', candidate), true);
  });

  it("excludes on a negated term", () => {
    const done = item({ assignees: mine, singleSelect: { Status: "Done!" } });
    const todo = item({ assignees: mine, singleSelect: { Status: "Todo" } });
    assert.equal(match("assignee:@me -status:Done!", done), false);
    assert.equal(match("assignee:@me -status:Done!", todo), true);
  });

  it("treats an item with no value for a field as not matching it", () => {
    const none = item({ assignees: mine });
    assert.equal(match("status:Todo", none), false);
    // …and therefore as surviving the negation, which is what puts unstatused
    // items on a `-status:Done!` board.
    assert.equal(match("-status:Done!", none), true);
  });

  it("matches an unknown key against nothing, so a typo is visible", () => {
    assert.equal(match("assigne:@me", item({ assignees: mine })), false);
  });

  it("matches bare words against the title, case-insensitively", () => {
    const candidate = item({ title: "Production memory growth" });
    assert.equal(match("MEMORY", candidate), true);
    assert.equal(match("memory growth", candidate), true);
    assert.equal(match("memory absent", candidate), false);
  });

  it("matches labels and repository", () => {
    const candidate = item({
      labels: [{ name: "bug", color: null }],
      repository: "web",
    });
    assert.equal(match("label:bug repo:web", candidate), true);
    assert.equal(match("label:chore", candidate), false);
  });

  it("matches everything when the filter is empty", () => {
    assert.equal(match("", item()), true);
  });
});

function project(items: BoardItem[]): ProjectBoard {
  const field = {
    id: "f",
    name: "Status",
    options: [
      { id: "o1", name: "Todo", description: "Not started" },
      { id: "o2", name: "In Progress", description: "" },
      { id: "o3", name: "Done!", description: null },
    ],
  };
  return {
    id: "p",
    title: "Web",
    number: 1,
    url: "https://example.invalid",
    closed: false,
    description: null,
    statusField: field,
    singleSelectFields: [field],
    items,
  };
}

describe("buildBoard", () => {
  it("orders columns by the project's option order, not alphabetically", () => {
    const board = buildBoard(
      project([
        item({ itemId: "a", singleSelect: { Status: "Done!" } }),
        item({ itemId: "b", singleSelect: { Status: "Todo" } }),
      ]),
      { includeEmptyColumns: true },
    );
    assert.deepEqual(
      board.columns.map((column) => column.name),
      [NO_STATUS, "Todo", "In Progress", "Done!"],
    );
  });

  it("collects items with no status into a No Status column", () => {
    const board = buildBoard(
      project([item({ itemId: "a" }), item({ itemId: "b", singleSelect: { Status: "Todo" } })]),
      { includeEmptyColumns: false },
    );
    const noStatus = board.columns.find((column) => column.name === NO_STATUS);
    assert.equal(noStatus?.items.length, 1);
    assert.equal(board.total, 2);
  });

  it("drops empty columns when asked", () => {
    const board = buildBoard(
      project([item({ itemId: "a", singleSelect: { Status: "Todo" } })]),
      { includeEmptyColumns: false },
    );
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["Todo"],
    );
  });

  it("carries an option's description and normalizes an empty one to null", () => {
    const board = buildBoard(
      project([
        item({ itemId: "a", singleSelect: { Status: "Todo" } }),
        item({ itemId: "b", singleSelect: { Status: "In Progress" } }),
      ]),
      { includeEmptyColumns: false },
    );
    const todo = board.columns.find((column) => column.name === "Todo");
    const doing = board.columns.find((column) => column.name === "In Progress");
    assert.equal(todo?.description, "Not started");
    assert.equal(doing?.description, null, "an empty description becomes null");
  });

  it("keeps items whose option was removed from the field", () => {
    const board = buildBoard(
      project([item({ itemId: "a", singleSelect: { Status: "Retired" } })]),
      { includeEmptyColumns: false },
    );
    const retired = board.columns.find((column) => column.name === "Retired");
    assert.equal(retired?.items.length, 1);
  });

  it("applies the filter before grouping", () => {
    const board = buildBoard(
      project([
        item({ itemId: "a", assignees: mine, singleSelect: { Status: "Todo" } }),
        item({ itemId: "b", singleSelect: { Status: "Todo" } }),
      ]),
      { filter: "assignee:@me", viewerLogin: ME, includeEmptyColumns: false },
    );
    assert.equal(board.total, 1);
    assert.equal(board.columns[0].items[0].itemId, "a");
  });

  it("falls back to a single column when the project has no select field", () => {
    const bare = { ...project([item()]), statusField: null, singleSelectFields: [] };
    const board = buildBoard(bare, { includeEmptyColumns: false });
    assert.equal(board.groupedBy, null);
    assert.deepEqual(
      board.columns.map((column) => column.name),
      ["All items"],
    );
  });
});
