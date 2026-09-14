import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { createClient, createCluster, type RedisClientType, type RedisClusterType } from "redis";

import {
  APPLICATION_CONFIG,
  type ApplicationConfig,
  type RedisConfig,
  readSecretFile,
} from "../config/index.js";
import { parseResolvedRedisUrls } from "../config/infrastructure-config-loader.js";
import { ConfigurationError } from "../config/configuration-error.js";
import { DependencyHealthRegistry, type HealthIndicator } from "../health/index.js";
import { StructuredLogger } from "../observability/index.js";

/** Supported node-redis connection shape for standalone and Cluster deployments. */
export type RedisConnectionClient = RedisClientType | RedisClusterType;

/** Owns isolated command, publisher and subscriber Redis connections for one process. */
@Injectable()
export class RedisConnections implements OnModuleInit, OnModuleDestroy {
  private clients:
    readonly [RedisConnectionClient, RedisConnectionClient, RedisConnectionClient] | undefined;
  private unregisterHealth: (() => void) | undefined;

  public constructor(
    @Inject(APPLICATION_CONFIG) private readonly applicationConfig: ApplicationConfig,
    @Inject(DependencyHealthRegistry) private readonly health: DependencyHealthRegistry,
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
  ) {}

  /** Resolves secrets, opens all three connections and verifies Redis before readiness. */
  public async onModuleInit(): Promise<void> {
    const config = this.applicationConfig.redis;
    if (!config.enabled) return;

    const [urls, ca] = await Promise.all([
      this.resolveUrls(config),
      config.tlsCaFile === undefined
        ? Promise.resolve(undefined)
        : readSecretFile(config.tlsCaFile, this.applicationConfig.secrets),
    ]);
    validateTopology(urls, config);
    const suffixes = ["command", "publisher", "subscriber"] as const;
    const clients = suffixes.map((suffix) =>
      createRedisClient(config, urls, ca, `${config.clientName}-${suffix}`),
    ) as unknown as [RedisConnectionClient, RedisConnectionClient, RedisConnectionClient];
    this.clients = clients;

    for (const [index, client] of clients.entries()) {
      client.on("error", (error: unknown) => {
        this.logger.error(
          { event: "redis_client_error", connection: suffixes[index], error },
          RedisConnections.name,
        );
      });
    }

    try {
      await Promise.all(clients.map((client) => client.connect()));
      await Promise.all(clients.map((client) => client.ping()));
    } catch (error) {
      for (const client of clients) client.destroy();
      this.clients = undefined;
      throw error;
    }

    const indicator: HealthIndicator = {
      name: "redis",
      check: (signal) => this.checkHealth(signal),
    };
    this.unregisterHealth = this.health.register(indicator);
  }

  /** Closes every Redis connection without leaving queued work during shutdown. */
  public async onModuleDestroy(): Promise<void> {
    this.unregisterHealth?.();
    this.unregisterHealth = undefined;
    const clients = this.clients;
    this.clients = undefined;
    if (clients === undefined) return;

    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.close();
        } catch {
          client.destroy();
        }
      }),
    );
  }

  /** Returns the general command connection, which must never enter subscriber mode. */
  public get command(): RedisConnectionClient {
    return this.requireClients()[0];
  }

  /** Returns the connection reserved exclusively for publication. */
  public get publisher(): RedisConnectionClient {
    return this.requireClients()[1];
  }

  /** Returns the connection reserved exclusively for subscriptions. */
  public get subscriber(): RedisConnectionClient {
    return this.requireClients()[2];
  }

  private requireClients(): readonly [
    RedisConnectionClient,
    RedisConnectionClient,
    RedisConnectionClient,
  ] {
    if (this.clients === undefined) {
      throw new ConfigurationError("Redis is disabled or has not completed startup");
    }
    return this.clients;
  }

  private async resolveUrls(config: RedisConfig): Promise<readonly string[]> {
    const urls =
      config.connectionUrls ??
      (config.connectionUrlsFile === undefined
        ? undefined
        : parseResolvedRedisUrls(
            await readSecretFile(config.connectionUrlsFile, this.applicationConfig.secrets),
            config.tlsRequired,
          ));
    if (urls === undefined) throw new ConfigurationError("Redis secret source is missing");
    for (const url of urls) parseResolvedRedisUrls(url, config.tlsRequired);
    return urls;
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("health_check_aborted");
    const ping = this.command.ping();
    const abort = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("health_check_aborted")), {
        once: true,
      });
    });
    await Promise.race([ping, abort]);
  }
}

function createRedisClient(
  config: RedisConfig,
  urls: readonly string[],
  ca: string | undefined,
  name: string,
): RedisConnectionClient {
  const socket = {
    connectTimeout: config.connectTimeoutMs,
    reconnectStrategy: (retries: number): number | Error => {
      if (retries >= 20) return new Error("Redis reconnect budget exhausted");
      const exponential = Math.min(config.maxReconnectDelayMs, 50 * 2 ** retries);
      return Math.min(config.maxReconnectDelayMs, exponential + Math.floor(Math.random() * 100));
    },
    ...(config.tlsRequired ? { tls: true as const, rejectUnauthorized: true, ca } : {}),
  };
  const common = {
    name,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1_000,
    commandOptions: { timeout: config.commandTimeoutMs },
    pingInterval: 30_000,
    socket,
  };

  if (config.mode === "standalone") {
    const url = urls[0];
    if (url === undefined) throw new ConfigurationError("Redis standalone requires one seed URL");
    return createClient({ ...common, url });
  }

  const credentials = sharedClusterCredentials(urls);
  return createCluster({
    rootNodes: urls.map((url) => ({ url })),
    defaults: {
      ...common,
      ...credentials,
    },
    maxCommandRedirections: 16,
    minimizeConnections: false,
    useReplicas: false,
  });
}

function sharedClusterCredentials(
  urls: readonly string[],
): Readonly<{ username?: string; password?: string }> {
  const first = new URL(urls[0] ?? "redis://invalid");
  for (const value of urls.slice(1)) {
    const current = new URL(value);
    if (current.username !== first.username || current.password !== first.password) {
      throw new ConfigurationError("Redis Cluster seed credentials must be identical");
    }
  }
  return {
    ...(first.username === "" ? {} : { username: decodeURIComponent(first.username) }),
    ...(first.password === "" ? {} : { password: decodeURIComponent(first.password) }),
  };
}

function validateTopology(urls: readonly string[], config: RedisConfig): void {
  if (config.mode === "standalone" && urls.length !== 1) {
    throw new ConfigurationError("Redis standalone requires exactly one seed URL");
  }
  if (config.mode === "cluster" && urls.length < 3) {
    throw new ConfigurationError("Redis Cluster requires at least three seed URLs");
  }
  for (const value of urls) {
    const url = new URL(value);
    if (url.pathname !== "" && url.pathname !== "/" && url.pathname !== "/0") {
      throw new ConfigurationError("Redis database must be zero");
    }
  }
}
