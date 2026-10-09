import type { HubClock } from "../clock";

interface ScheduledTask {
  id: number;
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
}

export class ManualClock implements HubClock {
  private currentMilliseconds: number;
  private nextId = 1;
  private readonly tasks: ScheduledTask[] = [];

  constructor(initialSeconds: number) {
    this.currentMilliseconds = initialSeconds * 1_000;
  }

  nowMilliseconds(): number {
    return this.currentMilliseconds;
  }

  setTimeout(callback: () => void, delayMilliseconds: number): number {
    const task: ScheduledTask = {
      id: this.nextId++,
      dueAt: this.currentMilliseconds + Math.max(0, delayMilliseconds),
      callback,
      cancelled: false,
    };
    this.tasks.push(task);
    return task.id;
  }

  clearTimeout(handle: unknown): void {
    const task = this.tasks.find((candidate) => candidate.id === handle);
    if (task) task.cancelled = true;
  }

  advanceMilliseconds(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Invalid fake-clock advance");
    const target = this.currentMilliseconds + milliseconds;
    while (true) {
      const next = this.tasks
        .filter((task) => !task.cancelled && task.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      next.cancelled = true;
      this.currentMilliseconds = next.dueAt;
      next.callback();
    }
    this.currentMilliseconds = target;
  }
}
