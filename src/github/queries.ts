// GraphQL documents for Projects v2.
//
// Projects live under either `organization` or `user`, with otherwise identical
// shapes, so each document is generated for a given owner kind rather than
// duplicated by hand.

export type OwnerKind = "organization" | "user";

/** Which single-select field drives the columns, plus its option order. */
export function projectFieldsQuery(owner: OwnerKind): string {
  return `
query($login: String!, $number: Int!) {
  ${owner}(login: $login) {
    projectV2(number: $number) {
      id
      title
      number
      url
      closed
      shortDescription
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name description color }
          }
        }
      }
    }
  }
}`;
}

/** One page of project items with everything a card needs. */
export function projectItemsQuery(owner: OwnerKind): string {
  return `
query($login: String!, $number: Int!, $first: Int!, $cursor: String) {
  ${owner}(login: $login) {
    projectV2(number: $number) {
      items(first: $first, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          type
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                optionId
                field { ... on ProjectV2FieldCommon { id name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2FieldCommon { id name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { id name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2FieldCommon { id name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                startDate
                field { ... on ProjectV2FieldCommon { id name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              id number title url state stateReason createdAt updatedAt
              repository { nameWithOwner }
              author { login }
              assignees(first: 10) { nodes { login avatarUrl } }
              labels(first: 20) { nodes { name color } }
              milestone { title }
              issueType { name }
            }
            ... on PullRequest {
              id number title url state isDraft createdAt updatedAt
              repository { nameWithOwner }
              author { login }
              assignees(first: 10) { nodes { login avatarUrl } }
              labels(first: 20) { nodes { name color } }
              milestone { title }
            }
            ... on DraftIssue {
              id title createdAt updatedAt
              creator { login }
              assignees(first: 10) { nodes { login avatarUrl } }
            }
          }
        }
      }
    }
  }
}`;
}

/** Projects an owner has, for the project picker. */
export function projectListQuery(owner: OwnerKind): string {
  return `
query($login: String!, $first: Int!) {
  ${owner}(login: $login) {
    projectsV2(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { id title number url closed shortDescription updatedAt }
    }
  }
}`;
}

/** The viewer's own login, used to resolve `@me` in filters. */
export const viewerQuery = `query { viewer { login } }`;
