// Grouping the items returned by GitHub.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBoard, NO_STATUS } from "../src/board.js";
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
    itemCount: items.length,
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
