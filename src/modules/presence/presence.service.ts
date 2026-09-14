import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { StructuredLogger } from "../../platform/observability/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";
import {
  CLOSE_PRESENCE_SCRIPT,
  HEARTBEAT_PRESENCE_SCRIPT,
  OPEN_PRESENCE_SCRIPT,
  SNAPSHOT_PRESENCE_SCRIPT,
} from "./presence-scripts.js";
import type {
  PresenceConnection,
  PresenceParticipant,
  PresenceRevisionListener,
  PresenceSnapshot,
} from "./presence.types.js";

interface Subscription {
  readonly listeners: Set<PresenceRevisionListener>;
}

interface ShardedSubscriber {
  sSubscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  sUnsubscribe(channel: string): Promise<unknown>;
}

interface ShardedPublisher {
  sPublish(channel: string, message: string): Promise<unknown>;
}

const detailSchema = z
  .object({
    participantId: z.uuid(),
    sessionId: z.uuid(),
    productRole: z.enum(["host", "participant", "presenter", "viewer"]),
  })
  .strict();
const notificationSchema = z
  .object({ v: z.literal(1), revision: z.string().regex(/^\d+$/u) })
  .strict();
const PURGE_BATCH_SIZE = 500;

/** Owns repairable Redis presence and sharded inter-process revision notifications. */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly keys: RedisKeyspace;
  private readonly subscriptions = new Map<string, Subscription>();

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(APPLICATION_CONFIG) private readonly config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Opens one connection presence and returns false when Redis is unavailable. */
  public async open(meetingId: string, connection: PresenceConnection): Promise<boolean> {
    try {
      const revision = await this.redis.command.eval(OPEN_PRESENCE_SCRIPT, {
        keys: this.presenceKeys(meetingId),
        arguments: [
          connection.connectionId,
          JSON.stringify({
            participantId: connection.participantId,
            sessionId: connection.sessionId,
            productRole: connection.productRole,
          }),
          String(this.config.realtime.presenceTtlSeconds * 1_000),
          String(PURGE_BATCH_SIZE),
        ],
      });
      await this.redis.command.sAdd(
        this.keys.sessionConnections(connection.sessionId),
        connection.connectionId,
      );
      await this.redis.command.pExpire(
        this.keys.sessionConnections(connection.sessionId),
        this.config.realtime.presenceTtlSeconds * 2_000,
      );
      await this.publish(meetingId, asDecimalString(revision));
      return true;
    } catch (error) {
      this.logUnavailable("presence_open_failed", error);
      return false;
    }
  }

  /** Refreshes a connection with the Redis clock and never invents presence on failure. */
  public async heartbeat(
    meetingId: string,
    sessionId: string,
    connectionId: string,
  ): Promise<boolean> {
    try {
      const result = await this.redis.command.eval(HEARTBEAT_PRESENCE_SCRIPT, {
        keys: this.presenceKeys(meetingId),
        arguments: [
          connectionId,
          String(this.config.realtime.presenceTtlSeconds * 1_000),
          String(PURGE_BATCH_SIZE),
        ],
      });
      await this.redis.command.pExpire(
        this.keys.sessionConnections(sessionId),
        this.config.realtime.presenceTtlSeconds * 2_000,
      );
      const heartbeat = parseHeartbeatResult(result);
      if (heartbeat.changed) await this.publish(meetingId, heartbeat.revision);
      return heartbeat.present;
    } catch (error) {
      this.logUnavailable("presence_heartbeat_failed", error);
      return false;
    }
  }

  /** Returns the bounded ephemeral connection index used to accelerate revocation. */
  public async connectionsForSession(sessionId: string): Promise<readonly string[]> {
    try {
      const connections = await this.redis.command.sMembers(
        this.keys.sessionConnections(sessionId),
      );
      return connections
        .filter((connectionId) => /^[0-9a-f-]{36}$/iu.test(connectionId))
        .slice(0, this.config.realtime.maxConnectionsPerSession);
    } catch (error) {
      this.logUnavailable("presence_session_index_failed", error);
      return [];
    }
  }

  /** Removes one connection from presence and its revocation index idempotently. */
  public async close(meetingId: string, sessionId: string, connectionId: string): Promise<void> {
    try {
      const revision = await this.redis.command.eval(CLOSE_PRESENCE_SCRIPT, {
        keys: this.presenceKeys(meetingId),
        arguments: [connectionId, String(this.config.realtime.presenceTtlSeconds * 1_000)],
      });
      await this.redis.command.sRem(this.keys.sessionConnections(sessionId), connectionId);
      await this.publish(meetingId, asDecimalString(revision));
    } catch (error) {
      this.logUnavailable("presence_close_failed", error);
    }
  }

  /** Returns an aggregated bounded snapshot, or explicit unknown state during Redis failure. */
  public async snapshot(meetingId: string): Promise<PresenceSnapshot> {
    const connectionLimit =
      this.config.realtime.maxPresenceSnapshotParticipants *
      this.config.realtime.maxConnectionsPerSession;
    try {
      const result = await this.redis.command.eval(SNAPSHOT_PRESENCE_SCRIPT, {
        keys: this.presenceKeys(meetingId),
        arguments: [String(connectionLimit), String(PURGE_BATCH_SIZE)],
      });
      const parsed = parseSnapshotResult(result);
      if (parsed.changed) await this.publish(meetingId, parsed.revision);
      const participants = aggregateParticipants(parsed.details);
      const max = this.config.realtime.maxPresenceSnapshotParticipants;
      return {
        revision: parsed.revision,
        status: "available",
        participants: participants.slice(0, max),
        truncated: parsed.totalConnections > connectionLimit || participants.length > max,
      };
    } catch (error) {
      this.logUnavailable("presence_snapshot_failed", error);
      return { revision: "0", status: "unknown", participants: [], truncated: true };
    }
  }

  /** Subscribes a local socket to coalescable revisions for one meeting. */
  public async watch(
    meetingId: string,
    listener: PresenceRevisionListener,
  ): Promise<() => Promise<void>> {
    const existing = this.subscriptions.get(meetingId);
    if (existing !== undefined) {
      existing.listeners.add(listener);
      return () => this.unwatch(meetingId, listener);
    }

    const subscription: Subscription = { listeners: new Set([listener]) };
    this.subscriptions.set(meetingId, subscription);
    try {
      await this.subscriber().sSubscribe(this.keys.meetingRealtimeChannel(meetingId), (message) => {
        const parsed = parseNotification(message);
        if (parsed === undefined) return;
        const current = this.subscriptions.get(meetingId);
        if (current === undefined) return;
        for (const callback of current.listeners) callback(parsed);
      });
    } catch (error) {
      this.subscriptions.delete(meetingId);
      this.logUnavailable("presence_subscribe_failed", error);
      throw error;
    }
    return () => this.unwatch(meetingId, listener);
  }

  /** Removes all Pub/Sub subscriptions before the Redis subscriber is closed. */
  public async onModuleDestroy(): Promise<void> {
    const meetingIds = [...this.subscriptions.keys()];
    this.subscriptions.clear();
    await Promise.allSettled(
      meetingIds.map((meetingId) =>
        this.subscriber().sUnsubscribe(this.keys.meetingRealtimeChannel(meetingId)),
      ),
    );
  }

  private async unwatch(meetingId: string, listener: PresenceRevisionListener): Promise<void> {
    const subscription = this.subscriptions.get(meetingId);
    if (subscription === undefined) return;
    subscription.listeners.delete(listener);
    if (subscription.listeners.size > 0) return;
    this.subscriptions.delete(meetingId);
    await this.subscriber()
      .sUnsubscribe(this.keys.meetingRealtimeChannel(meetingId))
      .catch((error: unknown) => this.logUnavailable("presence_unsubscribe_failed", error));
  }

  private presenceKeys(meetingId: string): [string, string, string] {
    return [
      this.keys.meetingPresenceConnections(meetingId),
      this.keys.meetingPresenceDetails(meetingId),
      this.keys.meetingPresenceRevision(meetingId),
    ];
  }

  private async publish(meetingId: string, revision: string): Promise<void> {
    try {
      await this.publisher().sPublish(
        this.keys.meetingRealtimeChannel(meetingId),
        JSON.stringify({ v: 1, revision }),
      );
    } catch (error) {
      this.logUnavailable("presence_publish_failed", error);
    }
  }

  private subscriber(): ShardedSubscriber {
    return this.redis.subscriber;
  }

  private publisher(): ShardedPublisher {
    return this.redis.publisher;
  }

  private logUnavailable(event: string, error: unknown): void {
    this.logger.warn({ event, error }, PresenceService.name);
  }
}

function parseSnapshotResult(value: unknown): {
  readonly revision: string;
  readonly totalConnections: number;
  readonly changed: boolean;
  readonly details: readonly z.infer<typeof detailSchema>[];
} {
  if (!Array.isArray(value) || value.length < 3) throw new Error("Invalid presence snapshot");
  const revision = asDecimalString(value[0]);
  const totalConnections = Number(asDecimalString(value[1]));
  const changed = asDecimalString(value[2]) === "1";
  if (!Number.isSafeInteger(totalConnections) || totalConnections < 0) {
    throw new Error("Invalid presence total");
  }
  const details: z.infer<typeof detailSchema>[] = [];
  for (const serialized of value.slice(3)) {
    if (typeof serialized !== "string") continue;
    try {
      const parsed = detailSchema.safeParse(JSON.parse(serialized));
      if (parsed.success) details.push(parsed.data);
    } catch {
      continue;
    }
  }
  return { revision, totalConnections, changed, details };
}

function parseHeartbeatResult(value: unknown): {
  readonly revision: string;
  readonly changed: boolean;
  readonly present: boolean;
} {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error("Invalid presence heartbeat");
  }
  return {
    revision: asDecimalString(value[0]),
    changed: asDecimalString(value[1]) === "1",
    present: asDecimalString(value[2]) === "1",
  };
}

function aggregateParticipants(
  details: readonly z.infer<typeof detailSchema>[],
): PresenceParticipant[] {
  const participants = new Map<string, PresenceParticipant>();
  for (const detail of details) {
    participants.set(detail.participantId, {
      participantId: detail.participantId,
      productRole: detail.productRole,
      state: "online",
    });
  }
  return [...participants.values()].sort((left, right) =>
    left.participantId.localeCompare(right.participantId),
  );
}

function parseNotification(message: string): string | undefined {
  try {
    const parsed = notificationSchema.safeParse(JSON.parse(message));
    return parsed.success ? parsed.data.revision : undefined;
  } catch {
    return undefined;
  }
}

function asDecimalString(value: unknown): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/u.test(normalized)) throw new Error("Invalid Redis decimal response");
  return normalized;
}
