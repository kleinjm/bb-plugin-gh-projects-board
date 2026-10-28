// The omitted-vs-empty rule, from both ends of the RPC.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterPayload,
  resolveFilter,
  NO_FILTER_CHOSEN,
} from "../src/filter-contract.js";

const MINE = "assignee:@me -status:Done!";

describe("resolveFilter", () => {
  it("applies the configured default when no filter is supplied", () => {
    assert.equal(resolveFilter(undefined, MINE), MINE);
    assert.equal(resolveFilter(null, MINE), MINE);
  });

  it("treats an empty string as a deliberate 'show everything'", () => {
    // The regression: falling back here made My Tasks show every item.
    assert.equal(resolveFilter("", MINE), "");
  });

  it("passes any other filter through untouched", () => {
    assert.equal(resolveFilter("status:QA", MINE), "status:QA");
    assert.equal(resolveFilter("   ", MINE), "   ");
  });

  it("does not invent a filter when none is configured", () => {
    assert.equal(resolveFilter(undefined, ""), "");
  });
});

describe("filterPayload", () => {
  it("omits the key entirely when no filter is chosen", () => {
    const payload = filterPayload(NO_FILTER_CHOSEN);
    assert.deepEqual(payload, {});
    // Presence is what the server branches on, not the value.
    assert.equal("filter" in payload, false);
  });

  it("sends an empty string when 'everything' is chosen", () => {
    const payload = filterPayload("");
    assert.equal("filter" in payload, true);
    assert.equal(payload.filter, "");
  });

  it("sends a chosen filter", () => {
    assert.deepEqual(filterPayload(MINE), { filter: MINE });
  });
});

describe("the round trip the bug broke", () => {
  it("an unchosen filter reaches the server as the configured default", () => {
    const sent = filterPayload(NO_FILTER_CHOSEN);
    assert.equal(resolveFilter(sent.filter, MINE), MINE);
  });

  it("'All items' survives as an empty filter rather than reverting", () => {
    const sent = filterPayload("");
    assert.equal(resolveFilter(sent.filter, MINE), "");
  });
});
