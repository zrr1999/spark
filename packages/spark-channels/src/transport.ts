import type { ChannelTransport } from "./types.ts";

export class FakeChannelTransport implements ChannelTransport {
  readonly sent: Array<{ recipient: string; text: string }> = [];
  private handler?: (raw: unknown) => void;
  private queued: unknown[] = [];
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async start(onMessage: (raw: unknown) => void): Promise<void> {
    this.handler = onMessage;
    this.running = true;
    for (const raw of this.queued.splice(0)) {
      onMessage(raw);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
  }

  async send(recipient: string, text: string): Promise<void> {
    this.sent.push({ recipient, text });
  }

  /** Push a synthetic inbound payload (for tests). */
  emitInbound(raw: unknown): void {
    if (this.handler) {
      this.handler(raw);
      return;
    }
    this.queued.push(raw);
  }
}
