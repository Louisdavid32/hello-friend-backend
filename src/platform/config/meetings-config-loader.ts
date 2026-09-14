import type {
  AppRole,
  HmacKeyringSourceConfig,
  MeetingsConfig,
  NodeEnvironment,
} from "./application-config.js";
import { ConfigurationError } from "./configuration-error.js";
import { normalizeSecretPath } from "./infrastructure-config-loader.js";

interface MeetingEnvironment {
  readonly NODE_ENV: NodeEnvironment;
  readonly MEETINGS_ENABLED?: boolean | undefined;
  readonly CAPABILITY_HMAC_KEYRING?: string | undefined;
  readonly CAPABILITY_HMAC_KEYRING_FILE?: string | undefined;
  readonly SESSION_HMAC_KEYRING?: string | undefined;
  readonly SESSION_HMAC_KEYRING_FILE?: string | undefined;
  readonly MEETING_CAPABILITY_TTL_SECONDS: number;
  readonly MEETING_TTL_SECONDS: number;
  readonly SESSION_IDLE_TTL_SECONDS: number;
  readonly SESSION_ABSOLUTE_TTL_SECONDS: number;
  readonly SESSION_COOKIE_NAME?: string | undefined;
  readonly MEETING_CREATE_RATE_LIMIT: number;
  readonly MEETING_JOIN_RATE_LIMIT: number;
  readonly MEETING_RATE_LIMIT_WINDOW_SECONDS: number;
}

/** @internal Builds the anonymous meeting security policy for one process. */
export function loadMeetingsConfig(
  env: MeetingEnvironment,
  role: AppRole,
  secretMountRoot: string,
): MeetingsConfig {
  const secureDeployment = env.NODE_ENV === "staging" || env.NODE_ENV === "production";
  const servesMeetings = role === "api" || role === "realtime";
  const enabled = servesMeetings && (env.MEETINGS_ENABLED ?? secureDeployment);
  if (secureDeployment && servesMeetings && !enabled) {
    throw new ConfigurationError(
      "Anonymous meeting security cannot be disabled in API or realtime deployments",
    );
  }
  const sessionCookieName =
    env.SESSION_COOKIE_NAME ?? (secureDeployment ? "__Host-hf_session" : "hf_session");
  if (!/^(?:__Host-)?[A-Za-z0-9_-]{1,64}$/u.test(sessionCookieName)) {
    throw new ConfigurationError("SESSION_COOKIE_NAME has an invalid canonical format");
  }
  if (secureDeployment && sessionCookieName !== "__Host-hf_session") {
    throw new ConfigurationError(
      "SESSION_COOKIE_NAME must be __Host-hf_session outside development",
    );
  }
  if (env.MEETING_CAPABILITY_TTL_SECONDS > env.MEETING_TTL_SECONDS) {
    throw new ConfigurationError("Capability lifetime must not exceed meeting lifetime");
  }
  if (
    env.SESSION_IDLE_TTL_SECONDS > env.SESSION_ABSOLUTE_TTL_SECONDS ||
    env.SESSION_ABSOLUTE_TTL_SECONDS > env.MEETING_TTL_SECONDS
  ) {
    throw new ConfigurationError(
      "Session lifetimes must be ordered and bounded by meeting lifetime",
    );
  }

  const defaults: MeetingsConfig = {
    enabled,
    capabilityTtlSeconds: env.MEETING_CAPABILITY_TTL_SECONDS,
    meetingTtlSeconds: env.MEETING_TTL_SECONDS,
    sessionIdleTtlSeconds: env.SESSION_IDLE_TTL_SECONDS,
    sessionAbsoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
    sessionCookieName,
    createRateLimit: env.MEETING_CREATE_RATE_LIMIT,
    joinRateLimit: env.MEETING_JOIN_RATE_LIMIT,
    rateLimitWindowSeconds: env.MEETING_RATE_LIMIT_WINDOW_SECONDS,
  };
  if (!enabled) return defaults;

  return {
    ...defaults,
    capabilityKeyring: selectKeyring(
      env.CAPABILITY_HMAC_KEYRING,
      env.CAPABILITY_HMAC_KEYRING_FILE,
      "CAPABILITY_HMAC_KEYRING",
      secureDeployment,
      secretMountRoot,
    ),
    sessionKeyring: selectKeyring(
      env.SESSION_HMAC_KEYRING,
      env.SESSION_HMAC_KEYRING_FILE,
      "SESSION_HMAC_KEYRING",
      secureDeployment,
      secretMountRoot,
    ),
  };
}

function selectKeyring(
  inlineSecret: string | undefined,
  file: string | undefined,
  name: string,
  secureDeployment: boolean,
  mountRoot: string,
): HmacKeyringSourceConfig {
  if (inlineSecret !== undefined && file !== undefined) {
    throw new ConfigurationError(`${name} and ${name}_FILE are mutually exclusive`);
  }
  if (secureDeployment && inlineSecret !== undefined) {
    throw new ConfigurationError(`${name} must be provided through ${name}_FILE`);
  }
  if (file !== undefined) {
    return { secretFile: normalizeSecretPath(file, `${name}_FILE`, mountRoot) };
  }
  if (inlineSecret !== undefined) return { inlineSecret };
  throw new ConfigurationError(`${name}_FILE is required when anonymous meetings are enabled`);
}
