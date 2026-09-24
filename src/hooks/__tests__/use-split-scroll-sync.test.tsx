import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSplitScrollSync } from "../use-split-scroll-sync";

function scroller({
  scrollTop = 0,
  scrollHeight = 1_000,
  clientHeight = 200,
}: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
} = {}) {
  const element = document.createElement("div");
  element.scrollTop = scrollTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: scrollHeight },
    clientHeight: { configurable: true, value: clientHeight },
  });
  return element;
}

describe("useSplitScrollSync", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("starts syncing when lazy panes register their scrollers after mount", () => {
    const { result } = renderHook(() => useSplitScrollSync(true, 2));
    const first = scroller({ scrollHeight: 1_000, clientHeight: 200 });
    const second = scroller({ scrollHeight: 2_000, clientHeight: 400 });

    act(() => {
      result.current(0, first);
      result.current(1, second);
    });

    first.scrollTop = 400;
    act(() => first.dispatchEvent(new Event("scroll")));

    expect(second.scrollTop).toBe(800);
  });

  it("C2: with Sync OFF, scrolling pane 0 does not move pane 1", () => {
    const { result } = renderHook(() => useSplitScrollSync(false, 2));
    const first = scroller({ scrollHeight: 1_000, clientHeight: 200 });
    const second = scroller({ scrollHeight: 2_000, clientHeight: 400, scrollTop: 50 });

    act(() => {
      result.current(0, first);
      result.current(1, second);
    });

    first.scrollTop = 400;
    act(() => first.dispatchEvent(new Event("scroll")));
    expect(second.scrollTop).toBe(50);

    second.scrollTop = 900;
    act(() => second.dispatchEvent(new Event("scroll")));
    expect(first.scrollTop).toBe(400);
  });

  it("removes listeners when a pane unregisters or sync is disabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useSplitScrollSync(enabled, 2),
      { initialProps: { enabled: true } },
    );
    const first = scroller({ scrollHeight: 1_000, clientHeight: 200 });
    const second = scroller({ scrollHeight: 1_000, clientHeight: 200 });

    act(() => {
      result.current(0, first);
      result.current(1, second);
    });
    act(() => result.current(1, null));
    first.scrollTop = 400;
    act(() => first.dispatchEvent(new Event("scroll")));
    expect(second.scrollTop).toBe(0);

    act(() => result.current(1, second));
    rerender({ enabled: false });
    first.scrollTop = 600;
    act(() => first.dispatchEvent(new Event("scroll")));
    expect(second.scrollTop).toBe(0);
  });
});
