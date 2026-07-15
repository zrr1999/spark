import type { ChannelInteractionCapability, ChannelInteractionEvent } from "./interaction.ts";
import type { ChannelTransport, ChannelTransportStatus } from "./types.ts";

export class FakeChannelTransport implements ChannelTransport {
  readonly sent: Array<{ recipient: string; text: string }> = [];
  readonly interaction?: ChannelInteractionCapability;
  private handler?: (raw: unknown) => void;
  private interactionHandler?: (event: ChannelInteractionEvent) => void | Promise<void>;
  private queued: unknown[] = [];
  private running = false;

  constructor(options: { interaction?: ChannelInteractionCapability } = {}) {
    this.interaction = options.interaction;
  }

  get isRunning(): boolean {
    return this.running;
  }

  status(): ChannelTransportStatus {
    return { state: this.running ? ("connected" as const) : ("stopped" as const) };
  }

  async start(
    onMessage: (raw: unknown) => void,
    onInteraction?: (event: ChannelInteractionEvent) => void | Promise<void>,
  ): Promise<void> {
    this.handler = onMessage;
    this.interactionHandler = onInteraction;
    this.running = true;
    for (const raw of this.queued.splice(0)) {
      onMessage(raw);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.handler = undefined;
    this.interactionHandler = undefined;
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

  /** Push a synthetic native interaction (for tests). */
  async emitInteraction(event: ChannelInteractionEvent): Promise<void> {
    await this.interactionHandler?.(event);
  }
}
