// src/tools/bash/output-buffer.ts
/** Collects streamed output, keeping only the first and last `limit / 2` characters. */
export class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  constructor(private readonly limit = 30_000) {}

  get truncated(): boolean {
    return this.dropped > 0;
  }

  push(chunk: string): void {
    const half = Math.floor(this.limit / 2);
    if (this.head.length < half) {
      const take = half - this.head.length;
      this.head += chunk.slice(0, take);
      chunk = chunk.slice(take);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > half) {
      this.dropped += this.tail.length - half;
      this.tail = this.tail.slice(-half);
    }
  }

  toString(): string {
    if (!this.truncated) return this.head + this.tail;
    return `${this.head}\n… [${this.dropped} characters truncated] …\n${this.tail}`;
  }
}
