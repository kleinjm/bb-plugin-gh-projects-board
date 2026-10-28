// bb-plugin-gh-projects-board — frontend entry.
//
// A column-per-status board, laid out like GitHub's own: each column carries
// its option name, item count and the option's description, and each card shows
// the `repo #number` reference, title, labels and assignees.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { UrlLink, definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardColumnView, BoardItemView, BoardState, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { filterPayload } from "./src/filter-contract";

/** GitHub's single-select colors, mapped onto theme-friendly dot classes. */
const COLUMN_DOT: Record<string, string> = {
  GRAY: "bg-muted-foreground",
  BLUE: "bg-blue-500",
  GREEN: "bg-green-500",
  YELLOW: "bg-yellow-500",
  ORANGE: "bg-orange-500",
  RED: "bg-red-500",
  PINK: "bg-pink-500",
  PURPLE: "bg-purple-500",
};

/** A GitHub label color is a bare hex string; render it as a tinted chip. */
function labelStyle(color: string | null): React.CSSProperties | undefined {
  if (color === null || !/^[0-9a-f]{6}$/i.test(color)) return undefined;
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  return {
    backgroundColor: `rgb(${red} ${green} ${blue} / 0.16)`,
    color: `rgb(${red} ${green} ${blue})`,
    borderColor: `rgb(${red} ${green} ${blue} / 0.35)`,
  };
}

function useBoard(filter: string | null, groupBy: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Avoid a slow response from an earlier query overwriting a newer one.
  const requestId = useRef(0);

  const load = useCallback(
    (refresh: boolean) => {
      const id = requestId.current + 1;
      requestId.current = id;
      setBusy(true);
      const call = refresh ? "board_refresh" : "board_get";
      // filterPayload omits the key until a filter is chosen: an empty string
      // is a valid filter meaning "everything", so sending it would suppress
      // the configured default instead of asking for it.
      rpc.call(call, { ...filterPayload(filter), groupBy }).then(
        (result) => {
          if (requestId.current !== id) return;
          setState(result);
          setError(null);
          setBusy(false);
        },
        (cause: unknown) => {
          if (requestId.current !== id) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
        },
      );
    },
    [rpc, filter, groupBy],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // The background refresh publishes after every successful read.
  useRealtime("board-changed", () => load(false));

  return { state, error, busy, reload: load };
}

function CardBody({ item }: { item: BoardItemView }) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon
          name={item.kind === "PullRequest" ? "GitBranch" : "Info"}
          className={cn(
            "size-3.5 shrink-0",
            item.state === "CLOSED" || item.state === "MERGED"
              ? "text-purple-500"
              : "text-green-600",
          )}
        />
        <span className="truncate font-mono">{item.reference ?? item.kind}</span>
      </div>
      <p className="mt-1 text-sm leading-snug text-foreground">{item.title}</p>
      {item.labels.length === 0 ? null : (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.labels.map((label) => (
            <span
              key={label.name}
              style={labelStyle(label.color)}
              className="rounded-full border px-2 py-0.5 text-[11px] leading-4"
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
      {item.assignees.length === 0 ? null : (
        <div className="mt-2 flex items-center gap-1">
          {item.assignees.map((assignee) =>
            assignee.avatarUrl === null ? (
              <span
                key={assignee.login}
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {assignee.login}
              </span>
            ) : (
              <img
                key={assignee.login}
                src={assignee.avatarUrl}
                alt={assignee.login}
                title={assignee.login}
                className="size-5 rounded-full border border-border"
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

function Card({ item }: { item: BoardItemView }) {
  const className = cn(
    "block rounded-lg border border-border bg-card px-3 py-2.5 text-left",
    item.url !== null &&
      "cursor-pointer no-underline hover:border-muted-foreground/40",
  );
  // UrlLink hands ordinary activation to the host, so a card opens in BB's
  // own browser; it stays a real anchor, so cmd-click, middle-click and
  // "copy link" keep working.
  return (
    <li>
      {item.url === null ? (
        <div className={className}>
          <CardBody item={item} />
        </div>
      ) : (
        <UrlLink href={item.url} className={className}>
          <CardBody item={item} />
        </UrlLink>
      )}
    </li>
  );
}

function Column({ column }: { column: BoardColumnView }) {
  return (
    <section className="flex w-[22rem] shrink-0 flex-col">
      <header className="sticky top-0 z-10 bg-background pb-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2.5 rounded-full",
              COLUMN_DOT[String(column.color ?? "GRAY").toUpperCase()] ??
                "bg-muted-foreground",
            )}
          />
          <h2 className="text-sm font-medium text-foreground">{column.name}</h2>
          <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
            {column.items.length}
          </span>
        </div>
        {column.description === null ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{column.description}</p>
        )}
      </header>
      <ul className="flex flex-col gap-2">
        {column.items.map((item) => (
          <Card key={item.itemId} item={item} />
        ))}
      </ul>
    </section>
  );
}

function Notice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "bad";
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed px-4 py-6 text-center text-sm",
        tone === "bad"
          ? "border-destructive/40 text-destructive"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

/** Quick filters offered above the board. "mine" is the configured default. */
type QuickFilter = "mine" | "all" | "custom";

function BoardPage() {
  const [filterInput, setFilterInput] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  // My Tasks is what the page opens on; the server supplies its query.
  const [quick, setQuick] = useState<QuickFilter>("mine");
  const [myTasksFilter, setMyTasksFilter] = useState<string | null>(null);
  const { state, error, busy, reload } = useBoard(filter, groupBy);

  // The first response carries the configured default filter. Adopt it as the
  // My Tasks query and apply it, so the page opens on My Tasks rather than on
  // an empty box.
  useEffect(() => {
    if (myTasksFilter === null && state !== null) {
      // state.filter is the query the server actually applied, which on the
      // first call is the configured default.
      setMyTasksFilter(state.filter);
      setFilterInput(state.filter);
      setFilter(state.filter);
    }
  }, [myTasksFilter, state]);

  const selectQuick = (next: Exclude<QuickFilter, "custom">) => {
    // Before the first response myTasksFilter is unknown; null asks the server
    // for its configured default rather than falling back to "everything".
    const query = next === "mine" ? myTasksFilter : "";
    setQuick(next);
    setFilterInput(query ?? "");
    setFilter(query);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = filterInput ?? "";
    setFilter(next);
    // Typing the My Tasks query by hand should still light up its toggle.
    setQuick(
      next === (myTasksFilter ?? "") ? "mine" : next === "" ? "all" : "custom",
    );
  };

  const fetchedAt = useMemo(() => {
    if (state?.fetchedAt == null) return null;
    const when = new Date(state.fetchedAt);
    return Number.isNaN(when.getTime()) ? null : when.toLocaleTimeString();
  }, [state?.fetchedAt]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3 md:px-5">
        <div className="mb-2 flex items-center gap-1">
          <div
            role="tablist"
            aria-label="Quick filters"
            className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={quick === "mine"}
              onClick={() => selectQuick("mine")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                quick === "mine"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              My Tasks
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={quick === "all"}
              onClick={() => selectQuick("all")}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs transition-colors",
                quick === "all"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              All items
            </button>
          </div>
          {quick === "custom" ? (
            <span className="text-xs text-muted-foreground">Custom filter</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-2">
            <Input
              value={filterInput ?? ""}
              onChange={(event) => setFilterInput(event.target.value)}
              placeholder="assignee:@me -status:Done!"
              aria-label="Filter"
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" variant="secondary" disabled={busy}>
              <Icon name="Search" className="size-4" />
              Filter
            </Button>
          </form>
          {state?.groupableFields.length ? (
            <select
              value={groupBy ?? ""}
              onChange={(event) => setGroupBy(event.target.value || null)}
              aria-label="Group by"
              className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            >
              <option value="">Group: default</option>
              {state.groupableFields.map((field) => (
                <option key={field} value={field}>
                  Group: {field}
                </option>
              ))}
            </select>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => reload(true)}
            disabled={busy}
            aria-label="Refresh from GitHub"
          >
            <Icon name="Download" className={cn("size-4", busy && "animate-pulse")} />
            Refresh
          </Button>
        </div>
        {state?.board == null ? null : (
          <p className="mt-2 text-xs text-muted-foreground">
            <UrlLink
              href={state.board.url}
              className="underline underline-offset-2"
            >
              {state.board.title}
            </UrlLink>{" "}
            · {state.board.total} of {state.itemCount} items · grouped by{" "}
            {state.board.groupedBy ?? "nothing"}
            {fetchedAt === null ? null : ` · read ${fetchedAt}`}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 md:px-5">
        {error !== null ? (
          <Notice tone="bad">{error}</Notice>
        ) : state === null ? (
          <Notice>Loading the board…</Notice>
        ) : state.problem !== null ? (
          <Notice tone={state.scopeProblem ? "bad" : "muted"}>
            <p>{state.problem}</p>
            {state.scopeProblem ? (
              <p className="mt-2 text-xs">
                Create a classic token with the <code>read:project</code> scope and
                sign <code>gh</code> in with it.
              </p>
            ) : null}
            {!state.configured ? (
              <p className="mt-2 text-xs">
                Settings → Plugins → GitHub Projects Board, or{" "}
                <code>bb plugin config gh-projects-board set owner my-org</code>.
              </p>
            ) : null}
          </Notice>
        ) : state.board === null || state.board.columns.length === 0 ? (
          <Notice>Nothing matches this filter.</Notice>
        ) : (
          <div className="flex gap-4">
            {state.board.columns.map((column) => (
              <Column key={column.name} column={column} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Projects board",
    icon: "Github",
    path: "board",
    component: BoardPage,
  });
});
