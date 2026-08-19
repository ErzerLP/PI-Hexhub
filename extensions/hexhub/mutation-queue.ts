export class KeyedMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const previousSettled = this.ignoreFailure(previous);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = this.waitForRelease(previousSettled, current);
    this.tails.set(key, tail);
    await previousSettled;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  get pendingKeys(): number {
    return this.tails.size;
  }

  private async ignoreFailure(promise: Promise<void>): Promise<void> {
    try {
      await promise;
    } catch {
      // A failed mutation must not block later work for the same target.
    }
  }

  private async waitForRelease(
    previous: Promise<void>,
    current: Promise<void>,
  ): Promise<void> {
    await previous;
    await current;
  }
}
