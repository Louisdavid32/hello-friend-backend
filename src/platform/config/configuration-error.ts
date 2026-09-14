/** Reports an invalid or security-incompatible process configuration. */
export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}
