import { describe, expect, it } from "vitest";
import { shouldFinishUnmountWithoutNode } from "../radix-presence-state";

describe("React 19 Presence recovery", () => {
  it("does not dispatch while a mounted or initially unmounted node is absent", () => {
    expect(shouldFinishUnmountWithoutNode("mounted")).toBe(false);
    expect(shouldFinishUnmountWithoutNode("unmounted")).toBe(false);
  });

  it("finishes only an exit already suspended on an animation", () => {
    expect(shouldFinishUnmountWithoutNode("unmountSuspended")).toBe(true);
  });
});
