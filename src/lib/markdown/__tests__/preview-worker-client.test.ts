import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockWorker {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((e: { data: { id: number; html: string } }) => void) | null;
  terminate: ReturnType<typeof vi.fn>;
  onerror: ((e: unknown) => void) | null;
}

function createMockWorker(): MockWorker {
  return {
    postMessage: vi.fn(),
    onmessage: null,
    terminate: vi.fn(),
    onerror: null,
  };
}

async function loadClient() {
  return import("../preview-worker-client");
}

describe("preview-worker-client", () => {
  let workers: MockWorker[];
  let WorkerConstructor: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    workers = [];
    WorkerConstructor = vi.fn(function () {
      const mockWorker = createMockWorker();
      workers.push(mockWorker);
      return mockWorker;
    });
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: WorkerConstructor,
    });

    const { __resetPreviewWorkerForTests } = await loadClient();
    __resetPreviewWorkerForTests();
  });

  it("resolves each request independently in any reply order", async () => {
    const { renderInWorker } = await loadClient();

    const p1 = renderInWorker("a");
    const p2 = renderInWorker("b");

    expect(workers[0].postMessage).toHaveBeenNthCalledWith(1, { id: 1, text: "a" });
    expect(workers[0].postMessage).toHaveBeenNthCalledWith(2, { id: 2, text: "b" });

    workers[0].onmessage!({ data: { id: 2, html: "<p>b</p>" } });
    workers[0].onmessage!({ data: { id: 1, html: "<p>a</p>" } });

    await expect(p2).resolves.toBe("<p>b</p>");
    await expect(p1).resolves.toBe("<p>a</p>");
  });

  it("sanitizes worker output while preserving hydration attributes", async () => {
    const { renderInWorker } = await loadClient();
    const rendered = renderInWorker("diagram");

    workers[0].onmessage!({
      data: {
        id: 1,
        html: '<img src=x onerror="alert(1)"><div data-mermaid="graph%20TD">loading</div>',
      },
    });

    await expect(rendered).resolves.toBe(
      '<img src="x"><div data-mermaid="graph%20TD">loading</div>',
    );
  });

  it("rejects all requests and discards the singleton when the worker errors", async () => {
    const { renderInWorker } = await loadClient();
    const first = renderInWorker("a");
    const second = renderInWorker("b");
    const firstRejected = vi.fn();
    const secondRejected = vi.fn();
    void first.catch(firstRejected);
    void second.catch(secondRejected);

    workers[0].onerror!(new Error("worker crashed"));
    await Promise.resolve();

    expect(firstRejected).toHaveBeenCalledWith(expect.objectContaining({ message: "worker crashed" }));
    expect(secondRejected).toHaveBeenCalledWith(expect.objectContaining({ message: "worker crashed" }));
    expect(workers[0].terminate).toHaveBeenCalledOnce();

    const retry = renderInWorker("retry");
    expect(WorkerConstructor).toHaveBeenCalledTimes(2);
    workers[1].onmessage!({ data: { id: 3, html: "<p>retry</p>" } });
    await expect(retry).resolves.toBe("<p>retry</p>");
  });

  it("returns a rejected promise when worker construction fails and retries next call", async () => {
    const { renderInWorker } = await loadClient();
    WorkerConstructor
      .mockImplementationOnce(function () {
        throw new Error("workers unavailable");
      })
      .mockImplementationOnce(function () {
        const mockWorker = createMockWorker();
        workers.push(mockWorker);
        return mockWorker;
      });

    await expect(renderInWorker("offline")).rejects.toThrow("workers unavailable");

    const retry = renderInWorker("online");
    workers[0].onmessage!({ data: { id: 1, html: "<p>online</p>" } });
    await expect(retry).resolves.toBe("<p>online</p>");
    expect(WorkerConstructor).toHaveBeenCalledTimes(2);
  });

  it("rejects every affected request when postMessage throws and retries with a fresh worker", async () => {
    const { renderInWorker } = await loadClient();
    WorkerConstructor.mockImplementationOnce(function () {
      const mockWorker = createMockWorker();
      mockWorker.postMessage.mockImplementationOnce(() => {
        throw new Error("postMessage failed");
      });
      workers.push(mockWorker);
      return mockWorker;
    });

    await expect(renderInWorker("first")).rejects.toThrow("postMessage failed");
    expect(workers[0].terminate).toHaveBeenCalledOnce();

    const retry = renderInWorker("second");
    workers[1].onmessage!({ data: { id: 2, html: "<p>second</p>" } });
    await expect(retry).resolves.toBe("<p>second</p>");
  });

  it("explicit reset rejects pending work and lets the next call create a fresh worker", async () => {
    const { renderInWorker, __resetPreviewWorkerForTests } = await loadClient();
    const pending = renderInWorker("pending");
    const rejected = vi.fn();
    void pending.catch(rejected);

    __resetPreviewWorkerForTests();
    await Promise.resolve();

    expect(rejected.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/reset/i) }),
    );
    expect(workers[0].terminate).toHaveBeenCalledOnce();

    const retry = renderInWorker("retry");
    workers[1].onmessage!({ data: { id: 1, html: "<p>retry</p>" } });
    await expect(retry).resolves.toBe("<p>retry</p>");
  });

  it("renders a deterministic sanitized main-thread fallback with worker-equivalent semantics", async () => {
    const { renderOnMainThread } = await loadClient();

    const html = await renderOnMainThread(
      "first line\nsecond line\n\n<title>unsafe</title>\n\n```mermaid\ngraph TD\n```",
    );

    expect(html).toContain("first line<br>second line");
    expect(html).toContain("&lt;title&gt;unsafe&lt;/title&gt;");
    expect(html).not.toContain("<title>");
    expect(html).toContain('data-mermaid="graph%20TD"');
  });

  it("keeps table wrappers, copy buttons, and heading anchors through sanitization", async () => {
    const { renderOnMainThread } = await loadClient();
    const html = await renderOnMainThread(
      "# Owner\n\n| a | b |\n| --- | --- |\n| 42.661 | `ok` |\n\n```js\nconst x = 1;\n```\n",
    );
    expect(html).toContain('class="md-table-wrap"');
    expect(html).toContain('id="preview-h-owner"');
    expect(html).not.toContain('id="owner"');
    expect(html).toContain("data-md-copy");
    expect(html).toContain("data-preview-heading");
    expect(html).toContain("42.661");
  });
});
