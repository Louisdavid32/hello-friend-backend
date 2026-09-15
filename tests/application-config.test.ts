import { describe, expect, it } from "vitest";

import { ConfigurationError, loadApplicationConfig } from "../src/platform/config/index.js";

describe("loadApplicationConfig", () => {
  it("builds and freezes safe development defaults for each process", () => {
    const config = loadApplicationConfig("realtime", {});

    expect(config.runtime.role).toBe("realtime");
    expect(config.http.port).toBe(3001);
    expect(config.http.allowedOrigins).toEqual(["http://localhost:5173"]);
    expect(config.documentation.openApiEnabled).toBe(true);
    expect(config.database.enabled).toBe(false);
    expect(config.redis.enabled).toBe(false);
    expect(config.meetings.enabled).toBe(false);
    expect(config.realtime).toEqual(
      expect.objectContaining({
        path: "/v1/realtime",
        protocol: "hf-realtime.v1",
        ticketTtlSeconds: 20,
        maxMessageBytes: 16_384,
      }),
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http.allowedOrigins)).toBe(true);
  });

  it("rejects an entrypoint and APP_ROLE mismatch", () => {
    expect(() => loadApplicationConfig("api", { APP_ROLE: "worker" })).toThrow(
      new ConfigurationError("APP_ROLE must be api for this entrypoint"),
    );
  });

  it("rejects insecure public endpoints in staging and production", () => {
    expect(() =>
      loadApplicationConfig("api", {
        NODE_ENV: "production",
        REGION: "eu-west-1",
        PUBLIC_APP_ORIGIN: "http://app.example.test",
        PUBLIC_API_ORIGIN: "https://api.example.test",
        PUBLIC_REALTIME_URL: "wss://realtime.example.test/v1/realtime",
      }),
    ).toThrow("Public HTTP origins must use HTTPS outside local development");
  });

  it("accepts an explicit secure production configuration", () => {
    const config = loadApplicationConfig("api", {
      APP_ROLE: "api",
      NODE_ENV: "production",
      REGION: "eu-west-1",
      PUBLIC_APP_ORIGIN: "https://app.example.test",
      PUBLIC_API_ORIGIN: "https://api.example.test",
      PUBLIC_REALTIME_URL: "wss://realtime.example.test/v1/realtime",
      ALLOWED_ORIGINS: "https://app.example.test",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8,2001:db8::/32",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test/v1/traces",
      DATABASE_URL_FILE: "/run/secrets/database-url",
      DATABASE_SSL_CA_FILE: "/run/secrets/database-ca",
      REDIS_URL_FILE: "/run/secrets/redis-url",
      REDIS_SSL_CA_FILE: "/run/secrets/redis-ca",
      CAPABILITY_HMAC_KEYRING_FILE: "/run/secrets/capability-keyring",
      SESSION_HMAC_KEYRING_FILE: "/run/secrets/session-keyring",
    });

    expect(config.runtime.environment).toBe("production");
    expect(config.http.trustedProxyCidrs).toHaveLength(2);
    expect(config.observability.otlpEndpoint).toBe("https://otel.example.test/v1/traces");
    expect(config.documentation.openApiEnabled).toBe(false);
    expect(config.database.connectionStringFile).toBe("/run/secrets/database-url");
    expect(config.redis.mode).toBe("cluster");
  });

  it("enables local infrastructure with validated inline development URLs", () => {
    const config = loadApplicationConfig("worker", {
      DATABASE_ENABLED: "true",
      DATABASE_URL: "postgresql://app:local@127.0.0.1:5432/hello_friend",
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://127.0.0.1:6379/0",
    });

    expect(config.database).toEqual(
      expect.objectContaining({ enabled: true, poolMax: 10, tlsRequired: false }),
    );
    expect(config.redis.connectionUrls).toEqual(["redis://127.0.0.1:6379/0"]);
  });

  it("enables anonymous meetings only with both dependencies and separate keyring sources", () => {
    const key = Buffer.alloc(32, 1).toString("base64url");
    const keyringValue = JSON.stringify({ currentVersion: 1, keys: { "1": key } });
    expect(() =>
      loadApplicationConfig("api", {
        NODE_ENV: "test",
        MEETINGS_ENABLED: "true",
        CAPABILITY_HMAC_KEYRING: keyringValue,
        SESSION_HMAC_KEYRING: keyringValue,
      }),
    ).toThrow("Anonymous meetings require both PostgreSQL and Redis");
  });

  it("requires file-mounted dependency secrets and TLS outside development", () => {
    expect(() =>
      loadApplicationConfig("api", {
        NODE_ENV: "production",
        REGION: "eu-west-1",
        PUBLIC_APP_ORIGIN: "https://app.example.test",
        PUBLIC_API_ORIGIN: "https://api.example.test",
        PUBLIC_REALTIME_URL: "wss://realtime.example.test/v1/realtime",
        DATABASE_URL: "postgresql://app:secret@db.example.test/app",
      }),
    ).toThrow("DATABASE_URL must be provided through DATABASE_URL_FILE");
  });

  it("requires Redis Cluster and all durable dependencies outside development", () => {
    const base = {
      NODE_ENV: "production",
      REGION: "eu-west-1",
      PUBLIC_APP_ORIGIN: "https://app.example.test",
      PUBLIC_API_ORIGIN: "https://api.example.test",
      PUBLIC_REALTIME_URL: "wss://realtime.example.test/v1/realtime",
      DATABASE_URL_FILE: "/run/secrets/database-url",
      DATABASE_SSL_CA_FILE: "/run/secrets/database-ca",
      REDIS_URL_FILE: "/run/secrets/redis-url",
      REDIS_SSL_CA_FILE: "/run/secrets/redis-ca",
    } as const;

    expect(() => loadApplicationConfig("worker", { ...base, REDIS_MODE: "standalone" })).toThrow(
      "Redis must use Cluster mode outside development",
    );
    expect(() => loadApplicationConfig("worker", { ...base, DATABASE_ENABLED: "false" })).toThrow(
      "PostgreSQL cannot be disabled outside development",
    );
    expect(() => loadApplicationConfig("worker", { ...base, REDIS_ENABLED: "false" })).toThrow(
      "Redis cannot be disabled outside development",
    );
  });

  it("selects the direct database secret and disables Redis for migrations", () => {
    const config = loadApplicationConfig("migration", {
      DATABASE_ENABLED: "true",
      DATABASE_DIRECT_URL: "postgresql://owner:local@127.0.0.1:5432/hello_friend",
      REDIS_ENABLED: "true",
    });

    expect(config.database.connectionString).toContain("127.0.0.1");
    expect(config.database.poolMax).toBe(1);
    expect(config.redis.enabled).toBe(false);
  });

  it("confines configured secret files below the mount root", () => {
    expect(() =>
      loadApplicationConfig("api", {
        DATABASE_ENABLED: "true",
        DATABASE_URL_FILE: "/tmp/database-url",
      }),
    ).toThrow("DATABASE_URL_FILE must be a file below SECRET_MOUNT_ROOT");
  });

  it("validates OpenAPI exposure paths", () => {
    expect(() =>
      loadApplicationConfig("api", {
        OPENAPI_PATH: "/docs/",
      }),
    ).toThrow("OPENAPI_PATH must be a normalized absolute route path");
    expect(() =>
      loadApplicationConfig("api", {
        OPENAPI_PATH: "/contract",
        OPENAPI_JSON_PATH: "/contract",
      }),
    ).toThrow("OpenAPI and AsyncAPI publication paths must be different");
    expect(() =>
      loadApplicationConfig("realtime", {
        OPENAPI_JSON_PATH: "/contracts",
        ASYNCAPI_JSON_PATH: "/contracts",
      }),
    ).toThrow("OpenAPI and AsyncAPI publication paths must be different");
  });

  it("allows a worker to deliver chat without loading API meeting keyrings", () => {
    const config = loadApplicationConfig("worker", {
      NODE_ENV: "test",
      DATABASE_ENABLED: "true",
      DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
      REDIS_ENABLED: "true",
      REDIS_URLS: "redis://127.0.0.1:6379/0",
      CHAT_ENABLED: "true",
    });

    expect(config.meetings.enabled).toBe(false);
    expect(config.chat.enabled).toBe(true);
  });

  it("requires meeting authorization and both dependencies for realtime chat", () => {
    expect(() =>
      loadApplicationConfig("realtime", {
        NODE_ENV: "test",
        CHAT_ENABLED: "true",
      }),
    ).toThrow("CHAT_ENABLED requires MEETINGS_ENABLED on realtime processes");
  });

  it("rejects inconsistent chat page, quota, lease and frame budgets", () => {
    expect(() =>
      loadApplicationConfig("worker", {
        CHAT_HISTORY_PAGE_DEFAULT: "201",
        CHAT_HISTORY_PAGE_MAX: "200",
      }),
    ).toThrow("CHAT_HISTORY_PAGE_DEFAULT must not exceed CHAT_HISTORY_PAGE_MAX");
    expect(() =>
      loadApplicationConfig("worker", {
        CHAT_RATE_PER_PARTICIPANT: "10",
        CHAT_RATE_BURST: "9",
      }),
    ).toThrow("CHAT_RATE_BURST must be at least CHAT_RATE_PER_PARTICIPANT");
    expect(() =>
      loadApplicationConfig("worker", {
        REDIS_COMMAND_TIMEOUT_MS: "2000",
        CHAT_FAST_PATH_LEASE_MS: "2250",
      }),
    ).toThrow("CHAT_FAST_PATH_LEASE_MS must exceed REDIS_COMMAND_TIMEOUT_MS");
    expect(() =>
      loadApplicationConfig("worker", {
        REALTIME_MAX_MESSAGE_BYTES: "4096",
        CHAT_MAX_CIPHERTEXT_BYTES: "64",
      }),
    ).toThrow("CHAT_MAX_CIPHERTEXT_BYTES cannot fit inside REALTIME_MAX_MESSAGE_BYTES");
  });

  it("rejects origins containing a path", () => {
    expect(() =>
      loadApplicationConfig("api", { PUBLIC_APP_ORIGIN: "http://localhost:5173/app" }),
    ).toThrow("PUBLIC_APP_ORIGIN entries must not contain a path, query or fragment");
  });

  it("rejects realtime URLs with a query or a noncanonical path", () => {
    expect(() =>
      loadApplicationConfig("realtime", {
        PUBLIC_REALTIME_URL: "ws://localhost:3001/v1/realtime?ticket=secret",
      }),
    ).toThrow("exact /v1/realtime path");
    expect(() =>
      loadApplicationConfig("realtime", {
        PUBLIC_REALTIME_URL: "ws://localhost:3001/socket",
      }),
    ).toThrow("exact /v1/realtime path");
  });

  it("validates coupled realtime heartbeat and burst limits", () => {
    expect(() =>
      loadApplicationConfig("realtime", {
        REALTIME_MESSAGE_RATE_PER_SECOND: "50",
        REALTIME_MESSAGE_BURST: "20",
      }),
    ).toThrow("REALTIME_MESSAGE_BURST");
    expect(() =>
      loadApplicationConfig("realtime", {
        REALTIME_HEARTBEAT_INTERVAL_MS: "30000",
        REALTIME_PRESENCE_TTL_SECONDS: "30",
      }),
    ).toThrow("two heartbeat intervals");
  });

  it("rejects malformed trusted proxy ranges", () => {
    expect(() => loadApplicationConfig("api", { TRUSTED_PROXY_CIDRS: "10.0.0.0/99" })).toThrow(
      "TRUSTED_PROXY_CIDRS contains an invalid CIDR",
    );
  });

  it("rejects out-of-range ports without exposing environment values", () => {
    expect(() => loadApplicationConfig("api", { HTTP_PORT: "1" })).toThrow(
      "Invalid configuration: HTTP_PORT",
    );
  });
});
