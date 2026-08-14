import { useState } from "react";
import type { GitActionResult, Project, RepositoryState } from "../../shared/types";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "./ContextMenu";
import { confirm } from "./Dialog";
import { ArrowDownIcon, ArrowUpIcon, BranchIcon, RefreshIcon, SyncIcon } from "./icons";

interface BranchBarProps {
  /** The active project, or null when none is open — the bar is then an empty strip. */
  project: Project | null;
  state: RepositoryState;
  /** What the running branch command calls itself, or null while none runs in this project. */
  busyLabel: string | null;
  /** Starts a branch command through App's one-at-a-time slot for this project. */
  run: (label: string, action: () => Promise<GitActionResult>) => void;
  onRefresh: () => void;
}

/**
 * The window's bottom strip: the repository's path and HEAD on the left, and on the right the
 * one sync button plus the refresh. Its own view rather than part of App for the same reason
 * the branch tree is one — the force-push question lives with the button that asks it, since
 * this is what knows the branch and the upstream it would overwrite.
 */
export function BranchBar({ project, state, busyLabel, run, onRefresh }: BranchBarProps) {
  /** The sync button's own menu: the variants of what it does, for when its pick is not the one. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const remote = state.remotes[0]?.name;
  const start = (label: string, call: () => Promise<GitActionResult>) => () => run(`${label}...`, call);

  /**
   * The one button GitHub Desktop puts here, and the same rules for what it does: publish a
   * branch the remote has never seen, then pull what came in, then push what went out, and
   * fetch when the two agree. One thing to press, whatever the state of the branch is.
   */
  const sync = ((): { label: string; title: string; icon: React.ReactNode; run: () => void } | null => {
    if (!project || !remote || state.detached) {
      return null;
    }
    const repository = window.meezeek.repository;
    if (state.upstream === undefined) {
      return {
        label: "Publish branch",
        title: `Push ${state.head} to ${remote} and track it`,
        icon: <ArrowUpIcon />,
        run: start("Publishing", () => repository.push(project.id))
      };
    }
    if (state.behind > 0) {
      return {
        label: `Pull ${remote}`,
        title: `Pull ${state.behind} commits from ${state.upstream}`,
        icon: <ArrowDownIcon />,
        run: start("Pulling", () => repository.pull(project.id))
      };
    }
    if (state.ahead > 0) {
      return {
        label: `Push ${remote}`,
        title: `Push ${state.ahead} commits to ${state.upstream}`,
        icon: <ArrowUpIcon />,
        run: start("Pushing", () => repository.push(project.id))
      };
    }
    return {
      label: `Fetch ${remote}`,
      title: `Fetch from ${remote}`,
      icon: <SyncIcon />,
      run: start("Fetching", () => repository.fetch(project.id))
    };
  })();

  /** Rewrites what the remote holds, which is why it is the one entry that asks first. */
  const askForcePush = async (projectId: string): Promise<void> => {
    const answer = await confirm({
      title: "Force push",
      message: `Are you sure you want to force push ${state.head} to ${state.upstream}?`,
      detail:
        "Commits the remote has and this branch does not are overwritten. The push is refused if the remote moved since the last fetch.",
      confirmLabel: "Force push"
    });
    if (answer.confirmed) {
      run("Force pushing...", () => window.meezeek.repository.forcePush(projectId));
    }
  };

  /**
   * The other things that one button could have done. GitHub Desktop keeps them in its
   * Repository menu; meezeek has no menu bar, so they sit on the button itself.
   */
  const menuEntries = (projectId: string): ContextMenuEntry[] => {
    const repository = window.meezeek.repository;
    // Without an upstream there is nothing to pull from and nothing to rewrite; publishing it
    // is what the button itself offers then.
    const tracked = state.upstream !== undefined;
    return [
      { label: "Fetch", run: start("Fetching", () => repository.fetch(projectId)) },
      SEPARATOR,
      { label: "Pull", run: tracked ? start("Pulling", () => repository.pull(projectId)) : undefined },
      {
        label: "Pull with rebase",
        run: tracked ? start("Pulling", () => repository.pullRebase(projectId)) : undefined
      },
      SEPARATOR,
      { label: "Push", run: start("Pushing", () => repository.push(projectId)) },
      { label: "Force push...", run: tracked ? () => void askForcePush(projectId) : undefined }
    ];
  };

  return (
    <>
      <div className="branch-bar">
        {/* A repository that could not be read says so as a notice like everything else; the
            bar then simply has no branch to name. */}
        {project && (
          <>
            {/* Left, where a status bar puts what you are looking at; everything that acts on
                it stays on the right. */}
            <span className="branch-path" title={project.path}>
              {project.path}
            </span>
            <BranchIcon />
            {/* While a branch command runs the bar says what it is doing instead of naming
                HEAD — for those seconds the branch you are on is not the whole story. */}
            <span className={`branch-name${busyLabel === null ? "" : " busy"}`}>
              {busyLabel ?? (state.head || "...")}
            </span>
            {/* How far HEAD and its upstream have drifted apart, only where they have. */}
            {state.ahead > 0 && (
              <span className="branch-count" title={`${state.ahead} commits to push`}>
                <ArrowUpIcon />
                {state.ahead}
              </span>
            )}
            {state.behind > 0 && (
              <span className="branch-count" title={`${state.behind} commits to pull`}>
                <ArrowDownIcon />
                {state.behind}
              </span>
            )}
            {sync && (
              <button
                className="branch-sync"
                title={`${sync.title}\nRight-click for the other network commands`}
                disabled={busyLabel !== null}
                onClick={sync.run}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY });
                }}
              >
                {sync.icon}
                <span>{sync.label}</span>
              </button>
            )}
            <button className="icon-button" title="Refresh repository" onClick={onRefresh}>
              <RefreshIcon />
            </button>
          </>
        )}
      </div>

      {menu && project && (
        <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(project.id)} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
