import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

/** Emitters for the global `agent-run:{id}` stream, keyed by event name. */
let emitters: Map<string, (payload: unknown) => void>;

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  listenMock.mockReset();
  emitters = new Map();
  listenMock.mockImplementation(async (event: string, handler: (p: unknown) => void) => {
    emitters.set(event, handler);
    return () => emitters.delete(event);
  });
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One Mission Control row, as AiPanel publishes it while it streams.
 *
 *  Rows are published rather than written into localStorage on purpose: the
 *  store's decoder rehydrates every persisted row as "done", because a Klide
 *  Harness Run dies with the app process. "Running" only ever exists in a live
 *  session, which is the only session this indicator has to be right in. */
function storeRow(id: string, status: string) {
  return {
    id,
    title: id,
    status,
    provider: "ollama",
    model: "llama3.1:8b",
    cwd: "/workspace",
    branch: null,
    messages: [{ role: "user", text: "go" }],
    updatedMs: 1,
  };
}

async function publish(id: string, status: string) {
  const { publishKlideConvo } = await import("./klideConvos");
  publishKlideConvo(storeRow(id, status) as never);
}

/** Lets the module's confirm-then-follow chain of awaits run to completion. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load() {
  return import("./runningConversations");
}

describe("running conversations", () => {
  it("confirms a published row against Rust before calling it live", async () => {
    invokeMock.mockResolvedValue("running");

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-live", "running");
    await settled();

    expect(invokeMock).toHaveBeenCalledWith("agent_run_status", { runId: "run-live" });
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);
  });

  it("does not trust a 'running' row the harness has already finished", async () => {
    // The exact shape a panel unmounted mid-run leaves behind: the last
    // snapshot it wrote says running, the run settled afterwards, and nothing
    // was mounted to correct the record.
    invokeMock.mockResolvedValue(null); // supervisor no longer tracks it

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("run-stale", "running");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
  });

  it("drops the row when the run it is following emits a terminal event", async () => {
    invokeMock.mockResolvedValue("running");

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    const notified = vi.fn();
    subscribeRunningConversations(notified);
    await publish("run-live", "running");
    await settled();
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);

    emitters.get("agent-run:run-live")?.({
      payload: { seq: 7, event: { type: "run_result" } },
    });
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
    expect(notified).toHaveBeenCalled();
  });

  it("ignores a conversation with no Harness Run — a Delegate PTY is not one", async () => {
    invokeMock.mockResolvedValue(null);

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});
    await publish("delegate-convo", "running");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
  });

  it("follows each live run once, however often the store republishes", async () => {
    invokeMock.mockResolvedValue("running");

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    subscribeRunningConversations(() => {});

    // AiPanel republishes on every message delta; each one re-runs reconcile.
    for (let i = 0; i < 5; i += 1) {
      await publish("run-live", "running");
      await settled();
    }

    expect(listenMock).toHaveBeenCalledTimes(1);
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);
  });

  it("stops following a run whose panel came back and settled it", async () => {
    invokeMock.mockResolvedValue("running");

    const { subscribeRunningConversations, getRunningConversationIds } = await load();
    const { settleKlideConvo } = await import("./klideConvos");
    subscribeRunningConversations(() => {});
    await publish("run-live", "running");
    await settled();
    expect([...getRunningConversationIds()]).toEqual(["run-live"]);

    settleKlideConvo("run-live");
    await settled();

    expect([...getRunningConversationIds()]).toEqual([]);
    expect(emitters.has("agent-run:run-live")).toBe(false);
  });
});
