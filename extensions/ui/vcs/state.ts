import type { ChangeId } from "./vcs.ts";

export interface PullRequestInfo {
  number: number;
  url: string;
  isDraft: boolean;
}

export interface VcsInfoState {
  isRepository: boolean;
  kind: "git" | "jj" | null;
  /** JJ change ID of the working copy. Git has none. */
  changeId: ChangeId | null;
  /** JJ bookmarks on the working copy, or the Git branch or detached head. */
  refs: string[];
  /** Folder whose name starts the part of the path that identifies the repository. */
  nameRoot: string | null;
  changedFiles: number;
  pullRequest: PullRequestInfo | null;
}

export function emptyVcsInfoState(): VcsInfoState {
  return {
    isRepository: false,
    kind: null,
    changeId: null,
    refs: [],
    nameRoot: null,
    changedFiles: 0,
    pullRequest: null,
  };
}
