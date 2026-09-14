import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import { HmacKeyringService } from "../capabilities/index.js";
import { ApplicationError } from "../../platform/errors/index.js";
import { normalizeDisplayName } from "./meeting-input.js";
import { MEETING_REPOSITORY } from "./meeting.tokens.js";
import type {
  AnonymousMeetingSession,
  CreateMeetingCommand,
  JoinMeetingCommand,
  MeetingRepository,
  PersistSessionMaterial,
} from "./meeting.types.js";

/** Coordinates capability hashing, session generation and transactional meeting commands. */
@Injectable()
export class ManageAnonymousMeetingsUseCase {
  public constructor(
    private readonly keyrings: HmacKeyringService,
    @Inject(MEETING_REPOSITORY) private readonly repository: MeetingRepository,
  ) {}

  /** Creates an anonymous meeting without persisting either raw capability. */
  public create(command: CreateMeetingCommand): Promise<AnonymousMeetingSession> {
    const displayName = normalizeDisplayName(command.displayName);
    const hostCapability = this.keyrings.digestCapability(command.hostCapability);
    const inviteCapability = this.keyrings.digestCapability(command.inviteCapability);
    if (this.keyrings.digestsEqual(hostCapability.digest, inviteCapability.digest)) {
      throw new ApplicationError(
        "CAPABILITIES_MUST_DIFFER",
        "validation",
        "Host and invite capabilities must be generated independently.",
      );
    }
    const session = this.createSession(command.deviceBinding);
    const requestFingerprint = fingerprint([
      command.mode,
      displayName,
      hostCapability.version,
      hostCapability.digest.toString("hex"),
      inviteCapability.version,
      inviteCapability.digest.toString("hex"),
      session.deviceBindingDigest.digest.toString("hex"),
    ]);

    return this.repository.create({
      commandId: command.commandId,
      requestFingerprint,
      mode: command.mode,
      displayName,
      hostCapability,
      inviteCapability,
      session,
      traceId: command.traceId,
    });
  }

  /** Exchanges a valid invite capability for one anonymous participant session. */
  public join(command: JoinMeetingCommand): Promise<AnonymousMeetingSession> {
    const displayName = normalizeDisplayName(command.displayName);
    const inviteCandidates = this.keyrings.capabilityCandidates(command.inviteCapability);
    const session = this.createSession(command.deviceBinding);
    const requestFingerprint = fingerprint([
      command.meetingId,
      displayName,
      ...inviteCandidates.flatMap((candidate) => [
        candidate.version,
        candidate.digest.toString("hex"),
      ]),
      session.deviceBindingDigest.digest.toString("hex"),
    ]);

    return this.repository.join({
      meetingId: command.meetingId,
      commandId: command.commandId,
      requestFingerprint,
      displayName,
      inviteCandidates,
      session,
      traceId: command.traceId,
    });
  }

  private createSession(deviceBinding: string): PersistSessionMaterial {
    const token = this.keyrings.generateOpaqueToken();
    const csrfToken = this.keyrings.generateOpaqueToken();
    return {
      token,
      tokenDigest: this.keyrings.digestSession(token),
      csrfToken,
      csrfDigest: this.keyrings.digestCsrf(csrfToken),
      deviceBindingDigest: this.keyrings.digestDeviceBinding(deviceBinding),
    };
  }
}

function fingerprint(parts: readonly (string | number)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash
      .update(String(Buffer.byteLength(value)), "utf8")
      .update(":")
      .update(value, "utf8");
  }
  return hash.digest();
}
