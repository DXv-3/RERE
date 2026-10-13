import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";

import source from "./elevenPcm.worklet.js?raw";
it.each([16000, 44100, 48000])(
  "captures 16 kHz PCM across render blocks from %i Hz input",
  (sampleRate) => {
    const output: ArrayBuffer[] = [];
    let Processor!: new () => { process(inputs: Float32Array[][]): boolean };
    NodeVM.runInNewContext(source, {
      AudioWorkletProcessor: class {
        port = { postMessage: (buffer: ArrayBuffer) => output.push(buffer) };
      },
      registerProcessor: (_name: string, constructor: typeof Processor) => {
        Processor = constructor;
      },
      sampleRate,
    });
    const processor = new Processor();
    // Half a second, divided into the browser's 128-sample render blocks.
    for (let i = 0; i < sampleRate / 2; i += 128) {
      const block = new Float32Array(Math.min(128, sampleRate / 2 - i)).fill(0.5);
      expect(processor.process([[block]])).toBe(true);
    }
    expect(output).toHaveLength(3); // 8000 output samples = 3 full 2048-sample chunks plus a remainder.
    for (const chunk of output) {
      expect(new Int16Array(chunk).length).toBe(2048);
      expect([...new Int16Array(chunk)].every((value) => Math.abs(value - 16384) <= 1)).toBe(true);
    }
  },
);
