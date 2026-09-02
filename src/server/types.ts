/** Dependency contract injected into the HTTP routing layer. */
import type { DeepSeekClient } from "../deepseek/client.js";
import type { AntiBanManager } from "../anti-ban/index.js";

export interface ServerDependencies {
  client: DeepSeekClient;
  apiKeys: readonly string[];
  debug: boolean;
  antiBan?: AntiBanManager;
}
