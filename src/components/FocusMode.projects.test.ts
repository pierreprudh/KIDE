import { describe, expect, it } from "vitest";

import { focusProjectRoots } from "./FocusMode";

const KIDE = "/Users/pierre/Documents/Private/KIDE";
const RUN = `${KIDE}-worktrees/klide-run-how-to-report-a-bug-on-codex-app-a9dc5e94`;

describe("Focus project rail", () => {
  it("keeps a linked run under its owning workspace", () => {
    expect(focusProjectRoots([RUN, KIDE], RUN)).toEqual([KIDE]);
  });

  it("does not append an active linked run as another workspace", () => {
    expect(focusProjectRoots([KIDE], RUN)).toEqual([KIDE]);
  });
});
