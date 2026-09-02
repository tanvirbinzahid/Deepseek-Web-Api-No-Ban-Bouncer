import { env } from 'node:process';

export interface AntiBanConfig {
  warmupRequests: number;
  warmupMinDelay: number; // seconds
  warmupMaxDelay: number; // seconds
  authFailLimit: number;
  circuitCooldown: number; // seconds
  dailyCap: number;
  outagePollInterval: number; // seconds
  statusUrl: string;
  sessionReuse: boolean;
}

const DEFAULT_CONFIG: AntiBanConfig = {
  warmupRequests: 10,
  warmupMinDelay: 90,
  warmupMaxDelay: 180,
  authFailLimit: 3,
  circuitCooldown: 3600,
  dailyCap: 150,
  outagePollInterval: 300,
  statusUrl: 'https://status.deepseek.com/api/v2/status.json',
  sessionReuse: true,
};

function getEnvInt(key: string, fallback: number): number {
  const val = env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function getEnvBool(key: string, fallback: boolean): boolean {
  const val = env[key];
  if (val === undefined) return fallback;
  return val === '1' || val.toLowerCase() === 'true';
}

function getEnvString(key: string, fallback: string): string {
  return env[key] || fallback;
}

export function loadConfigFromEnv(): AntiBanConfig {
  return {
    warmupRequests: getEnvInt('DS_ANTIBAN_WARMUP_REQUESTS', DEFAULT_CONFIG.warmupRequests),
    warmupMinDelay: getEnvInt('DS_ANTIBAN_WARMUP_MIN_DELAY', DEFAULT_CONFIG.warmupMinDelay),
    warmupMaxDelay: getEnvInt('DS_ANTIBAN_WARMUP_MAX_DELAY', DEFAULT_CONFIG.warmupMaxDelay),
    authFailLimit: getEnvInt('DS_ANTIBAN_AUTH_FAIL_LIMIT', DEFAULT_CONFIG.authFailLimit),
    circuitCooldown: getEnvInt('DS_ANTIBAN_CIRCUIT_COOLDOWN', DEFAULT_CONFIG.circuitCooldown),
    dailyCap: getEnvInt('DS_ANTIBAN_DAILY_CAP', DEFAULT_CONFIG.dailyCap),
    outagePollInterval: getEnvInt('DS_ANTIBAN_OUTAGE_POLL_INTERVAL', DEFAULT_CONFIG.outagePollInterval),
    statusUrl: getEnvString('DS_ANTIBAN_STATUS_URL', DEFAULT_CONFIG.statusUrl),
    sessionReuse: getEnvBool('DS_ANTIBAN_SESSION_REUSE', DEFAULT_CONFIG.sessionReuse),
  };
}
