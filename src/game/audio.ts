type SoundName = 'block' | 'gift' | 'lead' | 'countdown' | 'victory' | 'round';

export class GameAudio {
  private context: AudioContext | null = null;
  private enabled = true;
  private lastPlayed = new Map<SoundName, number>();

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  async unlock(): Promise<boolean> {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    return this.context.state === 'running';
  }

  isReady(): boolean {
    return this.context?.state === 'running';
  }

  play(name: SoundName): void {
    if (!this.enabled || !this.isReady() || !this.context) return;
    const now = performance.now();
    const cooldown = name === 'block' ? 80 : name === 'countdown' ? 500 : 200;
    if (now - (this.lastPlayed.get(name) ?? 0) < cooldown) return;
    this.lastPlayed.set(name, now);

    const notes: Record<SoundName, Array<[number, number, OscillatorType, number]>> = {
      block: [[155, 0.07, 'square', 0.08], [95, 0.12, 'sine', 0.1]],
      gift: [[523, 0.08, 'sine', 0.07], [784, 0.13, 'sine', 0.06]],
      lead: [[392, 0.08, 'triangle', 0.06], [587, 0.11, 'triangle', 0.06]],
      countdown: [[440, 0.12, 'square', 0.05]],
      victory: [[392, 0.12, 'triangle', 0.09], [523, 0.15, 'triangle', 0.09], [659, 0.28, 'triangle', 0.1]],
      round: [[262, 0.1, 'sine', 0.06], [392, 0.14, 'sine', 0.07], [523, 0.2, 'sine', 0.08]],
    };
    let offset = 0;
    for (const [frequency, duration, type, volume] of notes[name]) {
      this.tone(frequency, duration, type, volume, offset);
      offset += duration * 0.62;
    }
  }

  private tone(frequency: number, duration: number, type: OscillatorType, volume: number, offset: number): void {
    if (!this.context) return;
    const start = this.context.currentTime + offset;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(50, frequency * 0.75), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}

export const gameAudio = new GameAudio();
