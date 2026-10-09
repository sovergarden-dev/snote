export type HubTimerHandle = unknown;

export interface HubClock {
  nowMilliseconds(): number;
  setTimeout(callback: () => void, delayMilliseconds: number): HubTimerHandle;
  clearTimeout(handle: HubTimerHandle): void;
}

export const systemHubClock: HubClock = {
  nowMilliseconds: () => Date.now(),
  setTimeout: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function nowSeconds(clock: HubClock): number {
  return Math.floor(clock.nowMilliseconds() / 1_000);
}
