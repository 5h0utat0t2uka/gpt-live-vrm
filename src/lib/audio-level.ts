// Observe the received stream without routing a second copy to the speakers.
export class AudioLevel {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private samples = new Float32Array(1024);

  start() {
    try {
      if (!this.context && typeof AudioContext !== "undefined") {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = this.samples.length;
      }
      this.resume();
    } catch {
      // Visual enhancement only: audio playback must remain available.
      this.dispose();
    }
  }

  resume() {
    if (this.context && this.context.state !== "closed") {
      void this.context.resume().catch(() => {});
    }
  }

  attach(stream: MediaStream) {
    this.source?.disconnect();
    this.source = null;
    if (!this.context || !this.analyser) return;
    try {
      this.source = this.context.createMediaStreamSource(stream);
      this.source.connect(this.analyser);
    } catch {
      this.dispose();
    }
  }

  read() {
    if (!this.source || !this.analyser || this.context?.state !== "running") return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return mouthLevel(this.samples);
  }

  dispose() {
    this.source?.disconnect();
    this.analyser?.disconnect();
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.source = null;
    this.analyser = null;
    this.context = null;
  }
}

export function mouthLevel(samples: Float32Array) {
  if (!samples.length) return 0;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / samples.length);
  // Ignore quiet noise; ordinary speech reaches a useful range without clipping.
  return Math.min(1, Math.max(0, (rms - 0.008) * 9));
}
