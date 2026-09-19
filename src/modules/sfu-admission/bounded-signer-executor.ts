import { ApplicationError } from "../../platform/errors/index.js";

interface QueuedSigningOperation {
  readonly operation: (signal: AbortSignal) => Promise<Uint8Array>;
  readonly resolve: (signature: Uint8Array) => void;
  readonly reject: (error: unknown) => void;
}

/** Bounds signer concurrency, queue memory, and latency under KMS degradation. */
export class BoundedSignerExecutor {
  private readonly queue: QueuedSigningOperation[] = [];
  private active = 0;
  private closed = false;

  public constructor(
    private readonly concurrency: number,
    private readonly queueCapacity: number,
    private readonly timeoutMs: number,
  ) {}

  /** Runs or queues one signing operation and fails fast when capacity is exhausted. */
  public execute(operation: (signal: AbortSignal) => Promise<Uint8Array>): Promise<Uint8Array> {
    if (this.closed || this.queue.length >= this.queueCapacity) {
      return Promise.reject(signerUnavailable("SFU admission signer capacity is unavailable."));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const queued = { operation, resolve, reject };
      if (this.active < this.concurrency) this.start(queued);
      else this.queue.push(queued);
    });
  }

  /** Refuses queued work during shutdown while allowing active provider calls to settle. */
  public close(): void {
    this.closed = true;
    for (const operation of this.queue.splice(0)) {
      operation.reject(signerUnavailable("SFU admission signer is shutting down."));
    }
  }

  private start(queued: QueuedSigningOperation): void {
    this.active += 1;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(signerUnavailable("SFU admission signing timed out."));
      }, this.timeoutMs);
      timer.unref();
    });
    void Promise.race([queued.operation(controller.signal), timeout])
      .then(queued.resolve, queued.reject)
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        this.active -= 1;
        const next = this.queue.shift();
        if (next !== undefined) this.start(next);
      });
  }
}

function signerUnavailable(message: string): ApplicationError {
  return new ApplicationError("SFU_ADMISSION_UNAVAILABLE", "dependency", message);
}
