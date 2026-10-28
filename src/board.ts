// Turning project items into columns, and the filter syntax that selects them.
import type { BoardItem, ProjectBoard, SingleSelectOption } from "./github/projects.js";

/** Items with no value for the grouping field land here, as they do on GitHub. */
export const NO_STATUS = "No Status";

export interface BoardColumn {
  /** Option name, or `No Status`. */
  name: string;
  /** The option's own description, shown under the column heading. */
  description: string | null;
  color: string | null;
  items: BoardItem[];
}

export interface BuiltBoard {
  title: string;
  url: string;
  groupedBy: string | null;
  columns: BoardColumn[];
  /** Items matching the filter, across all columns. */
  total: number;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface FilterTerm {
  key: string;
  value: string;
  negated: boolean;
}

export interface ParsedFilter {
  terms: FilterTerm[];
  /** Bare words, matched against the title. */
  words: string[];
}

/**
 * Parse GitHub's project filter syntax.
 *
 * Supports `key:value`, `-key:value` for negation, quoted values, and bare
 * words. This is the subset their own views use — `assignee:@me -status:Done!`
 * is the motivating case.
 */
export function parseFilter(input: string): ParsedFilter {
  const terms: FilterTerm[] = [];
  const words: string[] = [];
  // key:value, -key:value, "quoted value", or a bare word.
  const pattern = /(-?)([A-Za-z_][\w-]*):("[^"]*"|'[^']*'|[^\s]+)|("[^"]*"|'[^']*'|\S+)/g;

  for (const match of input.matchAll(pattern)) {
    const [, negated, key, rawValue, bare] = match;
    if (key !== undefined && rawValue !== undefined) {
      terms.push({
        key: key.toLowerCase(),
        value: unquote(rawValue),
        negated: negated === "-",
      });
    } else if (bare !== undefined) {
      const word = unquote(bare).trim();
      if (word !== "") words.push(word.toLowerCase());
    }
  }

  return { terms, words };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

/** Values a single term can be checked against, by key. */
function valuesForKey(
  item: BoardItem,
  key: string,
  viewerLogin: string | null,
): string[] | null {
  switch (key) {
    case "assignee":
      return item.assignees.map((assignee) => assignee.login);
    case "author":
      return item.author === null ? [] : [item.author];
    case "label":
    case "labels":
      return item.labels.map((label) => label.name);
    case "repo":
    case "repository":
      return item.repository === null ? [] : [item.repository];
    case "milestone":
      return item.milestone === null ? [] : [item.milestone];
    case "type":
      return item.issueType === null ? [] : [item.issueType];
    case "state":
      return item.state === null ? [] : [item.state];
    case "is":
      return [
        item.kind === "PullRequest" ? "pr" : "issue",
        ...(item.isDraft ? ["draft"] : []),
        ...(item.state !== null ? [item.state.toLowerCase()] : []),
      ];
    default: {
      // Any project field, matched case-insensitively by name: `status:Todo`,
      // `priority:P1`, `iteration:"Sprint 4"`.
      const fieldName = Object.keys(item.singleSelect).find((name) =>
        equalsIgnoreCase(name, key),
      );
      if (fieldName !== undefined) return [item.singleSelect[fieldName]];

      const textName = Object.keys(item.text).find((name) =>
        equalsIgnoreCase(name, key),
      );
      if (textName !== undefined) return [item.text[textName]];

      const numberName = Object.keys(item.numbers).find((name) =>
        equalsIgnoreCase(name, key),
      );
      if (numberName !== undefined) return [String(item.numbers[numberName])];

      return null;
    }
  }
}

function termMatches(
  item: BoardItem,
  term: FilterTerm,
  viewerLogin: string | null,
): boolean {
  const target =
    term.value === "@me" && viewerLogin !== null ? viewerLogin : term.value;
  const values = valuesForKey(item, term.key, viewerLogin);

  // An unknown key matches nothing rather than everything, so a typo shows an
  // empty board instead of silently ignoring the filter.
  if (values === null) return false;

  // `no:assignee` / `has:label` style checks.
  if (term.key === "no") {
    const inner = valuesForKey(item, term.value, viewerLogin);
    return inner !== null && inner.length === 0;
  }

  if (target === "*") return values.length > 0;
  return values.some((value) => equalsIgnoreCase(value, target));
}

/** Apply a parsed filter to one item. */
export function itemMatches(
  item: BoardItem,
  filter: ParsedFilter,
  viewerLogin: string | null,
): boolean {
  for (const term of filter.terms) {
    if (term.key === "no") {
      const inner = valuesForKey(item, term.value, viewerLogin);
      const empty = inner !== null && inner.length === 0;
      if (term.negated ? empty : !empty) return false;
      continue;
    }
    const matched = termMatches(item, term, viewerLogin);
    if (term.negated ? matched : !matched) return false;
  }

  if (filter.words.length > 0) {
    const haystack = item.title.toLowerCase();
    if (!filter.words.every((word) => haystack.includes(word))) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface BuildBoardOptions {
  /** Field to group by; defaults to the project's status field. */
  groupBy?: string;
  /** GitHub-style filter string. */
  filter?: string;
  /** Resolves `@me`. */
  viewerLogin?: string | null;
  /** Keep the empty `No Status` column. GitHub shows it; a filtered view rarely wants it. */
  includeEmptyColumns?: boolean;
}

/**
 * Group items into columns in the project's own option order.
 *
 * The option order comes from the project definition, so columns appear exactly
 * as they do on GitHub rather than alphabetically or by first appearance.
 */
export function buildBoard(
  project: ProjectBoard,
  options: BuildBoardOptions = {},
): BuiltBoard {
  const viewerLogin = options.viewerLogin ?? null;
  const filter = parseFilter(options.filter ?? "");
  const includeEmpty = options.includeEmptyColumns ?? true;

  const field =
    options.groupBy === undefined
      ? project.statusField
      : project.singleSelectFields.find((candidate) =>
          equalsIgnoreCase(candidate.name, options.groupBy as string),
        ) ?? null;

  const matching = project.items.filter((item) =>
    itemMatches(item, filter, viewerLogin),
  );

  if (field === null) {
    return {
      title: project.title,
      url: project.url,
      groupedBy: null,
      columns: [
        { name: "All items", description: null, color: null, items: matching },
      ],
      total: matching.length,
    };
  }

  const byOption = new Map<string, BoardItem[]>();
  const noValue: BoardItem[] = [];
  for (const option of field.options) byOption.set(option.name, []);

  for (const item of matching) {
    const value = item.singleSelect[field.name];
    if (value === undefined) {
      noValue.push(item);
      continue;
    }
    const bucket = byOption.get(value);
    if (bucket === undefined) {
      // An option removed from the field after items were assigned to it.
      byOption.set(value, [item]);
      continue;
    }
    bucket.push(item);
  }

  const describe = (name: string): SingleSelectOption | undefined =>
    field.options.find((option) => option.name === name);

  const columns: BoardColumn[] = [];
  if (noValue.length > 0 || includeEmpty) {
    columns.push({
      name: NO_STATUS,
      description: null,
      color: null,
      items: noValue,
    });
  }
  for (const [name, items] of byOption) {
    if (items.length === 0 && !includeEmpty) continue;
    const option = describe(name);
    const description = option?.description ?? null;
    columns.push({
      name,
      // GitHub returns "" for an option with no description; normalize so
      // callers only ever test for null.
      description: description === null || description.trim() === "" ? null : description,
      color: option?.color ?? null,
      items,
    });
  }

  return {
    title: project.title,
    url: project.url,
    groupedBy: field.name,
    columns,
    total: matching.length,
  };
}
