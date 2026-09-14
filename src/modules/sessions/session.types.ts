import type { SessionCredentialDigests } from "../capabilities/index.js";
import type { MeetingMode } from "../meetings/index.js";

/** Product roles authorized by the durable meeting policy. */
export type ProductRole = "host" | "participant" | "presenter" | "viewer";

/** Roles understood by the independent SFU signaling plane. */
export type SfuRole = "host" | "speaker" | "viewer";

/** Stable identifiers used to revalidate an already authenticated socket. */
export interface SessionIdentity {
  /** Durable anonymous session identifier. */
  readonly sessionId: string;
  /** Participant controlled by the session. */
  readonly participantId: string;
  /** Meeting to which the participant belongs. */
  readonly meetingId: string;
}

/** Current server-authoritative anonymous participant session. */
export interface SessionPrincipal extends SessionIdentity {
  /** Meeting experience selected by the host. */
  readonly meetingMode: MeetingMode;
  /** Product authorization role. */
  readonly productRole: ProductRole;
  /** Least-privilege role later admitted to the SFU. */
  readonly sfuRole: SfuRole;
  /** Named permission profile interpreted by policy services. */
  readonly permissionProfile: string;
  /** Monotonic profile version used to invalidate stale grants. */
  readonly permissionProfileVersion: number;
  /** Absolute Unix epoch in milliseconds after which the session is invalid. */
  readonly absoluteExpiresAtMs: number;
}

/** Raw browser credentials presented only to the HTTP authentication boundary. */
export interface SessionCredentials {
  /** Opaque value read from the HttpOnly session cookie. */
  readonly token: string;
  /** Opaque value supplied in the CSRF header. */
  readonly csrfToken: string;
  /** Random per-browser value supplied in the device-binding header. */
  readonly deviceBinding: string;
}

/** Persistence boundary for credential authentication and active-session revalidation. */
export interface SessionRepository {
  /** Finds and touches one session matching all three version-aligned credential digests. */
  authenticate(
    candidates: readonly SessionCredentialDigests[],
  ): Promise<SessionPrincipal | undefined>;
  /** Revalidates durable session, participant, and meeting state and refreshes activity. */
  revalidate(identity: SessionIdentity): Promise<SessionPrincipal | undefined>;
}
