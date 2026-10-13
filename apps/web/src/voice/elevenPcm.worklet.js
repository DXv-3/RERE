/* global AudioWorkletProcessor, registerProcessor, sampleRate */
// Average down to 16 kHz, keeping fractional sample weights across render blocks.
class ElevenPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2048);
    this.index = 0;
    this.sum = 0;
    this.weight = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const ratio = sampleRate / 16000;
    for (const sample of channel) {
      let remaining = 1;
      while (remaining > 0.000001) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= ratio - 0.000001) {
          const value = Math.max(-1, Math.min(1, this.sum / ratio));
          this.samples[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = this.weight = 0;
          if (this.index === this.samples.length) {
            this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
            this.samples = new Int16Array(2048);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("eleven-pcm-capture", ElevenPcmCapture);
