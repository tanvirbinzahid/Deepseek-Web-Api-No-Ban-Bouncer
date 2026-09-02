import type { AntiBanConfig } from './config.js';
import { loadConfigFromEnv } from './config.js';

export class AntiBanManager {
  private config: AntiBanConfig;
  private authFailStreak = 0;
  private circuitOpenUntil: Date | null = null;
  private completionsToday = 0;
  private completionDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  private warmupCount = 0;
  private warmupStart: Date | null = null;
  private providerStatus: string = 'operational';

  constructor(config?: Partial<AntiBanConfig>) {
    const base = loadConfigFromEnv();
    this.config = { ...base, ...config };
    this.startBackgroundTasks();
  }

  private startBackgroundTasks() {
    // Idle life: simulate a tick every 45-150s
    setInterval(() => {
      console.log('[AntiBan] Idle life tick');
    }, 45000 + Math.random() * 105000);

    // Status monitor: poll statusUrl every interval
    setInterval(() => {
      // In a real implementation, fetch statusUrl and update providerStatus
      // For now, assume operational
      console.log('[AntiBan] Status check: operational');
    }, this.config.outagePollInterval * 1000);
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

  recordAuthFail() {
    this.authFailStreak += 1;
    if (this.authFailStreak >= this.config.authFailLimit) {
      this.circuitOpenUntil = new Date(Date.now() + this.config.circuitCooldown * 1000);
      console.log(`[AntiBan] Circuit opened for ${this.config.circuitCooldown}s`);
    }
  }

  recordAuthOk() {
    this.authFailStreak = 0;
  }

  recordCompletion() {
    this.completionsToday += 1;
    this.warmupCount += 1;
  }

  getConfig(): AntiBanConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<AntiBanConfig>) {
    this.config = { ...this.config, ...newConfig };
    console.log('[AntiBan] Config updated');
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
