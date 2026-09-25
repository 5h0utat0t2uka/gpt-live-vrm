import assert from "node:assert/strict";
import { test } from "node:test";
import { AvatarBlink } from "../src/lib/avatar-blink.ts";

test("blink closes briefly then opens more slowly, with variable intervals", () => {
  const intervals = [0, 1];
  const blink = new AvatarBlink(() => intervals.shift() ?? 0.5);
  assert.equal(blink.update(1.99), 0);
  const halfClosed = blink.update(0.05);
  assert.ok(Math.abs(halfClosed - 0.5) < 0.001);
  assert.equal(blink.update(0.05), 1);
  assert.equal(blink.update(0.02), 1);
  const halfOpen = blink.update(0.09);
  assert.ok(Math.abs(halfOpen - 0.5) < 0.001);
  assert.equal(blink.update(0.09), 0);
  assert.equal(blink.update(5.99), 0);
  assert.ok(blink.update(0.02) > 0);
});

test("blink weights stay bounded and resume open after a long gap", () => {
  const blink = new AvatarBlink(() => 0.5);
  for (let i = 0; i < 1000; i++) {
    const value = blink.update(1 / 30);
    assert.ok(value >= 0 && value <= 1);
  }
  assert.equal(blink.update(100), 0);
  assert.equal(blink.update(0.01), 0);
});
