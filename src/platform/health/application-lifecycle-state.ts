import { Injectable } from "@nestjs/common";

/** Current traffic-serving phase of one process. */
export type ApplicationPhase = "starting" | "ready" | "draining";

/** Tracks whether the process can accept new traffic during startup and shutdown. */
@Injectable()
export class ApplicationLifecycleState {
  private phase: ApplicationPhase = "starting";

  public get currentPhase(): ApplicationPhase {
    return this.phase;
  }

  public get acceptsTraffic(): boolean {
    return this.phase === "ready";
  }

  /** Marks a fully initialized process as ready to receive traffic. */
  public markReady(): void {
    if (this.phase === "starting") this.phase = "ready";
  }

  /** Permanently stops the process from accepting new traffic before shutdown. */
  public beginDrain(): void {
    this.phase = "draining";
  }
}
