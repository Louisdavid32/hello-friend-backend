import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import { APPLICATION_CONFIG, type ApplicationConfig } from "../../platform/config/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { RedisConnections, RedisKeyspace } from "../../platform/redis/index.js";
import type { RealtimeTicketPayload, RealtimeTicketStore } from "./realtime-ticket.types.js";

const OPAQUE_256 = /^[A-Za-z0-9_-]{43}$/u;
const ticketPayloadSchema = z
  .object({
    v: z.literal(1),
    ticketId: z.uuid(),
    commandId: z.uuid(),
    sessionId: z.uuid(),
    participantId: z.uuid(),
    meetingId: z.uuid(),
    origin: z.url().max(2_048),
    deviceBindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    issuedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

/** Redis adapter storing tickets by digest and consuming them with atomic GETDEL. */
@Injectable()
export class RedisRealtimeTicketStore implements RealtimeTicketStore {
  private readonly keys: RedisKeyspace;

  public constructor(
    @Inject(RedisConnections) private readonly redis: RedisConnections,
    @Inject(APPLICATION_CONFIG) config: ApplicationConfig,
  ) {
    this.keys = new RedisKeyspace(config.redis.keyPrefix);
  }

  /** Writes a compact payload under a collision-resistant digest with a millisecond TTL. */
  public async put(
    ticket: string,
    payload: RealtimeTicketPayload,
    ttlMs: number,
  ): Promise<boolean> {
    assertTicket(ticket);
    const result = await this.redis.command.set(
      this.keys.realtimeTicket(ticketDigest(ticket)),
      JSON.stringify(payload),
      { expiration: { type: "PX", value: ttlMs }, condition: "NX" },
    );
    return result === "OK";
  }

  /** Deletes before parsing so malformed or expired values can never be retried. */
  public async take(ticket: string): Promise<RealtimeTicketPayload | undefined> {
    assertTicket(ticket);
    const serialized = await this.redis.command.getDel(
      this.keys.realtimeTicket(ticketDigest(ticket)),
    );
    if (serialized === null) return undefined;
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch {
      throw invalidStoredTicket();
    }
    const parsed = ticketPayloadSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.expiresAtMs <= parsed.data.issuedAtMs) {
      throw invalidStoredTicket();
    }
    return parsed.data;
  }

  /** Best-effort compensating removal after an audit finalization failure. */
  public async remove(ticket: string): Promise<void> {
    assertTicket(ticket);
    await this.redis.command.del(this.keys.realtimeTicket(ticketDigest(ticket)));
  }
}

function ticketDigest(ticket: string): string {
  return createHash("sha256").update(ticket, "ascii").digest("hex");
}

function assertTicket(ticket: string): void {
  if (!OPAQUE_256.test(ticket)) throw invalidTicket();
}

function invalidTicket(): ApplicationError {
  return new ApplicationError(
    "REALTIME_TICKET_INVALID",
    "authentication",
    "The realtime ticket is invalid or expired.",
  );
}

function invalidStoredTicket(): ApplicationError {
  return new ApplicationError(
    "REALTIME_TICKET_STORE_INVALID",
    "dependency",
    "Realtime admission is temporarily unavailable.",
  );
}
