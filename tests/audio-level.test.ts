import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AudioLevel, mouthLevel } from "../src/lib/audio-level.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "AudioContext", descriptor);
  else Reflect.deleteProperty(globalThis, "AudioContext");
});

test("mouth level closes for silence and quiet noise, follows RMS and clamps loud input", () => {
  assert.equal(mouthLevel(new Float32Array()), 0);
  assert.equal(mouthLevel(new Float32Array([0, 0, 0])), 0);
  assert.equal(mouthLevel(new Float32Array([0.001, -0.001])), 0);
  assert.ok(Math.abs(mouthLevel(new Float32Array([0.05, -0.05])) - 0.378) < 0.001);
  assert.equal(mouthLevel(new Float32Array([1, -1])), 1);
});

test("meter observes only the attached stream, never plays a second audio copy, and releases resources", async () => {
  const connections: unknown[] = [];
  let sourceDisconnects = 0;
  let analyserDisconnects = 0;
  let closed = 0;
  let attached: unknown;
  const analyser = {
    fftSize: 0,
    getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.05),
    disconnect: () => {
      analyserDisconnects++;
    },
  };
  class Context {
    state = "running";
    createAnalyser() {
      return analyser;
    }
    createMediaStreamSource(stream: unknown) {
      attached = stream;
      return {
        connect: (target: unknown) => connections.push(target),
        disconnect: () => {
          sourceDisconnects++;
        },
      };
    }
    async resume() {}
    async close() {
      closed++;
      this.state = "closed";
    }
  }
  Object.defineProperty(globalThis, "AudioContext", { value: Context, configurable: true });
  const meter = new AudioLevel();
  meter.start();
  assert.equal(meter.read(), 0);
  const stream = {} as MediaStream;
  meter.attach(stream);
  assert.equal(attached, stream);
  assert.deepEqual(connections, [analyser]);
  assert.ok(meter.read() > 0);
  meter.attach({} as MediaStream);
  assert.equal(sourceDisconnects, 1);
  meter.dispose();
  meter.dispose();
  assert.equal(sourceDisconnects, 2);
  assert.equal(analyserDisconnects, 1);
  assert.equal(closed, 1);
  assert.equal(meter.read(), 0);
});

test("unsupported Web Audio or a rejected resume does not break voice playback", async () => {
  Object.defineProperty(globalThis, "AudioContext", { value: undefined, configurable: true });
  const unsupported = new AudioLevel();
  unsupported.start();
  unsupported.attach({} as MediaStream);
  assert.equal(unsupported.read(), 0);
  unsupported.dispose();
  class SuspendedContext {
    state = "suspended";
    createAnalyser() {
      return { fftSize: 0, disconnect() {} };
    }
    async resume() {
      throw new Error("blocked");
    }
    async close() {}
  }
  Object.defineProperty(globalThis, "AudioContext", { value: SuspendedContext, configurable: true });
  const meter = new AudioLevel();
  meter.start();
  await Promise.resolve();
  assert.equal(meter.read(), 0);
  meter.dispose();
});
