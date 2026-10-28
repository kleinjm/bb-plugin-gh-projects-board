// The one rule both sides of the RPC have to agree on.
//
// An empty filter string is meaningful: it asks for every item. So "no filter
// supplied" and "a filter that selects everything" cannot be the same value on
// the wire, and the distinction has to survive the round trip.
//
// Getting this wrong once already shipped a bug: the page sent `filter: ""` on
// first load, the server treated it as a real filter, and the My Tasks toggle
// silently showed all 1,466 items instead of the viewer's 13.

/** What the client sends when it has not chosen a filter yet. */
export const NO_FILTER_CHOSEN = null;

/**
 * Decide which filter the server should apply.
 *
 * `undefined` or `null` means the caller expressed no preference, so the
 * configured default wins. An empty string is a deliberate "show everything"
 * and must not fall back.
 */
export function resolveFilter(
  requested: string | null | undefined,
  configuredDefault: string,
): string {
  return requested === undefined || requested === null
    ? configuredDefault
    : requested;
}

/**
 * Build the filter part of an RPC payload.
 *
 * Omits the key entirely when no filter is chosen, so the server sees
 * `undefined` rather than `""` and applies its configured default.
 */
export function filterPayload(
  filter: string | null,
): { filter?: string } {
  return filter === NO_FILTER_CHOSEN ? {} : { filter };
}
