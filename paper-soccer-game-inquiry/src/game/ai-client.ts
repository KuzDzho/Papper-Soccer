import type { BotLevel } from "./ai";
import type { AiRequest, AiResponse } from "./ai-protocol";
import type { Pt, SerializedState } from "./engine";

export interface BotSearch {
  warmup(): void;
  choose(state: SerializedState, level: BotLevel): Promise<Pt | null>;
  cancel(): void;
  dispose(): void;
}

/** Small injectable interface for deterministic worker lifecycle tests. */
export interface AiWorkerPort {
  onmessage: ((event: MessageEvent<AiResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: AiRequest): void;
  terminate(): void;
}

interface Pending {
  request: AiRequest;
  resolve: (target: Pt | null) => void;
  reject: (error: Error) => void;
  watchdog: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  usingServer: boolean;
}

function createWorker(): AiWorkerPort {
  // Keep this exact inline URL expression for Next/Turbopack's worker bundling.
  return new Worker(new URL("./ai.worker.ts", import.meta.url), {
    type: "module",
    name: "paper-soccer-ai",
  });
}

/** A reusable worker, with at most ONE outstanding search. No AI algorithm is
 * imported into this module, and no synchronous main-thread fallback exists. */
export class AiClient implements BotSearch {
  private worker: AiWorkerPort | null = null;
  private workerUnavailable = false;
  private pending: Pending | null = null;
  private nextId = 0;

  constructor(private readonly workerFactory: () => AiWorkerPort = createWorker) {}

  warmup(): void {
    this.ensureWorker();
  }

  private ensureWorker(): AiWorkerPort | null {
    if (this.workerUnavailable) return null;
    if (this.worker) return this.worker;
    try {
      const worker = this.workerFactory();
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        const pending = this.pending;
        if (!pending || pending.usingServer || data.id !== pending.request.id) return;
        if (data.ok) this.complete(pending, data);
        else this.useServer(pending);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker !== worker) return;
        this.workerUnavailable = true;
        this.stopWorker();
        if (this.pending) this.useServer(this.pending);
      };
      worker.onmessageerror = () => {
        if (this.worker !== worker) return;
        this.workerUnavailable = true;
        this.stopWorker();
        if (this.pending) this.useServer(this.pending);
      };
      return worker;
    } catch {
      // Worker disabled / not supported / blocked by CSP. Keep the same AI
      // strength via a server request instead of freezing the page as fallback.
      this.workerUnavailable = true;
      return null;
    }
  }

  choose(state: SerializedState, level: BotLevel): Promise<Pt | null> {
    if (this.pending) return Promise.reject(new Error("ai-search-in-progress"));
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        request: { id: ++this.nextId, state, level },
        resolve,
        reject,
        watchdog: null,
        abort: null,
        usingServer: false,
      };
      this.pending = pending;
      const worker = this.ensureWorker();
      if (!worker) {
        this.useServer(pending);
        return;
      }
      pending.watchdog = setTimeout(() => this.useServer(pending), 8_000);
      try {
        worker.postMessage(pending.request);
      } catch {
        this.useServer(pending);
      }
    });
  }

  private useServer(pending: Pending): void {
    if (this.pending !== pending || pending.usingServer) return;
    pending.usingServer = true;
    this.workerUnavailable = true;
    this.stopWorker();
    if (pending.watchdog) clearTimeout(pending.watchdog);
    const abort = new AbortController();
    pending.abort = abort;
    pending.watchdog = setTimeout(() => abort.abort(), 12_000);
    void fetch("/api/ai/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending.request),
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("ai-server-unavailable");
        const result = (await response.json()) as AiResponse;
        if (result.id !== pending.request.id) throw new Error("ai-response-mismatch");
        this.complete(pending, result);
      })
      .catch((error: unknown) => {
        this.fail(pending, error instanceof Error ? error : new Error("ai-search-failed"));
      });
  }

  private complete(pending: Pending, result: AiResponse): void {
    if (this.pending !== pending) return;
    if (!result.ok) {
      this.fail(pending, new Error(result.error));
      return;
    }
    if (pending.watchdog) clearTimeout(pending.watchdog);
    this.pending = null;
    pending.resolve(result.target);
  }

  private fail(pending: Pending, error: Error): void {
    if (this.pending !== pending) return;
    if (pending.watchdog) clearTimeout(pending.watchdog);
    this.pending = null;
    pending.reject(error);
  }

  private stopWorker(): void {
    if (!this.worker) return;
    const worker = this.worker;
    this.worker = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    this.stopWorker(); // stops CPU work immediately, not merely its reply
    if (!pending) return;
    if (pending.watchdog) clearTimeout(pending.watchdog);
    pending.abort?.abort();
    const error = new Error("ai-search-cancelled");
    error.name = "AbortError";
    pending.reject(error);
  }

  dispose(): void {
    this.cancel();
  }
}
