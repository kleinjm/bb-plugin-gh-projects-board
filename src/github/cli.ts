// Thin wrapper over the `gh` CLI.
//
// The plugin never stores a token: it shells out to the user's signed-in `gh`
// session, the same way bb's own GitHub integrations do. That keeps credential
// handling in one audited place and means revoking `gh auth` revokes us too.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Output cap for a single `gh` invocation. A project page is far smaller. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** How long one `gh` call may run before we give up on it. */
const DEFAULT_TIMEOUT_MS = 60_000;

export class GhError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "GhError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/** `gh` is missing from PATH entirely. */
export class GhMissingError extends GhError {
  constructor() {
    super(
      "The GitHub CLI (gh) is not installed or not on PATH. See https://cli.github.com.",
      "",
      null,
    );
    this.name = "GhMissingError";
  }
}

/** `gh` is installed but has no usable credentials. */
export class GhAuthError extends GhError {
  constructor(stderr: string) {
    super("The GitHub CLI is not signed in. Run `gh auth login`.", stderr, 1);
    this.name = "GhAuthError";
  }
}

/**
 * The token works but lacks the Projects scope.
 *
 * Fine-grained tokens cannot read user-owned projects at all, and only expose
 * org projects under some org configurations, so the remedy we suggest is a
 * classic token with `read:project`.
 */
export class GhProjectScopeError extends GhError {
  constructor(stderr: string) {
    super(
      "This GitHub token cannot read Projects. Use a classic token with the " +
        "`read:project` scope (fine-grained tokens cannot read user-owned " +
        "projects, and reach org projects only in some configurations).",
      stderr,
      1,
    );
    this.name = "GhProjectScopeError";
  }
}

function classify(error: unknown): GhError {
  const candidate = error as NodeJS.ErrnoException & {
    stderr?: string;
    code?: string | number;
  };
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr : "";

  if (candidate.code === "ENOENT") return new GhMissingError();
  if (/not logged|no accounts|authentication token/i.test(stderr)) {
    return new GhAuthError(stderr);
  }
  if (/resource not accessible|insufficient scope|read:project/i.test(stderr)) {
    return new GhProjectScopeError(stderr);
  }

  const exitCode = typeof candidate.code === "number" ? candidate.code : null;
  return new GhError(
    stderr.trim() === "" ? String(candidate.message ?? error) : stderr.trim(),
    stderr,
    exitCode,
  );
}

export interface GhRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run `gh` with the given argv and return stdout. */
export async function runGh(
  args: readonly string[],
  options: GhRunOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [...args], {
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
      // Keep the child's environment: it carries GH_TOKEN/GITHUB_TOKEN and the
      // gh config path that the user's session depends on.
      env: process.env,
    });
    return stdout;
  } catch (error) {
    throw classify(error);
  }
}

/**
 * Run a GraphQL query and return the raw `data` object.
 *
 * Variables are passed with `-F` so `gh` sends them as typed JSON rather than
 * interpolating them into the query text. Nothing user-supplied is ever
 * concatenated into a query string.
 */
export async function graphql(
  query: string,
  variables: Readonly<Record<string, string | number | boolean | null>> = {},
  options: GhRunOptions = {},
): Promise<unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === null) continue;
    // -F gives us typed values (numbers stay numbers); -f would stringify.
    args.push("-F", `${key}=${String(value)}`);
  }

  const stdout = await runGh(args, options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GhError("GitHub returned a response that was not JSON.", stdout, null);
  }

  const envelope = parsed as { data?: unknown; errors?: unknown };
  if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
    const text = JSON.stringify(envelope.errors);
    if (/resource not accessible|insufficient scope/i.test(text)) {
      throw new GhProjectScopeError(text);
    }
    throw new GhError(`GitHub GraphQL error: ${text}`, text, null);
  }
  if (envelope.data === undefined) {
    throw new GhError("GitHub GraphQL response had no data.", stdout, null);
  }
  return envelope.data;
}

/** Whether `gh` is present and signed in. Used for the setup message. */
export async function checkAuth(
  options: GhRunOptions = {},
): Promise<{ ok: true; login: string } | { ok: false; reason: string }> {
  try {
    const stdout = await runGh(
      ["api", "user", "--jq", ".login"],
      options,
    );
    const login = stdout.trim();
    if (login === "") return { ok: false, reason: "gh returned no user login." };
    return { ok: true, login };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
