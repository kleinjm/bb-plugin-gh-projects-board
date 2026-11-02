// Group GitHub's already-filtered project items into columns.
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

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export interface BuildBoardOptions {
  /** Field to group by; defaults to the project's status field. */
  groupBy?: string;
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
  const includeEmpty = options.includeEmptyColumns ?? true;

  const field =
    options.groupBy === undefined
      ? project.statusField
      : project.singleSelectFields.find((candidate) =>
          equalsIgnoreCase(candidate.name, options.groupBy as string),
        ) ?? null;

  const matching = project.items;

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
