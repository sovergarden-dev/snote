import type { HubClock } from "./clock";

export interface HubRateLimits {
  maxConcurrentSocketsPerAddress: number;
  maxConnectionAttemptsPerAddressPerMinute: number;
  maxMessagesPerSecondPerSocket: number;
}

export const DEFAULT_HUB_RATE_LIMITS: Readonly<HubRateLimits> = {
  maxConcurrentSocketsPerAddress: 32,
  maxConnectionAttemptsPerAddressPerMinute: 120,
  maxMessagesPerSecondPerSocket: 120,
};

interface AddressWindow {
  windowStartedAt: number;
  attempts: number;
  activeSockets: number;
}

interface MessageWindow {
  windowStartedAt: number;
  messages: number;
}

export class InMemoryHubRateLimiter {
  private readonly addresses = new Map<string, AddressWindow>();
  private readonly messageWindows = new Map<object, MessageWindow>();

  constructor(
    private readonly clock: HubClock,
    private readonly limits: HubRateLimits = DEFAULT_HUB_RATE_LIMITS,
  ) {}

  tryOpen(address: string): (() => void) | undefined {
    const now = this.clock.nowMilliseconds();
    const key = address || "unknown";
    let window = this.addresses.get(key);
    if (!window) {
      window = { windowStartedAt: now, attempts: 0, activeSockets: 0 };
      this.addresses.set(key, window);
    } else if (now - window.windowStartedAt >= 60_000) {
      window.windowStartedAt = now;
      window.attempts = 0;
    }

    if (
      window.attempts >= this.limits.maxConnectionAttemptsPerAddressPerMinute
      || window.activeSockets >= this.limits.maxConcurrentSocketsPerAddress
    ) {
      return undefined;
    }
    window.attempts += 1;
    window.activeSockets += 1;
    this.pruneAddressWindows(now);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      window!.activeSockets = Math.max(0, window!.activeSockets - 1);
      this.pruneAddressWindows(this.clock.nowMilliseconds());
    };
  }

  allowMessage(socket: object): boolean {
    const now = this.clock.nowMilliseconds();
    const window = this.messageWindows.get(socket);
    if (!window || now - window.windowStartedAt >= 1_000) {
      this.messageWindows.set(socket, { windowStartedAt: now, messages: 1 });
      return true;
    }
    window.messages += 1;
    return window.messages <= this.limits.maxMessagesPerSecondPerSocket;
  }

  removeSocket(socket: object): void {
    this.messageWindows.delete(socket);
  }

  private pruneAddressWindows(now: number): void {
    for (const [address, window] of this.addresses) {
      if (window.activeSockets === 0 && now - window.windowStartedAt >= 60_000) {
        this.addresses.delete(address);
      }
    }
    if (this.addresses.size > 4_096) {
      for (const [address, window] of this.addresses) {
        if (window.activeSockets === 0) this.addresses.delete(address);
        if (this.addresses.size <= 3_072) break;
      }
    }
  }
}
