import { AntiBanConfig, loadConfigFromEnv } from './config.js';
import { logger } from '../utils/logger.js';

export class AntiBanManager {
  private config: AntiBanConfig;
  private authFailStreak = 0;
  private circuitOpenUntil: Date | null = null;
  private completionsToday = 0;
  private completionDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  private warmupCount = 0;
  private warmupStart: Date | null = null;
  private lock: Promise<void> | null = null;
  private idleLifeInterval: NodeJS.Timeout | null = null;
  private statusCheckInterval: NodeJS.Timeout | null = null;
  private providerStatus: string = 'operational';

  constructor(config?: Partial<AntiBanConfig>) {
    const base = loadConfigFromEnv();
    this.config = { ...base, ...config };
    this.startBackgroundTasks();
  }

  private startBackgroundTasks() {
    // Idle life: simulate a tick every 45-150s
    this.idleLifeInterval = setInterval(() => {
      logger.debug('[AntiBan] Idle life tick');
    }, 45000 + Math.random() * 105000);

    // Status monitor: poll statusUrl every interval
    this.statusCheckInterval = setInterval(() => {
      // In a real implementation, fetch statusUrl and update providerStatus
      // For now, assume operational
      logger.debug('[AntiBan] Status check: operational');
    }, this.config.outagePollInterval * 1000);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prevLock = this.lock;
    const unlock = () => { this.lock = null; };
    const newLock = (prevLock ? prevLock.then(() => fn()) : fn()).finally(unlock);
    this.lock = newLock;
    return newLock;
  }

  async check(requestPath: string): Promise<{ allowed: boolean; status?: number; response?: any }> {
    // Only apply to completion endpoints
    if (!requestPath.startsWith('/v1/chat') && !requestPath.startsWith('/v1/responses')) {
      return { allowed: true };
    }

    // Circuit breaker
    if (this.circuitOpenUntil && new Date() < this.circuitOpenUntil) {
      return {
        allowed: false,
        status: 503,
        response: {
          error: 'Circuit breaker open. Please re-login and restart.',
          retry_after: Math.ceil((this.circuitOpenUntil.getTime() - Date.now()) / 1000),
        },
      };
    }
    if (this.circuitOpenUntil) {
      this.circuitOpenUntil = null; // reset
    }

    // Daily cap
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.completionDate) {
      this.completionDate = today;
      this.completionsToday = 0;
    }
    if (this.completionsToday >= this.config.dailyCap) {
      return {
        allowed: false,
        status: 429,
        response: {
          error: 'Daily cap reached. Please try again tomorrow.',
          limit: this.config.dailyCap,
        },
      };
    }

    // Warm-up ramp
    if (this.config.warmupRequests > 0 && this.warmupCount < this.config.warmupRequests) {
      if (!this.warmupStart) {
        this.warmupStart = new Date();
      } else {
        const elapsed = (Date.now() - this.warmupStart.getTime()) / 1000;
        const minDelay = this.config.warmupMinDelay;
        if (elapsed < minDelay) {
          const wait = (minDelay - elapsed) * 1000;
          await new Promise(resolve => setTimeout(resolve, wait));
        }
      }
    }

    return { allowed: true };
  }

  async recordAuthFail() {
    await this.withLock(async () => {
      this.authFailStreak += 1;
      if (this.authFailStreak >= this.config.authFailLimit) {
        this.circuitOpenUntil = new Date(Date.now() + this.config.circuitCooldown * 1000);
        logger.warn(`[AntiBan] Circuit opened for ${this.config.circuitCooldown}s`);
      }
    });
  }

  async recordAuthOk() {
    await this.withLock(async () => {
      this.authFailStreak = 0;
    });
  }

  async recordCompletion() {
    await this.withLock(async () => {
      this.completionsToday += 1;
      this.warmupCount += 1;
    });
  }

  getConfig(): AntiBanConfig {
    return { ...this.config };
  }

  async updateConfig(newConfig: Partial<AntiBanConfig>) {
    await this.withLock(async () => {
      this.config = { ...this.config, ...newConfig };
      logger.info('[AntiBan] Config updated');
    });
  }

  getStatus() {
    return {
      circuitOpen: this.circuitOpenUntil !== null,
      circuitOpenUntil: this.circuitOpenUntil ? this.circuitOpenUntil.toISOString() : null,
      authFailStreak: this.authFailStreak,
      completionsToday: this.completionsToday,
      dailyCap: this.config.dailyCap,
      warmupRemaining: Math.max(0, this.config.warmupRequests - this.warmupCount),
      providerStatus: this.providerStatus,
    };
  }
}
