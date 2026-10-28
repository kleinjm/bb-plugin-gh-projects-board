// Typed Projects v2 reads.
//
// Everything crossing the wire is parsed with zod at the boundary; the rest of
// the plugin only ever sees the narrowed types declared here.
import { z } from "zod";
import { graphql, type GhRunOptions } from "./cli.js";
import {
  projectFieldsQuery,
  projectItemsQuery,
  projectListQuery,
  viewerQuery,
  type OwnerKind,
} from "./queries.js";

/** GitHub caps project item pages at 100. */
const PAGE_SIZE = 100;

/** Refuse to spin forever if GitHub keeps handing back cursors. */
const MAX_PAGES = 100;

export const singleSelectOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  color: z.string().nullish(),
});
export type SingleSelectOption = z.infer<typeof singleSelectOptionSchema>;

const fieldSchema = z.object({
  __typename: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  options: z.array(singleSelectOptionSchema).optional(),
});

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  number: z.number().int(),
  url: z.string(),
  closed: z.boolean(),
  shortDescription: z.string().nullish(),
  fields: z.object({ nodes: z.array(fieldSchema.nullable()) }),
});

const labelSchema = z.object({ name: z.string(), color: z.string().nullish() });
const userSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().nullish(),
});

const contentSchema = z
  .object({
    __typename: z.string(),
    id: z.string().optional(),
    number: z.number().int().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    state: z.string().optional(),
    stateReason: z.string().nullish(),
    isDraft: z.boolean().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    repository: z.object({ nameWithOwner: z.string() }).nullish(),
    author: z.object({ login: z.string() }).nullish(),
    creator: z.object({ login: z.string() }).nullish(),
    assignees: z.object({ nodes: z.array(userSchema) }).nullish(),
    labels: z.object({ nodes: z.array(labelSchema) }).nullish(),
    milestone: z.object({ title: z.string() }).nullish(),
    issueType: z.object({ name: z.string() }).nullish(),
  })
  .nullable();

const fieldValueSchema = z.object({
  __typename: z.string(),
  name: z.string().optional(),
  optionId: z.string().optional(),
  text: z.string().optional(),
  number: z.number().optional(),
  date: z.string().optional(),
  title: z.string().optional(),
  startDate: z.string().optional(),
  field: z.object({ id: z.string().optional(), name: z.string().optional() }).nullish(),
});

const rawItemSchema = z.object({
  id: z.string(),
  isArchived: z.boolean(),
  type: z.string(),
  fieldValues: z.object({ nodes: z.array(fieldValueSchema.nullable()) }),
  content: contentSchema,
});

const itemsPageSchema = z.object({
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullish(),
  }),
  nodes: z.array(rawItemSchema.nullable()),
});

export const projectSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  number: z.number().int(),
  url: z.string(),
  closed: z.boolean(),
  shortDescription: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** A project item flattened into the shape a card renders from. */
export interface BoardItem {
  itemId: string;
  kind: "Issue" | "PullRequest" | "DraftIssue" | "Unknown";
  number: number | null;
  title: string;
  url: string | null;
  repository: string | null;
  /** `web #5777` — the identifier shown on GitHub's own cards. */
  reference: string | null;
  state: string | null;
  isDraft: boolean;
  author: string | null;
  assignees: { login: string; avatarUrl: string | null }[];
  labels: { name: string; color: string | null }[];
  milestone: string | null;
  issueType: string | null;
  updatedAt: string | null;
  /** Every single-select value by field name, e.g. `{ Status: "In Progress" }`. */
  singleSelect: Record<string, string>;
  /** Numeric field values by field name, e.g. `{ Priority: 1 }`. */
  numbers: Record<string, number>;
  /** Text, date and iteration values by field name. */
  text: Record<string, string>;
}

export interface ProjectBoard {
  id: string;
  title: string;
  number: number;
  url: string;
  closed: boolean;
  description: string | null;
  /** The field the columns come from, when the project has one. */
  statusField: { id: string; name: string; options: SingleSelectOption[] } | null;
  /** Every single-select field, so the UI can offer a different grouping. */
  singleSelectFields: { id: string; name: string; options: SingleSelectOption[] }[];
  items: BoardItem[];
}

export interface ProjectRef {
  ownerKind: OwnerKind;
  login: string;
  number: number;
}

/** Repository short name: `my-org/web` → `web`. */
function shortRepo(nameWithOwner: string | null): string | null {
  if (nameWithOwner === null) return null;
  const slash = nameWithOwner.lastIndexOf("/");
  return slash === -1 ? nameWithOwner : nameWithOwner.slice(slash + 1);
}

function toBoardItem(raw: z.infer<typeof rawItemSchema>): BoardItem {
  const content = raw.content;
  const singleSelect: Record<string, string> = {};
  const numbers: Record<string, number> = {};
  const text: Record<string, string> = {};

  for (const value of raw.fieldValues.nodes) {
    const fieldName = value?.field?.name;
    if (value === null || fieldName === undefined) continue;
    switch (value.__typename) {
      case "ProjectV2ItemFieldSingleSelectValue":
        if (value.name !== undefined) singleSelect[fieldName] = value.name;
        break;
      case "ProjectV2ItemFieldNumberValue":
        if (value.number !== undefined) numbers[fieldName] = value.number;
        break;
      case "ProjectV2ItemFieldTextValue":
        if (value.text !== undefined) text[fieldName] = value.text;
        break;
      case "ProjectV2ItemFieldDateValue":
        if (value.date !== undefined) text[fieldName] = value.date;
        break;
      case "ProjectV2ItemFieldIterationValue":
        if (value.title !== undefined) text[fieldName] = value.title;
        break;
      default:
        break;
    }
  }

  const kind =
    content?.__typename === "Issue" ||
    content?.__typename === "PullRequest" ||
    content?.__typename === "DraftIssue"
      ? content.__typename
      : "Unknown";
  const repository = shortRepo(content?.repository?.nameWithOwner ?? null);
  const number = content?.number ?? null;

  return {
    itemId: raw.id,
    kind,
    number,
    title: content?.title ?? "(untitled)",
    url: content?.url ?? null,
    repository,
    reference:
      repository !== null && number !== null ? `${repository} #${number}` : null,
    state: content?.state ?? null,
    isDraft: content?.isDraft ?? false,
    author: content?.author?.login ?? content?.creator?.login ?? null,
    assignees: (content?.assignees?.nodes ?? []).map((user) => ({
      login: user.login,
      avatarUrl: user.avatarUrl ?? null,
    })),
    labels: (content?.labels?.nodes ?? []).map((label) => ({
      name: label.name,
      color: label.color ?? null,
    })),
    milestone: content?.milestone?.title ?? null,
    issueType: content?.issueType?.name ?? null,
    updatedAt: content?.updatedAt ?? null,
    singleSelect,
    numbers,
    text,
  };
}

function unwrap(data: unknown, ownerKind: OwnerKind): unknown {
  const root = data as Record<string, unknown>;
  const owner = root[ownerKind];
  if (owner === null || owner === undefined) {
    throw new Error(
      `No ${ownerKind} by that login is visible to this token.`,
    );
  }
  return owner;
}

/** Read the project's metadata and its single-select fields. */
export async function fetchProjectFields(
  ref: ProjectRef,
  options: GhRunOptions = {},
): Promise<Omit<ProjectBoard, "items">> {
  const data = await graphql(
    projectFieldsQuery(ref.ownerKind),
    { login: ref.login, number: ref.number },
    options,
  );
  const owner = unwrap(data, ref.ownerKind) as { projectV2?: unknown };
  if (owner.projectV2 === null || owner.projectV2 === undefined) {
    throw new Error(
      `${ref.login} has no project number ${ref.number}, or this token cannot see it.`,
    );
  }

  const project = projectSchema.parse(owner.projectV2);
  const singleSelectFields = project.fields.nodes.flatMap((field) => {
    if (field === null) return [];
    if (field.__typename !== "ProjectV2SingleSelectField") return [];
    if (field.id === undefined || field.name === undefined) return [];
    return [{ id: field.id, name: field.name, options: field.options ?? [] }];
  });

  // GitHub's boards group by Status by default; fall back to the first
  // single-select field for projects that renamed or removed it.
  const statusField =
    singleSelectFields.find((field) => field.name === "Status") ??
    singleSelectFields[0] ??
    null;

  return {
    id: project.id,
    title: project.title,
    number: project.number,
    url: project.url,
    closed: project.closed,
    description: project.shortDescription ?? null,
    statusField,
    singleSelectFields,
  };
}

/**
 * Read every item in the project, following cursors.
 *
 * A board of a few thousand items is a handful of sequential requests; there is
 * no way to filter server-side on a Projects v2 field, so filtering happens
 * once the items are in hand.
 */
export async function fetchProjectItems(
  ref: ProjectRef,
  options: GhRunOptions = {},
): Promise<BoardItem[]> {
  const items: BoardItem[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    options.signal?.throwIfAborted();

    const data: unknown = await graphql(
      projectItemsQuery(ref.ownerKind),
      { login: ref.login, number: ref.number, first: PAGE_SIZE, cursor },
      options,
    );
    const owner = unwrap(data, ref.ownerKind) as { projectV2?: { items?: unknown } };
    const parsed = itemsPageSchema.parse(owner.projectV2?.items);

    for (const node of parsed.nodes) {
      if (node === null || node.isArchived) continue;
      items.push(toBoardItem(node));
    }

    if (!parsed.pageInfo.hasNextPage) return items;
    cursor = parsed.pageInfo.endCursor ?? null;
    if (cursor === null) return items;
  }

  throw new Error(
    `Stopped after ${MAX_PAGES} pages; this project is larger than the plugin expects.`,
  );
}

/** Fields and items together. */
export async function fetchProjectBoard(
  ref: ProjectRef,
  options: GhRunOptions = {},
): Promise<ProjectBoard> {
  const fields = await fetchProjectFields(ref, options);
  const items = await fetchProjectItems(ref, options);
  return { ...fields, items };
}

/** Projects belonging to an owner, newest first. */
export async function listProjects(
  ownerKind: OwnerKind,
  login: string,
  options: GhRunOptions = {},
): Promise<ProjectSummary[]> {
  const data = await graphql(
    projectListQuery(ownerKind),
    { login, first: 50 },
    options,
  );
  const owner = unwrap(data, ownerKind) as { projectsV2?: { nodes?: unknown } };
  const nodes = z
    .array(projectSummarySchema.nullable())
    .parse(owner.projectsV2?.nodes ?? []);
  return nodes.filter((node): node is ProjectSummary => node !== null);
}

/** The signed-in login, for resolving `@me`. */
export async function fetchViewerLogin(
  options: GhRunOptions = {},
): Promise<string> {
  const data = await graphql(viewerQuery, {}, options);
  return z
    .object({ viewer: z.object({ login: z.string() }) })
    .parse(data).viewer.login;
}

/**
 * Resolve an owner login to the kind of account it is.
 *
 * Projects hang off `organization` or `user` and the query differs, so this is
 * tried once and cached by the caller.
 */
export async function resolveOwnerKind(
  login: string,
  options: GhRunOptions = {},
): Promise<OwnerKind> {
  const data = await graphql(
    `query($login: String!) {
       repositoryOwner(login: $login) { __typename }
     }`,
    { login },
    options,
  );
  const parsed = z
    .object({
      repositoryOwner: z.object({ __typename: z.string() }).nullable(),
    })
    .parse(data);
  if (parsed.repositoryOwner === null) {
    throw new Error(`No GitHub account named ${login} is visible to this token.`);
  }
  return parsed.repositoryOwner.__typename === "Organization"
    ? "organization"
    : "user";
}
