import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireNoteHost,
  getNoteHost,
  noteHostKey,
  releaseNoteHost,
  __noteHostInternals as I,
} from "../note-host";

beforeEach(() => {
  I.reset();
});

afterEach(() => {
  I.reset();
});

describe("note-host registry (H1–H4)", () => {
  it("H1: maps note-identity to a single host handle", () => {
    const first = acquireNoteHost("note:alpha");
    const second = acquireNoteHost("note:alpha");
    expect(second).toBe(first);
    expect(getNoteHost("note:alpha")).toBe(first);
    expect(I.size()).toBe(1);
    expect(I.retainCount("note:alpha")).toBe(2);
  });

  it("H1: distinct identities get distinct hosts", () => {
    const a = acquireNoteHost("note:a");
    const b = acquireNoteHost("note:b");
    expect(a).not.toBe(b);
    expect(I.size()).toBe(2);
  });

  it("H2: dispose only when retain count hits 0", () => {
    const host = acquireNoteHost("note:x");
    const dispose = vi.fn();
    host.bindResources("g1", () => ({
      doc: {},
      provider: { destroy: vi.fn() },
      dispose,
    }));
    acquireNoteHost("note:x");
    releaseNoteHost("note:x");
    expect(I.size()).toBe(1);
    expect(dispose).not.toHaveBeenCalled();
    host.unbindResources("g1");
    releaseNoteHost("note:x");
    expect(I.size()).toBe(0);
    expect(getNoteHost("note:x")).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("H3: second bind reuses resources and does not call factory again", () => {
    const host = acquireNoteHost("note:x");
    const destroy = vi.fn();
    const dispose = vi.fn(() => destroy());
    const factory = vi.fn(() => ({
      doc: { id: 1 },
      provider: { destroy },
      dispose,
    }));
    const first = host.bindResources("g1", factory);
    const second = host.bindResources("g1", factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second.doc).toBe(first.doc);
    expect(second.provider).toBe(first.provider);
    host.unbindResources("g1");
    expect(dispose).not.toHaveBeenCalled();
    host.unbindResources("g1");
    expect(dispose).toHaveBeenCalledTimes(1);
    releaseNoteHost("note:x");
  });

  it("H3: a new generation token does not construct a parallel host while panes are bound", () => {
    const host = acquireNoteHost("note:x");
    acquireNoteHost("note:x");
    const factory = vi.fn(() => ({
      doc: { id: 1 },
      provider: { destroy: vi.fn() },
      dispose: vi.fn(),
    }));
    host.bindResources("g1", factory);
    host.bindResources("g2", factory);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(host.hasResources("g1")).toBe(true);
    expect(host.hasResources("g2")).toBe(false);
    host.unbindResources("g1");
    expect(factory).toHaveBeenCalledTimes(1);
    host.unbindResources("g2");
    expect(I.retainCount("note:x")).toBe(2);
    const again = vi.fn(() => ({
      doc: { id: 2 },
      provider: { destroy: vi.fn() },
      dispose: vi.fn(),
    }));
    host.bindResources("g2", again);
    expect(again).toHaveBeenCalledTimes(1);
    expect(host.hasResources("g2")).toBe(true);
    host.unbindResources("g2");
    releaseNoteHost("note:x");
    releaseNoteHost("note:x");
  });

  it("H4 / B4: unbinding one pane keeps the host while another retain remains", () => {
    const host = acquireNoteHost("note:x");
    acquireNoteHost("note:x");
    const dispose = vi.fn();
    host.bindResources("g1", () => ({
      doc: {},
      provider: { destroy: vi.fn() },
      dispose,
    }));
    host.bindResources("g1", () => {
      throw new Error("must not construct a parallel host");
    });
    host.unbindResources("g1");
    expect(dispose).not.toHaveBeenCalled();
    expect(I.retainCount("note:x")).toBe(2);
    expect(host.hasResources("g1")).toBe(true);
    host.unbindResources("g1");
    expect(dispose).toHaveBeenCalledTimes(1);
    releaseNoteHost("note:x");
    releaseNoteHost("note:x");
  });

  it("F6: releasing the last retain disposes so a later acquire is a fresh host", () => {
    const first = acquireNoteHost("note:x");
    releaseNoteHost("note:x");
    const again = acquireNoteHost("note:x");
    expect(again).not.toBe(first);
    releaseNoteHost("note:x");
  });
});

describe("note-host window events (F2)", () => {
  it("installs one window listener and fans out to every pane handler", () => {
    const host = acquireNoteHost("note:x");
    const a = vi.fn();
    const b = vi.fn();
    const stopA = host.ownWindowEvents(["hashchange"], a);
    const stopB = host.ownWindowEvents(["hashchange"], b);
    expect(I.windowListenerCount()).toBe(1);
    window.dispatchEvent(new Event("hashchange"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA();
    expect(I.windowListenerCount()).toBe(1);
    window.dispatchEvent(new Event("hashchange"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    stopB();
    expect(I.windowListenerCount()).toBe(0);
    releaseNoteHost("note:x");
  });

  it("does not share window listeners across distinct note identities", () => {
    const a = acquireNoteHost("note:a");
    const b = acquireNoteHost("note:b");
    const stopA = a.ownWindowEvents(["hashchange"], () => {});
    const stopB = b.ownWindowEvents(["hashchange"], () => {});
    expect(I.windowListenerCount()).toBe(2);
    stopA();
    stopB();
    releaseNoteHost("note:a");
    releaseNoteHost("note:b");
  });
});

describe("note-host openOnce (B5)", () => {
  it("shares one in-flight factory across retainers", async () => {
    const host = acquireNoteHost("note:x");
    let starts = 0;
    const factory = () => {
      starts += 1;
      return Promise.resolve("session");
    };
    const first = host.openOnce("session:1", factory);
    const second = host.openOnce("session:1", factory);
    expect(starts).toBe(1);
    expect(await first).toBe("session");
    expect(await second).toBe("session");
    releaseNoteHost("note:x");
  });

  it("forgets a rejected task so a later retry can run", async () => {
    const host = acquireNoteHost("note:x");
    await expect(host.openOnce("session", () => Promise.reject(new Error("nope")))).rejects.toThrow(
      "nope",
    );
    await expect(host.openOnce("session", () => Promise.resolve("ok"))).resolves.toBe("ok");
    releaseNoteHost("note:x");
  });
});

describe("note-host startSync", () => {
  it("starts once and tears down only after the last pane stops", () => {
    const host = acquireNoteHost("note:x");
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const releaseA = host.startSync("g1", start);
    const releaseB = host.startSync("g1", start);
    expect(start).toHaveBeenCalledTimes(1);
    releaseA();
    expect(stop).not.toHaveBeenCalled();
    releaseB();
    expect(stop).toHaveBeenCalledTimes(1);
    releaseNoteHost("note:x");
  });

  it("F1: two panes on the same host invoke connect at most once", () => {
    const host = acquireNoteHost("note:x");
    const connect = vi.fn();
    const start = vi.fn(() => {
      connect();
      return () => {};
    });
    host.startSync("g1", start);
    host.startSync("g1", start);
    expect(connect).toHaveBeenCalledTimes(1);
    releaseNoteHost("note:x");
  });
});

describe("note-host gate", () => {
  it("observeHash bumps metaVersion; adoptHash does not", () => {
    const host = acquireNoteHost("note:x");
    const seen: number[] = [];
    const stop = host.subscribe(() => seen.push(host.getGate().metaVersion));
    host.observeHash("#one");
    expect(host.getGate().metaVersion).toBe(1);
    expect(host.getGate().observedHash).toBe("#one");
    host.adoptHash("#two");
    expect(host.getGate().metaVersion).toBe(1);
    expect(host.getGate().observedHash).toBe("#two");
    host.observeHash("#two");
    expect(host.getGate().metaVersion).toBe(1);
    stop();
    releaseNoteHost("note:x");
  });
});

describe("noteHostKey", () => {
  it("separates legacy slug hosts from capability token hosts", () => {
    expect(noteHostKey({ slug: "alpha" })).toBe("note:alpha");
    expect(noteHostKey({ slug: "alpha", capabilityToken: "tok" })).toBe("cap:alpha:tok");
  });
});
