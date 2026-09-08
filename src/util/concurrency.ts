// Small concurrency-limited map, shared by anything that fans out many
// per-item Canvas requests (file downloads, per-id lookups, etc.) without
// hand-rolling its own worker pool each time.

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
export async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
