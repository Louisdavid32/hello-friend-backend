import { Injectable } from "@nestjs/common";

import type { DependencyHealthResult, HealthIndicator } from "./health.types.js";

/** Owns uniquely named dependency probes and executes them with hard time limits. */
@Injectable()
export class DependencyHealthRegistry {
  private readonly indicators = new Map<string, HealthIndicator>();

  /**
   * Adds one health indicator.
   *
   * @returns A callback that removes exactly this indicator.
   * @throws When another indicator already owns the same name.
   */
  public register(indicator: HealthIndicator): () => void {
    if (this.indicators.has(indicator.name)) {
      throw new Error(`Health indicator already registered: ${indicator.name}`);
    }
    this.indicators.set(indicator.name, indicator);
    return () => this.indicators.delete(indicator.name);
  }

  /** Executes all registered probes concurrently under independent deadlines. */
  public async checkAll(timeoutMs: number): Promise<readonly DependencyHealthResult[]> {
    return Promise.all(
      [...this.indicators.values()].map(async (indicator) => this.checkOne(indicator, timeoutMs)),
    );
  }

  private async checkOne(
    indicator: HealthIndicator,
    timeoutMs: number,
  ): Promise<DependencyHealthResult> {
    const startedAt = performance.now();
    const abortController = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        indicator.check(abortController.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abortController.abort();
            reject(new Error("health_check_timeout"));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
      return {
        name: indicator.name,
        status: "healthy",
        latencyMs: elapsedMilliseconds(startedAt),
      };
    } catch (error) {
      return {
        name: indicator.name,
        status: "unhealthy",
        code:
          error instanceof Error && error.message === "health_check_timeout" ? "timeout" : "failed",
        latencyMs: elapsedMilliseconds(startedAt),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}
