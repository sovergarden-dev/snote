import { describe, it, expect, beforeEach } from "vitest";
import {
  saveLastSplitView,
  loadLastSplitView,
  clearLastSplitView,
  LAST_SPLIT_VIEW_STORAGE_KEY,
} from "../split-view-persistence";

describe("split-view-persistence", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips a 2-slug layout", () => {
    saveLastSplitView(["a", "b"]);
    const got = loadLastSplitView();
    expect(got?.count).toBe(2);
    expect(got?.path).toBe("/a+b");
    expect(got?.slugs).toEqual(["a", "b"]);
  });

  it("A6: round-trips duplicate-slug paths without stripping", () => {
    saveLastSplitView(["123", "123"]);
    const got = loadLastSplitView();
    expect(got?.count).toBe(2);
    expect(got?.path).toBe("/123+123");
    expect(got?.slugs).toEqual(["123", "123"]);
    saveLastSplitView(["a", "a", "b"]);
    expect(loadLastSplitView()?.path).toBe("/a+a+b");
    expect(loadLastSplitView()?.slugs).toEqual(["a", "a", "b"]);
  });

  it("round-trips 3 and 4 slugs", () => {
    saveLastSplitView(["a", "b", "c"]);
    expect(loadLastSplitView()?.path).toBe("/a+b+c");
    saveLastSplitView(["a", "b", "c", "d"]);
    expect(loadLastSplitView()?.count).toBe(4);
  });

  it("ignores counts outside 2..4", () => {
    saveLastSplitView(["only"]);
    expect(loadLastSplitView()).toBeNull();
    saveLastSplitView(["a", "b", "c", "d", "e"]);
    expect(loadLastSplitView()).toBeNull();
  });

  it("clears storage", () => {
    saveLastSplitView(["a", "b"]);
    clearLastSplitView();
    expect(window.sessionStorage.getItem(LAST_SPLIT_VIEW_STORAGE_KEY)).toBeNull();
    expect(loadLastSplitView()).toBeNull();
  });

  it("returns null on malformed json", () => {
    window.sessionStorage.setItem(LAST_SPLIT_VIEW_STORAGE_KEY, "{not json");
    expect(loadLastSplitView()).toBeNull();
  });

  it("returns null when stored slugs count is invalid", () => {
    window.sessionStorage.setItem(
      LAST_SPLIT_VIEW_STORAGE_KEY,
      JSON.stringify({ path: "/a", slugs: ["a"], count: 1, savedAt: 0 }),
    );
    expect(loadLastSplitView()).toBeNull();
  });

  it("uses a versioned storage key (v1) so future formats can migrate", () => {
    expect(LAST_SPLIT_VIEW_STORAGE_KEY).toBe("snote:last-split-view:v1");
    saveLastSplitView(["a", "b", "c"]);
    expect(window.sessionStorage.getItem("snote:last-split-view:v1")).not.toBeNull();
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      "snote:last-split-view:v0",
      JSON.stringify({ path: "/a+b", slugs: ["a", "b"], count: 2, savedAt: 0 }),
    );
    expect(loadLastSplitView()).toBeNull();
  });

  it("round-trips savedAt timestamp and preserves slug order", () => {
    const before = Date.now();
    saveLastSplitView(["z", "a", "m"]);
    const got = loadLastSplitView();
    expect(got?.slugs).toEqual(["z", "a", "m"]);
    expect(got?.path).toBe("/z+a+m");
    expect(got?.count).toBe(3);
    expect(got?.savedAt).toBeGreaterThanOrEqual(before);
  });

  it("rejects mismatched count vs slugs length (out of range)", () => {
    // count is metadata but loader validates via slugs.length; a payload whose
    // slugs.length is outside 2..4 must return null even if `count` claims otherwise.
    window.sessionStorage.setItem(
      LAST_SPLIT_VIEW_STORAGE_KEY,
      JSON.stringify({ path: "/a", slugs: ["a"], count: 3, savedAt: 0 }),
    );
    expect(loadLastSplitView()).toBeNull();
    window.sessionStorage.setItem(
      LAST_SPLIT_VIEW_STORAGE_KEY,
      JSON.stringify({ path: "/a+b+c+d+e", slugs: ["a", "b", "c", "d", "e"], count: 2, savedAt: 0 }),
    );
    expect(loadLastSplitView()).toBeNull();
  });

  it("rejects payload missing path string", () => {
    window.sessionStorage.setItem(
      LAST_SPLIT_VIEW_STORAGE_KEY,
      JSON.stringify({ slugs: ["a", "b"], count: 2, savedAt: 0 }),
    );
    expect(loadLastSplitView()).toBeNull();
  });
});
