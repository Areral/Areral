/** Procedural wind (filtered brown noise with a slow gust LFO) — no audio files, no third-party requests. */
export function createWind() {
  let ctx = null;
  let gain = null;
  let on = false;

  function build() {
    ctx = new AudioContext();
    const seconds = 6;
    const len = seconds * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last * 3.5;
    }
    const fade = Math.floor(ctx.sampleRate * 0.5); // crossfade the loop seam
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[len - fade + i] = data[len - fade + i] * (1 - t) + data[i] * t;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = fade / ctx.sampleRate;
    src.loopEnd = seconds;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const depth = ctx.createGain();
    depth.gain.value = 260;
    lfo.connect(depth).connect(filter.frequency);
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    lfo.start();
  }

  function set(value) {
    on = value;
    try {
      if (!ctx) build();
      if (ctx.state === 'suspended') ctx.resume();
      gain.gain.setTargetAtTime(on ? 0.32 : 0, ctx.currentTime, 0.4);
    } catch {
      on = false;
    }
    return on;
  }

  return { set, toggle: () => set(!on), get on() { return on; } };
}
