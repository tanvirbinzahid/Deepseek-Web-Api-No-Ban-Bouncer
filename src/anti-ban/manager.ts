import type { AntiBanConfig } from './config.js';
import { loadConfigFromEnv } from './config.js';

/**
 * No-Ban Bouncer (Node.js edition): a configurable doorman layer for the
 * completion endpoints. Knobs come from DS_ANTIBAN_* env vars (config.ts)
 * and can be changed at runtime via updateConfig (exposed at /admin/antiban).
 */
export class AntiBanManager {
  private config: AntiBanConfig;
  private authFailStreak = 0;
  private circuitOpenUntil: Date | null = null;
  private holdUntil: Date | null = null;
  private completionsToday = 0;
  private completionDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  private warmupCount = 0;
  private warmupStart: Date | null = null;
  private providerStatus = 'unknown';

  constructor(config?: Partial<AntiBanConfig>) {
    const base = loadConfigFromEnv();
    this.config = { ...base, ...config };
    this.startStatusMonitor();
  }

  private startStatusMonitor(): void {
    const poll = (): void => {
      void this.pollStatus();
    };
    poll();
    const timer = setInterval(poll, Math.max(10, this.config.outagePollInterval) * 1000);
    timer.unref();
  }

  /** Poll the provider status page; hold completions while degraded. */
  private async pollStatus(): Promise<void> {
    try {
      const res = await fetch(this.config.statusUrl, { signal: AbortSignal.timeout(8000) });
      const json = (await res.json()) as { status?: { message?: string } };
      const msg = (json?.status?.message ?? 'operational').toLowerCase();
      const ok = msg.includes('operational') || msg.includes('up');
      this.providerStatus = ok ? 'operational' : 'degraded';
      if (!ok) {
        this.holdUntil = new Date(Date.now() + this.config.outagePollInterval * 1000);
        console.log(`[AntiBan] upstream degraded ("${json?.status?.message}"), holding completions for ${this.config.outagePollInterval}s`);
      } else {
        this.holdUntil = null;
      }
    } catch {
      // A local network error or unreachable status page must not block our own API.
    }
  }

  /** Gate for completion endpoints; other paths always pass. */
  async check(requestPath: string): Promise<{ allowed: boolean; status?: number; response?: Record<string, unknown> }> {
    if (!requestPath.startsWith('/v1/chat') && !requestPath.startsWith('/v1/responses')) {
      return { allowed: true };
    }

    // 1. Circuit breaker (auth failures)
    if (this.circuitOpenUntil && new Date() < this.circuitOpenUntil) {
      return {
        allowed: false,
        status: 503,
        response: {
          error: 'Circuit breaker open. Re-login (pnpm login) and retry after the cooldown.',
          retry_after: Math.ceil((this.circuitOpenUntil.getTime() - Date.now()) / 1000),
        },
      };
    }
    if (this.circuitOpenUntil) {
      this.circuitOpenUntil = null; // cooldown elapsed, reset
    }

    // 2. Outage hold (upstream degraded)
    if (this.holdUntil && new Date() < this.holdUntil) {
      return {
        allowed: false,
        status: 503,
        response: {
          error: 'Upstream degraded; requests are being held.',
          retry_after: Math.ceil((this.holdUntil.getTime() - Date.now()) / 1000),
        },
      };
    }

    // 3. Daily cap (resets at UTC midnight)
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
          error: 'Daily completion cap reached. Try again tomorrow (UTC) or raise DS_ANTIBAN_DAILY_CAP.',
          limit: this.config.dailyCap,
        },
      };
    }

    // 4. Warm-up ramp: space the first N completions between min and max delay
    if (this.config.warmupRequests > 0 && this.warmupCount < this.config.warmupRequests) {
      if (this.warmupStart === null) {
        this.warmupStart = new Date();
      } else {
        const span = Math.max(0, this.config.warmupMaxDelay - this.config.warmupMinDelay);
        const targetGap =
          this.config.warmupRequests > 1
            ? this.config.warmupMinDelay + (span * this.warmupCount) / (this.config.warmupRequests - 1)
            : this.config.warmupMinDelay;
        const elapsed = (Date.now() - this.warmupStart.getTime()) / 1000;
        if (elapsed < targetGap) {
          await new Promise((resolve) => setTimeout(resolve, (targetGap - elapsed) * 1000));
        }
      }
    }

    return { allowed: true };
  }

  recordAuthFail(): void {
    this.authFailStreak += 1;
    if (this.authFailStreak >= this.config.authFailLimit) {
      this.circuitOpenUntil = new Date(Date.now() + this.config.circuitCooldown * 1000);
      console.log(`[AntiBan] circuit open for ${this.config.circuitCooldown}s after ${this.authFailStreak} auth failures`);
    }
  }

  recordAuthOk(): void {
    this.authFailStreak = 0;
  }

  recordCompletion(): void {
    this.completionsToday += 1;
    this.warmupCount += 1;
  }

  getConfig(): AntiBanConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<AntiBanConfig>): void {
    this.config = { ...this.config, ...updates };
    console.log('[AntiBan] config updated:', JSON.stringify(updates));
  }

  getStatus(): Record<string, unknown> {
    return {
      circuitOpen: this.circuitOpenUntil !== null,
      circuitOpenUntil: this.circuitOpenUntil ? this.circuitOpenUntil.toISOString() : null,
      holdUntil: this.holdUntil ? this.holdUntil.toISOString() : null,
      authFailStreak: this.authFailStreak,
      completionsToday: this.completionsToday,
      dailyCap: this.config.dailyCap,
      warmupRemaining: Math.max(0, this.config.warmupRequests - this.warmupCount),
      providerStatus: this.providerStatus,
    };
  }
}
