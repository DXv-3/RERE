import captureUrl from "./elevenPcm.worklet.js?url&no-inline";

export interface ElevenAudio {
  start(onChunk: (base64: string) => void): Promise<void>;
  play(base64: string): void;
  interrupt(): void;
  mute(muted: boolean): void;
  resume(): Promise<void>;
  dispose(): void;
}

export function pcm16Samples(base64: string): Float32Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (bytes.length % 2) throw new Error("Invalid PCM audio");
  const view = new DataView(bytes.buffer);
  return Float32Array.from(
    { length: bytes.length / 2 },
    (_, index) => view.getInt16(index * 2, true) / 32768,
  );
}

/** Microphone and playback belong to one call. No captured audio is persisted. */
export function createElevenAudio(): ElevenAudio {
  const context = new AudioContext();
  let stream: MediaStream | undefined;
  let capture: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  let muted = false;
  let nextTime = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const interrupt = () => {
    for (const node of playing) {
      node.stop();
      node.disconnect();
    }
    playing.clear();
    nextTime = 0;
  };
  return {
    async start(onChunk) {
      await context.resume();
      if (closed) return;
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (closed) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      await context.audioWorklet.addModule(captureUrl);
      if (closed) return;
      source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, "eleven-pcm-capture");
      capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (closed) return;
        // The worklet produces signed PCM, little endian on supported client platforms.
        const bytes = new Uint8Array(event.data);
        onChunk(btoa(String.fromCharCode(...bytes)));
      };
      source.connect(capture);
      // The processor leaves its output silent; connecting it keeps capture rendering.
      capture.connect(context.destination);
    },
    play(base64) {
      if (closed) return;
      const samples = pcm16Samples(base64);
      if (!samples.length) return;
      if (nextTime > context.currentTime + 120) throw new Error("Speech queue is full");
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      playing.add(node);
      node.onended = () => {
        playing.delete(node);
        node.disconnect();
      };
      const start = Math.max(context.currentTime + 0.03, nextTime);
      nextTime = start + buffer.duration;
      node.start(start);
    },
    interrupt,
    mute(value) {
      muted = value;
      stream?.getAudioTracks().forEach((track) => {
        track.enabled = !value;
      });
    },
    resume: () => context.resume(),
    dispose() {
      if (closed) return;
      closed = true;
      interrupt();
      stream?.getTracks().forEach((track) => track.stop());
      source?.disconnect();
      if (capture) {
        capture.port.onmessage = null;
        capture.port.close();
        capture.disconnect();
      }
      void context.close();
    },
  };
}
