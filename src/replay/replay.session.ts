import { ReplayEvent, ReplayOptions } from './replay.types';

export class ReplaySession {
  private cursor = 0;
  private playing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly events: ReplayEvent[],
    private readonly options: ReplayOptions,
    private readonly emitToSystem: (e: ReplayEvent) => void,
  ) {}

  start() {
    if (this.playing) return;
    this.playing = true;
    this.tick();
  }

  stop() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private tick() {
    if (!this.playing) return;

    if (this.cursor >= this.events.length) {
      this.stop();
      return;
    }

    const event = this.events[this.cursor];
    const nextEvent = this.events[this.cursor + 1];

    this.emitToSystem(event);

    this.cursor++;

    if (!nextEvent) {
      this.stop();
      return;
    }

    const delta = nextEvent.ts - event.ts;
    const delay = delta / (this.options.speed ?? 1);

    this.timer = setTimeout(() => this.tick(), Math.max(1, delay));
  }
}
