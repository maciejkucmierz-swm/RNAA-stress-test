import * as API from "react-native-audio-api";
import { SessionScope } from "../workshop/session";
import {
  BlockedError,
  manual,
  type Outcome,
  type Settings,
} from "../workshop/types";
import type { BackendSnapshot, Emit, GraphEnvironment } from "./contracts";
import type { AudioEngine } from "./engine";
import { loadFixture } from "./inputs";
import {
  bindBufferEvents,
  json,
  n,
  nodeOptions,
  ramp,
  str,
  summary,
} from "./utils";
import { startWorklet } from "./worklets";
export function analyser(
  engine: AudioEngine,
  node: API.AudioNode,
  env: GraphEnvironment,
  s: Settings,
) {
  const analyser = env.track(
    new API.AnalyserNode(env.context, {
      ...nodeOptions(s),
      fftSize: n(s, "fftSize", 2048),
      minDecibels: n(s, "minDb", -100),
      maxDecibels: n(s, "maxDb", -30),
      smoothingTimeConstant: n(s, "smoothing", 0.8),
    }),
  );
  node.connect(analyser);
  let wave = new Float32Array(analyser.fftSize);
  let spectrum = new Uint8Array(analyser.frequencyBinCount);
  let floatSpectrum = new Float32Array(analyser.frequencyBinCount);
  let byteWave = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    if (!env.scope.alive) return;
    try {
      if (wave.length !== analyser.fftSize) {
        wave = new Float32Array(analyser.fftSize);
        byteWave = new Uint8Array(analyser.fftSize);
        spectrum = new Uint8Array(analyser.frequencyBinCount);
        floatSpectrum = new Float32Array(analyser.frequencyBinCount);
      }
      analyser.getFloatTimeDomainData(wave);
      if (!wave.every(Number.isFinite))
        throw new Error("Analyser returned non-finite time-domain samples.");
      analyser.getByteFrequencyData(spectrum);
      analyser.getFloatFrequencyData(floatSpectrum);
      analyser.getByteTimeDomainData(byteWave);
      engine.state.plot = {
        waveform: Array.from(
          { length: 128 },
          (_, i) => wave[Math.floor((i * wave.length) / 128)],
        ),
        spectrum: Array.from(
          { length: 64 },
          (_, i) => spectrum[Math.floor((i * spectrum.length) / 64)] / 255,
        ),
      };
      engine.notify();
    } catch (error) {
      clearInterval(timer);
      if (env.scope.alive) engine.backend.onSessionError(env.scope, error);
    }
  }, 100);
  env.scope.defer(() => clearInterval(timer));
  return analyser;
}

export async function bufferSource(
  engine: AudioEngine,
  s: Settings,
  env: GraphEnvironment,
) {
  const buffer = await loadFixture(s, env.context, env.scope);
  const source = env.track(
    env.context.createBufferSource({ pitchCorrection: !!s.pitchCorrection }),
  );
  source.buffer = buffer;
  env.bindSource(source);
  env.scope.defer(
    bindBufferEvents(source, env.emit, n(s, "positionInterval", 100)),
  );
  source.playbackRate.value = n(s, "playbackRate", 1);
  source.detune.value = n(s, "detune");
  env.emit("buffer", summary(buffer));
  env.emit("pitchLatency", source.getLatency());
  return source;
}

export async function startGraph(
  engine: AudioEngine,
  id: string,
  action: string,
  s: Settings,
  scope: SessionScope,
  emit: Emit,
): Promise<Outcome> {
  const env = engine.environment(s, scope, emit, action === "start");
  const { context: ctx, track, output, tone } = env;
  await scope.hold(ctx.resume());
  scope.ensureActive();
  if (id.startsWith("worklet-") || ["streamer"].includes(id))
    return startWorklet(id, action, s, env);
  if (id === "queue") {
    const queue = track(
      ctx.createBufferQueueSource({ pitchCorrection: !!s.pitchCorrection }),
    );
    env.bindSource(queue, true);
    const pending = new Map<string, string>();
    let queueState: "playing" | "paused" = "playing";
    let published: BackendSnapshot["queue"];
    const publishQueue = () => {
      if (!scope.alive) return;
      published = {
        state: pending.size ? queueState : "empty",
        queuedBuffers: pending.size,
        currentFixture: pending.values().next().value ?? null,
      };
      engine.state.queue = published;
      emit("queueState", published);
      engine.notify();
    };
    scope.defer(() => {
      if (engine.state.queue === published) {
        engine.state.queue = null;
        engine.notify();
      }
    });
    scope.defer(
      bindBufferEvents(
        queue,
        (name, value) => {
          if (!scope.alive) return;
          if (name === "onBufferEnded" || name === "onbufferended") {
            pending.delete(
              String(
                (
                  value as {
                    bufferId: string;
                  }
                ).bufferId,
              ),
            );
            publishQueue();
          }
          emit(name, value);
        },
        100,
      ),
    );
    const buffer = await loadFixture(s, ctx, scope);
    const fixture = str(s, "fixture", "stereo.wav");
    const cache = new Map([[fixture, buffer]]);
    const ids = [queue.enqueueBuffer(buffer), queue.enqueueBuffer(buffer)];
    for (const id of ids) pending.set(id, fixture);
    queue.playbackRate.value = n(s, "playbackRate", 1);
    queue.detune.value = n(s, "detune");
    queue.connect(output);
    emit("queueIDs", [...ids]);
    if (action === "default-start") queue.start();
    else queue.start(ctx.currentTime, n(s, "offset"));
    publishQueue();
    engine.setControls(id, scope, {
      pause: async () => {
        if (!pending.size)
          throw new BlockedError(
            "The queue is empty. Press Play to load the selected file again.",
          );
        queue.pause();
        await scope.hold(ctx.suspend());
        queueState = "paused";
        publishQueue();
      },
      resume: async (value) => {
        if (!pending.size)
          throw new BlockedError(
            "The queue is empty. Resume cannot replay consumed buffers. Press Play to load the selected file again.",
          );
        await scope.hold(ctx.resume());
        scope.ensureActive();
        queue.start(0, n(value, "offset"));
        emit(
          "stableQueueRestart",
          "Explicit offset used; stable resumes by starting again at the selected offset.",
        );
        queueState = "playing";
        publishQueue();
      },
      enqueue: async (value) => {
        const selected = str(value, "fixture", fixture);
        let next = cache.get(selected);
        if (!next) {
          next = await scope.hold(loadFixture(value, ctx, scope));
          scope.ensureActive();
          cache.set(selected, next);
        }
        const nextId = queue.enqueueBuffer(next);
        pending.set(nextId, selected);
        emit("queueBufferEnqueued", {
          bufferId: nextId,
          fixture: selected,
          duration: next.duration,
        });
        emit("queueIDs", [...pending.keys()]);
        publishQueue();
      },
      dequeue: () => {
        const last = [...pending.keys()].at(-1);
        if (last) {
          queue.dequeueBuffer(last);
          pending.delete(last);
        }
        emit("queueIDs", [...pending.keys()]);
        publishQueue();
      },
      clear: () => {
        queue.clearBuffers();
        pending.clear();
        emit("queueCleared");
        publishQueue();
      },
    });
  } else if (id === "buffer-source") {
    const node = await bufferSource(engine, s, env);
    const apply = (value: Settings) => {
      node.playbackRate.value = n(value, "playbackRate", 1);
      node.detune.value = n(value, "detune");
      node.loop = !!value.loop;
      node.loopSkip = !!value.loopSkip;
      node.loopStart = n(value, "loopStart");
      node.loopEnd = n(value, "loopEnd") || node.buffer!.duration;
      emit("settingsApplied", {
        rate: node.playbackRate.value,
        loop: node.loop,
      });
    };
    apply(s);
    node.connect(output);
    node.start(
      ctx.currentTime + n(s, "when"),
      n(s, "offset"),
      s.loop ? undefined : n(s, "duration", 3),
    );
    if (n(s, "stopAfter") > 0) node.stop(ctx.currentTime + n(s, "stopAfter"));
    engine.setControls(id, scope, { apply });
  } else if (id === "graph") {
    const node = await bufferSource(engine, s, env);
    const gain = track(
      new API.GainNode(ctx, {
        gain: 0.5,
        channelCount: n(s, "channels", 2),
        channelCountMode: str(
          s,
          "channelCountMode",
          "max",
        ) as API.ChannelCountMode,
        channelInterpretation: str(
          s,
          "channelInterpretation",
          "speakers",
        ) as API.ChannelInterpretation,
      }),
    );
    node.loop = true;
    node.connect(gain);
    gain.connect(output);
    node.start();
    emit("node", {
      inputs: gain.numberOfInputs,
      outputs: gain.numberOfOutputs,
      channels: gain.channelCount,
      mode: gain.channelCountMode,
      interpretation: gain.channelInterpretation,
    });
    engine.setControls(id, scope, {
      apply: (value) => {
        throw new BlockedError(
          "Channel properties are construction-time settings. Start a new check to change them.",
        );
      },
      disconnect: () => {
        gain.disconnect(output);
        emit("disconnected");
      },
      connect: () => {
        gain.connect(output);
        emit("connected");
      },
    });
  } else if (
    ["oscillator", "periodic", "constant", "automation"].includes(id)
  ) {
    const node = tone();
    const gain = track(ctx.createGain());
    gain.gain.value = id === "constant" ? 0 : 1;
    node.connect(gain);
    gain.connect(output);
    const apply = (value: Settings) => {
      ramp(node.frequency, n(value, "frequency", 440), ctx);
      ramp(node.detune, n(value, "detune"), ctx);
      const wave = str(value, "wave", "sine") as API.OscillatorType;
      if (id === "periodic" || wave === "custom") {
        const count = Math.max(2, Math.min(128, n(value, "harmonics", 8) + 1));
        const real = new Float32Array(count),
          imag = new Float32Array(count);
        for (let i = 1; i < count; i++) imag[i] = 1 / i;
        node.setPeriodicWave(
          ctx.createPeriodicWave(real, imag, {
            disableNormalization: !!value.disableNormalization,
          }),
        );
      } else node.type = wave;
    };
    apply(s);
    if (id === "constant") {
      const control = track(ctx.createConstantSource());
      control.offset.value = n(s, "offset", 0.5);
      control.connect(gain.gain);
      control.start();
      control.offset.linearRampToValueAtTime(
        0,
        ctx.currentTime + n(s, "duration", 3),
      );
      control.stop(ctx.currentTime + n(s, "duration", 3));
      emit("offset", control.offset.value);
    }
    if (id === "automation") {
      const param = gain.gain,
        time = ctx.currentTime,
        end = time + n(s, "duration", 3);
      param.value = 0.01;
      const method = str(s, "method");
      const target = n(s, "gain", 0.5);
      if (method === "setValueAtTime") param.setValueAtTime(target, time + 0.5);
      else if (method === "setTargetAtTime")
        param.setTargetAtTime(target, time, 0.3);
      else if (method === "setValueCurveAtTime")
        param.setValueCurveAtTime(
          new Float32Array([0.01, target, 0.1]),
          time,
          n(s, "duration", 3),
        );
      else if (method === "exponentialRampToValueAtTime")
        param.exponentialRampToValueAtTime(target, end);
      else param.linearRampToValueAtTime(target, end);
      if (
        method === "cancelScheduledValues" ||
        method === "cancelAndHoldAtTime"
      ) {
        scope.timeout(
          () => {
            if (scope.alive) {
              param[method](ctx.currentTime);
              emit(method, param.value);
            }
          },
          n(s, "duration", 3) * 500,
        );
      }
      emit("parameter", {
        default: param.defaultValue,
        min: param.minValue,
        max: param.maxValue,
        value: param.value,
      });
    }
    node.start();
    if (id === "constant") node.stop(ctx.currentTime + n(s, "duration", 3));
    engine.setControls(id, scope, { apply });
  } else {
    const source = await bufferSource(engine, s, env);
    const options = nodeOptions(s);
    source.loop = true;
    let effect: API.AudioNode;
    let apply: (value: Settings) => void = () => {};
    if (id === "gain") {
      const node = track(new API.GainNode(ctx, options));
      effect = node;
      apply = (value) => {
        node.gain.linearRampToValueAtTime(
          n(value, "gain", 0.5),
          ctx.currentTime + 0.02,
        );
      };
    } else if (id === "pan") {
      const node = track(new API.StereoPannerNode(ctx, options));
      effect = node;
      apply = (value) => {
        node.pan.linearRampToValueAtTime(
          n(value, "pan"),
          ctx.currentTime + 0.02,
        );
      };
    } else if (id === "biquad") {
      const node = track(new API.BiquadFilterNode(ctx, options));
      effect = node;
      apply = (value) => {
        node.type = str(value, "type", "lowpass") as API.BiquadFilterType;
        ramp(node.frequency, n(value, "cutoff", 1000), ctx);
        ramp(node.Q, n(value, "Q", 1), ctx);
        ramp(node.gain, n(value, "filterGain"), ctx);
        ramp(node.detune, n(value, "detune"), ctx);
        const frequencies = new Float32Array([100, 440, 1000, 5000]);
        const magnitude = new Float32Array(4),
          phase = new Float32Array(4);
        node.getFrequencyResponse(frequencies, magnitude, phase);
        emit("response", {
          frequencies: [...frequencies],
          magnitude: [...magnitude],
          phase: [...phase],
        });
      };
    } else if (id === "iir") {
      const node = track(
        ctx.createIIRFilter(
          json(s, "feedforward", "[0.5,0.5]"),
          json(s, "feedback", "[1,0]"),
        ),
      );
      effect = node;
      const frequencies = new Float32Array([100, 440, 1000, 5000]),
        magnitude = new Float32Array(4),
        phase = new Float32Array(4);
      node.getFrequencyResponse(frequencies, magnitude, phase);
      emit("response", { magnitude: [...magnitude], phase: [...phase] });
      // Coefficients were applied at construction; there is no live setter.
      apply = () => {};
    } else if (id === "delay") {
      const node = track(
        new API.DelayNode(ctx, {
          ...options,
          maxDelayTime: n(s, "maxDelay", 1),
        }),
      );
      effect = node;
      apply = (value) => {
        ramp(node.delayTime, n(value, "delayTime", 0.2), ctx);
      };
    } else if (id === "convolver") {
      const node = track(
        new API.ConvolverNode(ctx, {
          ...options,
          disableNormalization: !s.normalize,
        }),
      );
      effect = node;
      node.buffer = await loadFixture({ fixture: "impulse.wav" }, ctx, scope);
      apply = (value) => {
        node.normalize = !!value.normalize;
      };
      if (s.clear) {
        scope.timeout(() => {
          if (scope.alive) {
            node.buffer = null;
            emit("bufferCleared", {
              jsBuffer: node.buffer,
              note: "Compare audible tail; native clear has a known source discrepancy.",
            });
          }
        }, 1000);
      }
    } else if (id === "waveshaper") {
      let node = track(new API.WaveShaperNode(ctx, options));
      effect = node;
      let curveKey = "";
      apply = (value) => {
        const size = Math.max(2, Math.min(8192, n(value, "curveSize", 256))),
          drive = n(value, "drive", 3);
        const nextKey = JSON.stringify([size, drive]);
        if (curveKey !== nextKey) {
          const curve = new Float32Array(size);
          for (let i = 0; i < curve.length; i++)
            curve[i] = Math.tanh(drive * ((i * 2) / (curve.length - 1) - 1));
          // A WaveShaper curve is write-once. Configure the replacement before rewiring.
          const next = curveKey
            ? track(new API.WaveShaperNode(ctx, options))
            : node;
          next.curve = curve;
          next.oversample = str(
            value,
            "oversample",
            "none",
          ) as API.OverSampleType;
          if (next !== node) {
            source.disconnect(node);
            node.disconnect();
            source.connect(next);
            next.connect(output);
            effect = node = next;
          }
          curveKey = nextKey;
        } else
          node.oversample = str(
            value,
            "oversample",
            "none",
          ) as API.OverSampleType;
        emit("waveShaperOwnership", {
          trackedNodes: env.trackedCount(),
          curveSize: size,
          drive,
          oversample: node.oversample,
        });
      };
    } else if (id === "analyser") {
      effect = analyser(engine, source, env, s);
      // analyser() already connected its input.
      effect.connect(output);
      source.start();
      engine.setControls(id, scope, {
        apply: (value) => {
          const node = effect as API.AnalyserNode;
          node.fftSize = n(value, "fftSize", 2048);
          // Keep min < max while moving both bounds in either direction.
          if (n(value, "minDb", -100) >= node.maxDecibels)
            node.maxDecibels = n(value, "maxDb", -30);
          node.minDecibels = n(value, "minDb", -100);
          node.maxDecibels = n(value, "maxDb", -30);
          node.smoothingTimeConstant = n(value, "smoothing", 0.8);
          emit("analyserSettings", {
            fftSize: node.fftSize,
            bins: node.frequencyBinCount,
          });
        },
      });
      if (action === "check") {
        await env.waitCheck();
        emit("analysis", {
          ...nodeOptions(s),
          fftSize: n(s, "fftSize", 2048),
          bins: n(s, "fftSize", 2048) / 2,
        });
      }
      return manual(
        "Inspect the live waveform/spectrum and confirm the source is audible.",
      );
    } else throw new Error(`No graph implementation for ${id}`);
    emit("nodeChannels", {
      channels: effect.channelCount,
      mode: effect.channelCountMode,
      interpretation: effect.channelInterpretation,
    });
    apply(s);
    source.connect(effect);
    effect.connect(output);
    source.start();
    engine.setControls(id, scope, {
      apply: (value) => {
        if (id === "iir")
          throw new BlockedError(
            "IIR coefficients are construction-time values. Start a new check to change them.",
          );
        apply(value);
        emit("settingsApplied");
      },
    });
  }
  if (action === "check" || action === "default-start") await env.waitCheck();
  emit("context", engine.inspect());
  return manual(
    "Native graph ran. Confirm the expected sound and any displayed events.",
  );
}
