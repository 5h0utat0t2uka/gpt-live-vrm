// Short closure, a brief fully closed phase, then a slower opening.
export class AvatarBlink {
  private wait: number;
  private elapsed: number | null = null;
  private random: () => number;

  constructor(random = Math.random) {
    this.random = random;
    this.wait = 2 + this.random() * 4;
  }

  update(delta: number) {
    if (this.elapsed === null) {
      this.wait -= delta;
      if (this.wait > 0) return 0;
      this.elapsed = -this.wait;
    } else {
      this.elapsed += delta;
    }
    if (this.elapsed >= 0.28) {
      this.elapsed = null;
      this.wait = 2 + this.random() * 4;
      return 0;
    }
    const progress = this.elapsed < 0.08 ? this.elapsed / 0.08 : (0.28 - this.elapsed) / 0.16;
    const clamped = Math.min(1, Math.max(0, progress));
    return clamped * clamped * (3 - 2 * clamped);
  }
}
