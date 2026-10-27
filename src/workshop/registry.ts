import type {
  Action,
  Feature,
  Field,
  RepetitionKind,
  Settings,
  Workload,
} from "./types";

export const REMOTE_MP3 =
  "https://docs.swmansion.com/react-native-audio-api/audio/sounds/A3.mp3";
export const REMOTE_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
const number = (
  key: string,
  label: string,
  value: number,
  advanced = false,
): Field => ({ key, label, value, advanced });
const text = (
  key: string,
  label: string,
  value: string,
  advanced = false,
): Field => ({ key, label, value, advanced });
const choice = (
  key: string,
  label: string,
  value: string,
  options: string[],
  advanced = false,
): Field => ({ key, label, value, options, advanced });
const toggle = (
  key: string,
  label: string,
  value = false,
  advanced = false,
): Field => ({ key, label, value, advanced });
const action = (
  id: string,
  label: string,
  session = false,
  check = false,
): Action => ({ id, label, session, check });
const run = action("check", "Run check", true, true);
const start = action("start", "Start", true);
const transport = [
  start,
  run,
  action("pause", "Pause"),
  action("resume", "Resume"),
  action("stop", "Stop"),
];
const listen = [start, run, action("stop", "Stop")];
const duration = number("duration", "Duration (seconds)", 3);
const channels = number("channels", "Channels", 2, true);
const frequency = number("frequency", "Frequency (Hz)", 440);
const gain = number("gain", "Gain", 0.5);
const rate = choice(
  "sampleRate",
  "Sample rate",
  "device",
  ["device", "8000", "16000", "44100", "48000", "96000"],
  true,
);
const source = choice("fixture", "Fixture", "stereo.wav", [
  "mono.wav",
  "stereo.wav",
  "melody.wav",
  "silence.wav",
  "impulse.wav",
  "stereo.mp3",
  "stereo.flac",
  "stereo.ogg",
  "stereo.opus",
  "stereo.aac",
  "stereo.m4a",
  "stereo.mp4",
]);
const remote = [
  text("url", "Remote URL", REMOTE_MP3),
  text("headers", "HTTP headers (JSON)", "{}", true),
];
const pitch = [
  number("playbackRate", "Playback rate", 1),
  number("detune", "Detune (cents)", 0),
  toggle("pitchCorrection", "Pitch correction", false, true),
];
const nodeChannels = [
  channels,
  choice(
    "channelCountMode",
    "Channel count mode",
    "max",
    ["max", "clamped-max", "explicit"],
    true,
  ),
  choice(
    "channelInterpretation",
    "Channel interpretation",
    "speakers",
    ["speakers", "discrete"],
    true,
  ),
];
const recordFields: Field[] = [
  choice("format", "File format", "Wav", [
    "Wav",
    "Caf",
    "M4A",
    "Flac",
    "Aiff",
    "Alac",
    "OpusOgg",
    "OpusWebm",
    "VorbisWebm",
    "Ulaw",
    "Alaw",
  ]),
  choice("preset", "Preset", "High", [
    "Low",
    "Medium",
    "High",
    "Lossless",
    "Custom",
  ]),
  channels,
  choice("directory", "Directory", "Cache", ["Cache", "Document"], true),
  text("subDirectory", "Subdirectory", "Workshop", true),
  text("fileName", "Filename / stable override", "", true),
  text("fileNamePrefix", "Stable filename prefix", "workshop", true),
  number("rotateBytes", "Rotate after bytes (0 = off)", 0, true),
  number("flushMs", "Android flush interval (ms)", 500, true),
  number("recordRate", "Custom sample rate", 48000, true),
  number("bitRate", "Custom bitrate", 192000, true),
  choice(
    "bitDepth",
    "Custom PCM depth",
    "Bit24",
    ["Bit16", "Bit24", "Bit32"],
    true,
  ),
  choice(
    "iosQuality",
    "Custom iOS quality",
    "High",
    ["Min", "Low", "Medium", "High", "Max"],
    true,
  ),
  number("flacLevel", "Custom FLAC level", 5, true),
  duration,
];
const capture = [
  number("callbackRate", "Callback sample rate", 16000),
  number("bufferLength", "Callback frames", 1024),
  channels,
  duration,
];
const worklet = [
  choice("runtime", "Runtime", "AudioRuntime", ["AudioRuntime", "UIRuntime"]),
  duration,
];
const groups: Record<RepetitionKind, readonly string[]> = {
  check: [
    "offline",
    "buffer",
    "decode",
    "pcm",
    "metadata",
    "concat",
    "errors",
    "capabilities",
    "permissions",
  ],
  context: ["context"],
  connections: ["graph"],
  edit: [
    "oscillator",
    "gain",
    "pan",
    "biquad",
    "delay",
    "convolver",
    "waveshaper",
    "analyser",
    "buffer-source",
    "audio-tag",
  ],
  restart: [
    "automation",
    "periodic",
    "constant",
    "iir",
    "media-route",
    "streamer",
    "worklet-observe",
    "worklet-process",
    "worklet-source",
  ],
  queue: ["queue"],
  record: ["record-file", "record-pcm", "record-graph", "record-combined"],
  session: ["session"],
  "live-system": [
    "record-recovery",
    "system-events",
    "devices",
    "volume",
    "background",
  ],
  notification: ["playback-notification", "recording-notification"],
};

const captureOutputs: Record<string, Workload["capture"]> = {
  "record-file": "file",
  "record-pcm": "samples",
  "record-graph": "graph",
  "record-combined": "combined",
};
const companions: Record<string, NonNullable<Workload["companion"]>> = {
  context: "select",
  session: "select",
  "system-events": "select",
  devices: "select",
  volume: "select",
  background: "select",
  "record-recovery": "recording",
  "recording-notification": "recording",
  "playback-notification": "playback",
};
const suites: Record<string, Workload["suite"]> = {
  waveshaper: "graph-churn",
  context: "lifecycle-storm",
  "playback-notification": "notification-race",
  queue: "queue-pressure",
  "record-combined": "recorder-endurance",
  "worklet-process": "worklet-budget",
  decode: "decode-flood",
  "audio-tag": "streaming-recovery",
};
function feature(value: Omit<Feature, "workload">): Feature {
  const kind = (Object.keys(groups) as RepetitionKind[]).find((key) =>
    groups[key].includes(value.id),
  );
  if (!kind) throw new Error(`Missing workload description: ${value.id}`);
  const companion = companions[value.id];
  return {
    ...value,
    workload: {
      kind,
      mode: companion ? "system" : kind === "check" ? "data" : "audio",
      capture: captureOutputs[value.id] ?? "none",
      companion,
      defaultCompanion:
        value.id === "background" || companion === "recording"
          ? "recording"
          : "playback",
      suite: suites[value.id],
    },
  };
}

export const features: Feature[] = [
  feature({
    id: "context",
    category: "Core",
    title: "Live context",
    api: "AudioContext / BaseAudioContext",
    description:
      "Create, inspect, suspend, resume, and close the shared live context. Recreating it stops the current demo.",
    fields: [rate],
    actions: [
      action("create", "Create / recreate", true),
      action("inspect", "Inspect"),
      action("pause", "Suspend"),
      action("resume", "Resume"),
      action("close", "Close", true),
    ],
  }),
  feature({
    id: "offline",
    category: "Core",
    title: "Offline rendering",
    api: "OfflineAudioContext",
    description:
      "Render a finite oscillator graph; inspect length, energy, and suspend/resume behavior without speaker output.",
    fields: [
      duration,
      number("sampleRate", "Sample rate", 48000),
      channels,
      toggle("suspend", "Suspend halfway"),
    ],
    actions: [run],
  }),
  feature({
    id: "graph",
    category: "Core",
    title: "Connections & channel mixing",
    api: "AudioNode.connect / disconnect",
    description:
      "Connect a stereo buffer through a gain with the selected mixing rules, then disconnect/reconnect it.",
    fields: [...nodeChannels, duration],
    actions: [
      ...listen,
      action("disconnect", "Disconnect output"),
      action("connect", "Reconnect output"),
    ],
  }),
  feature({
    id: "buffer",
    category: "Core",
    title: "PCM buffer operations",
    api: "AudioBuffer / createBuffer",
    description:
      "Create a buffer, copy channel samples in/out, and compare exact values. Includes direct channel access.",
    fields: [
      toggle("useContext", "Use context createBuffer factory"),
      number("channels", "Channels", 2),
      number("frames", "Frames", 128),
      number("sampleRate", "Sample rate", 48000),
    ],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "automation",
    category: "Core",
    title: "Parameter automation",
    api: "AudioParam",
    description:
      "Hear an envelope and inspect the parameter. Cancellation runs midway through the scheduled envelope.",
    fields: [
      choice("method", "Method", "linearRampToValueAtTime", [
        "setValueAtTime",
        "linearRampToValueAtTime",
        "exponentialRampToValueAtTime",
        "setTargetAtTime",
        "setValueCurveAtTime",
        "cancelScheduledValues",
        "cancelAndHoldAtTime",
      ]),
      gain,
      duration,
    ],
    actions: listen,
  }),
  feature({
    id: "decode",
    category: "Core",
    title: "Decode & resample",
    api: "decodeAudioData / context.decodeAudioData",
    description:
      "Use independent decoding or context resampling; compare bundled fixture metadata with the decoded result.",
    fields: [
      source,
      choice("input", "Input", "local", [
        "local",
        "asset",
        "arrayBuffer",
        "url",
      ]),
      toggle("useContext", "Decode through live context"),
      number("targetRate", "Target rate (0 = original)", 0, true),
      ...remote,
    ],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "pcm",
    category: "Core",
    title: "Base64 raw PCM",
    api: "decodePCMInBase64",
    description:
      "Generate signed 16-bit little-endian PCM, encode it to base64, and validate interleaved or planar decoding.",
    fields: [
      toggle("interleaved", "Interleaved", true),
      toggle("useContext", "Use context helper"),
      number("channels", "Channels", 2),
      number("sampleRate", "Sample rate", 16000),
    ],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "metadata",
    category: "Core",
    title: "Duration metadata",
    api: "getAudioDuration",
    description:
      "Read encoded duration directly. Zero or invalid duration stays a failed result; decoding never replaces it.",
    fields: [
      source,
      choice("input", "Input", "local", ["local", "arrayBuffer", "url"]),
      ...remote,
    ],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "concat",
    category: "Core",
    title: "Join audio files",
    api: "concatAudioFiles",
    description:
      "Join two matching bundled WAV/M4A files  and verify the resulting file and duration.",
    fields: [
      choice("fixture", "Container", "stereo.wav", [
        "stereo.wav",
        "stereo.m4a",
      ]),
    ],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "errors",
    category: "Core",
    title: "Validation errors",
    api: "AudioApiError and validation subclasses",
    description:
      "Run safe invalid-argument checks. An expected rejection passes the assertion; unexpected success fails it.",
    fields: [],
    actions: [action("check", "Run check", false, true)],
  }),
  feature({
    id: "capabilities",
    category: "Core",
    title: "Build capabilities",
    api: "isFfmpegEnabled / Expo plugin",
    description:
      "Inspect the installed version, native FFmpeg flag, and build-only codec/background options. These cannot be toggled at runtime.",
    fields: [],
    actions: [action("inspect", "Inspect")],
  }),
  feature({
    id: "buffer-source",
    category: "Playback",
    title: "Buffer playback & loops",
    api: "AudioBufferSourceNode",
    description:
      "Single-use source with explicit schedule, offset, duration, looping, position, and end events. Start creates a new source.",
    fields: [
      source,
      ...pitch,
      duration,
      toggle("loop", "Loop"),
      number("offset", "Offset (seconds)", 0),
      number("when", "Start delay (seconds)", 0, true),
      number("stopAfter", "Scheduled stop (0 = disabled)", 0, true),
      number("loopStart", "Loop start", 0, true),
      number("loopEnd", "Loop end (0 = buffer duration)", 0, true),
      toggle("loopSkip", "Loop skip", false, true),
      number("positionInterval", "Position interval (ms)", 100, true),
    ],
    actions: [...listen, action("apply", "Apply rate / loop settings")],
  }),
  feature({
    id: "queue",
    category: "Playback",
    title: "Queued buffers",
    api: "AudioBufferQueueSourceNode",
    description:
      "Play two small buffers, mutate the queue, and inspect completion IDs. Resume restarts at an explicit offset in RNAA 0.13.6.",
    knownIssue:
      "Unmodified 0.13.6 default start throws a negative-offset error. Explicit-offset playback is a separate check, not a fix for the default call.",
    fields: [
      source,
      ...pitch,
      number("offset", "Start / stable restart offset", 0),
      duration,
    ],
    actions: [
      ...transport,
      action("enqueue", "Enqueue"),
      action("dequeue", "Dequeue last"),
      action("clear", "Clear buffers"),
      action("default-start", "Check default start", true, true),
    ],
  }),
  feature({
    id: "audio-tag",
    category: "Playback",
    title: "Audio component & controls",
    api: "<Audio> / AudioControls / useAudioTagContext",
    description:
      "Play a file or URL and use the controls here. The same player stays alive when you switch tabs. Successful loading still needs listening.",
    fields: [
      source,
      choice("input", "Source", "local", ["local", "url", "hls"]),
      ...remote,
      text("hlsUrl", "HLS URL", REMOTE_HLS),
      toggle("autoPlay", "Autoplay", true),
      toggle("loop", "Loop"),
      toggle("muted", "Muted"),
      number("volume", "Component volume", 0.1),
      number("playbackRate", "Playback rate", 1),
      toggle("preservesPitch", "Preserve pitch", true),
      choice("preload", "Preload", "auto", ["auto", "metadata", "none"], true),
      toggle("forceDownload", "Force download", false, true),
      number("seek", "Seek position", 1),
      duration,
    ],
    actions: [
      ...transport,
      action("seek", "Seek"),
      action("apply", "Apply volume / mute / rate"),
    ],
  }),
  feature({
    id: "media-route",
    category: "Playback",
    title: "Media element through effects",
    api: "createMediaElementSource",
    description:
      "Wait for <Audio> to load, route its source through a gain, and verify no duplicate direct output remains.",
    fields: [source, gain, duration],
    actions: listen,
  }),
  feature({
    id: "streamer",
    category: "Playback",
    title: "Legacy HLS streamer",
    api: "StreamerNode (deprecated)",
    description:
      "Exercise the published single-use HLS source. Requires FFmpeg; use Audio component for new playback flows.",
    fields: [text("url", "HLS URL", REMOTE_HLS), duration],
    actions: listen,
  }),
  feature({
    id: "oscillator",
    category: "DSP",
    title: "Oscillator",
    api: "OscillatorNode",
    description:
      "Audition every built-in waveform; custom uses a generated Fourier waveform.",
    fields: [
      choice("wave", "Waveform", "sine", [
        "sine",
        "square",
        "sawtooth",
        "triangle",
        "custom",
      ]),
      frequency,
      number("detune", "Detune (cents)", 0),
      duration,
    ],
    actions: [...listen, action("apply", "Apply settings")],
  }),
  feature({
    id: "periodic",
    category: "DSP",
    title: "Custom periodic wave",
    api: "PeriodicWave",
    description:
      "Construct a Fourier waveform with configurable harmonics and normalization.",
    fields: [
      frequency,
      number("harmonics", "Harmonics", 8),
      toggle("disableNormalization", "Disable normalization"),
      duration,
    ],
    actions: listen,
  }),
  feature({
    id: "constant",
    category: "DSP",
    title: "Constant control source",
    api: "ConstantSourceNode → AudioParam",
    description:
      "Automate a constant offset connected to gain; observe shared parameter modulation.",
    fields: [number("offset", "Control offset", 0.5), frequency, duration],
    actions: listen,
  }),
  ...[
    ["gain", "Gain", "GainNode", [gain]],
    [
      "pan",
      "Stereo pan",
      "StereoPannerNode",
      [number("pan", "Pan (−1 to +1)", 0)],
    ],
    [
      "biquad",
      "Biquad filter",
      "BiquadFilterNode",
      [
        choice("type", "Filter type", "lowpass", [
          "lowpass",
          "highpass",
          "bandpass",
          "lowshelf",
          "highshelf",
          "peaking",
          "notch",
          "allpass",
        ]),
        number("cutoff", "Cutoff / center (Hz)", 1000),
        number("Q", "Q", 1),
        number("filterGain", "Filter gain (dB)", 0),
        number("detune", "Detune (cents)", 0),
      ],
    ],
    [
      "iir",
      "IIR filter",
      "createIIRFilter",
      [
        text("feedforward", "Feedforward JSON", "[0.5,0.5]"),
        text("feedback", "Feedback JSON", "[1,0]"),
      ],
    ],
    [
      "delay",
      "Delay",
      "DelayNode",
      [
        number("delayTime", "Delay (seconds)", 0.2),
        number("maxDelay", "Maximum delay", 1, true),
      ],
    ],
    [
      "convolver",
      "Convolution",
      "ConvolverNode",
      [
        toggle("normalize", "Normalize", true),
        toggle("clear", "Clear buffer during check", false, true),
      ],
    ],
    [
      "waveshaper",
      "Wave shaping",
      "WaveShaperNode",
      [
        number("drive", "Drive", 3),
        number("curveSize", "Curve points", 256, true),
        choice("oversample", "Oversampling", "none", ["none", "2x", "4x"]),
      ],
    ],
    [
      "analyser",
      "Waveform & spectrum",
      "AnalyserNode",
      [
        choice("fftSize", "FFT size", "2048", [
          "32",
          "64",
          "128",
          "256",
          "512",
          "1024",
          "2048",
          "4096",
          "8192",
          "16384",
          "32768",
        ]),
        number("minDb", "Minimum dB", -100, true),
        number("maxDb", "Maximum dB", -30, true),
        number("smoothing", "Smoothing", 0.8),
      ],
    ],
  ].map(([id, title, api, fields]) =>
    feature({
      id: id as string,
      title: title as string,
      api: api as string,
      category: "DSP",
      description:
        "Run the real native effect with a known source. Apply changes, inspect values/events, and confirm the sound.",
      ...(id === "waveshaper"
        ? {
            knownIssue:
              "This demo explicitly replaces the effect node to change its curve. Published 0.13.6 rejects a second curve assignment on the same node and can read back null. Node replacement does not prove direct reassignment works.",
          }
        : {}),
      fields: [
        ...(fields as Field[]),
        source,
        ...(id === "iir" ? [] : nodeChannels),
        duration,
      ],
      actions: [...listen, action("apply", "Apply settings")],
    }),
  ),
  feature({
    id: "record-file",
    category: "Recording",
    title: "Record to file",
    api: "AudioRecorder file output",
    description:
      "Configure the idle recorder, capture a short file, inspect FileInfo, then replay it. Configuration changes stop the previous demo.",
    fields: recordFields,
    actions: [
      ...transport,
      action("disable-file", "Disable file output"),
      action("inspect", "Inspect state"),
    ],
  }),
  feature({
    id: "record-pcm",
    category: "Recording",
    title: "PCM callbacks",
    api: "onAudioReady / clearOnAudioReady",
    description:
      "Inspect delivered channel/rate/frame/timestamp and RMS values; raw PCM is not saved in reports.",
    fields: capture,
    actions: [...transport, action("clear-callback", "Clear callback")],
  }),
  feature({
    id: "record-graph",
    category: "Recording",
    title: "Microphone graph",
    api: "RecorderAdapterNode / recorder.connect",
    description:
      "Feed microphone audio through an analyser. Speaker monitoring is opt-in to avoid feedback.",
    fields: [toggle("monitor", "Monitor microphone on speaker"), ...capture],
    actions: [...transport, action("disconnect", "Disconnect graph")],
  }),
  feature({
    id: "record-combined",
    category: "Recording",
    title: "Combined capture outputs",
    api: "File + PCM callback + graph",
    description:
      "One recorder feeds all three normal-load output paths. Inspect the file and callback data after Stop.",
    fields: [
      ...recordFields,
      ...capture.filter((f) => !["channels", "duration"].includes(f.key)),
      toggle("monitor", "Monitor microphone on speaker"),
    ],
    actions: transport,
  }),
  feature({
    id: "record-recovery",
    category: "Recording",
    title: "Native recording recovery",
    api: "isRecordingOngoing / consumeLastRecordingResult",
    description:
      "Inspect native capture after reopening the UI or a notification stop. Consuming the result clears the native stash.",
    fields: [],
    actions: [
      action("inspect", "Inspect ongoing"),
      action("consume", "Consume last file result"),
    ],
  }),
  ...[
    [
      "worklet-observe",
      "Observe / RMS meter",
      "WorkletNode",
      [number("bufferLength", "Snapshot frames", 1024), channels],
    ],
    [
      "worklet-process",
      "Custom gain processor",
      "WorkletProcessingNode",
      [gain],
    ],
    [
      "worklet-source",
      "Procedural tone source",
      "WorkletSourceNode",
      [frequency],
    ],
  ].map(([id, title, api, fields]) =>
    feature({
      id: id as string,
      title: title as string,
      api: api as string,
      category: "Worklets",
      description:
        "Execute a real worklet, inspect callback data, and confirm the output. ",
      fields: [...(fields as Field[]), ...worklet],
      actions: listen,
    }),
  ),
  feature({
    id: "permissions",
    category: "System",
    title: "Permissions",
    api: "AudioManager permission methods",
    description:
      "Read permission states or request microphone/notification access explicitly. Denial does not count as a library failure.",
    fields: [],
    actions: [
      action("inspect", "Check permissions"),
      action("microphone", "Request microphone"),
      action("notification", "Request notifications"),
    ],
  }),
  feature({
    id: "session",
    category: "System",
    title: "iOS audio session",
    api: "setAudioSessionOptions / Activity",
    description:
      "Configure categories/modes/options; activate/deactivate, disable management, or observe experimental session reclaiming. Invalid OS combinations surface native errors.",
    platforms: ["ios"],
    fields: [
      choice("category", "Category", "playback", [
        "ambient",
        "multiRoute",
        "playAndRecord",
        "playback",
        "record",
        "soloAmbient",
      ]),
      choice("mode", "Mode", "default", [
        "default",
        "dualRoute",
        "gameChat",
        "measurement",
        "moviePlayback",
        "shortFormVideo",
        "spokenAudio",
        "videoChat",
        "videoRecording",
        "voiceChat",
        "voicePrompt",
      ]),
      text("options", "Session options JSON", "[]"),
      toggle("haptics", "Allow haptics", false, true),
      toggle("notifyOthers", "Notify others on deactivation", true, true),
      toggle("reclaim", "Actively reclaim session", false, true),
    ],
    actions: [
      action("apply", "Apply options"),
      action("activate", "Activate"),
      action("deactivate", "Deactivate"),
      action("disable", "Disable management"),
      action("reclaim", "Apply reclaim setting"),
    ],
  }),
  feature({
    id: "system-events",
    category: "System",
    title: "Interruptions, focus & routes",
    api: "observeAudioInterruptions / system events",
    description:
      "Watch events while another tab plays audio. Trigger calls, competing audio, or route changes externally. Open System volume to enable its hook when checking hardware volume events.",
    fields: [
      choice("focus", "Android focus", "gain", [
        "gain",
        "gainTransient",
        "gainTransientExclusive",
        "gainTransientMayDuck",
      ]),
    ],
    actions: [
      action("observe", "Start observing"),
      action("unobserve", "Stop observing"),
    ],
  }),
  feature({
    id: "devices",
    category: "System",
    title: "Devices & input selection",
    api: "getDevicesInfo / useAudioInput",
    description:
      "Refresh available/current routes. Choose an input below; stable Android selection is a no-op. ",
    fields: [],
    actions: [action("inspect", "Refresh devices")],
  }),
  feature({
    id: "volume",
    category: "System",
    title: "System volume",
    api: "useSystemVolume",
    description:
      "Move hardware volume buttons with audio active. Stable hook initially shows zero until an event arrives; iOS simulator observation is unavailable.",
    fields: [],
    actions: [action("inspect", "Read available volume data")],
  }),
  feature({
    id: "playback-notification",
    category: "System",
    title: "Playback notification",
    api: "PlaybackNotificationManager",
    description:
      "Start playback in another tab, show metadata, and use system controls. On iOS visibility depends on the running audio session.",
    fields: [
      text("title", "Title", "Audio API workshop"),
      text("artist", "Artist", "Original fixtures"),
      text("album", "Album", "Functional checks", true),
      text("artwork", "Artwork URI", "", true),
      text("smallIcon", "Android small icon", "", true),
      number("elapsedTime", "Elapsed seconds", 0),
      number("duration", "Duration", 3),
      number("speed", "Speed", 1, true),
      choice("state", "State", "playing", ["playing", "paused"]),
      choice("control", "Control", "play", [
        "play",
        "pause",
        "stop",
        "nextTrack",
        "previousTrack",
        "skipForward",
        "skipBackward",
        "seekTo",
      ]),
      toggle("enabled", "Enable selected control", true),
    ],
    actions: [
      action("show", "Show / update"),
      action("hide", "Hide"),
      action("control", "Apply control"),
      action("inspect", "Inspect active"),
    ],
  }),
  feature({
    id: "recording-notification",
    category: "System",
    title: "Recording notification",
    api: "RecordingNotificationManager",
    description:
      "Start capture first. Native pause/resume/stop actions work independently of JS. Stop consumes the finalized native result instead of stopping twice.",
    platforms: ["android"],
    fields: [
      text("title", "Title", "Workshop recording"),
      text("contentText", "Content", "Capturing microphone"),
      toggle("paused", "Paused"),
      toggle("showStopAction", "Show stop action", true),
      toggle("dismissible", "Dismissible"),
      toggle("usesChronometer", "Chronometer", true),
      text(
        "deepLinkUri",
        "Tap deep link",
        "rnaa-stress-test://recording",
        true,
      ),
      text("smallIconResourceName", "Small icon resource", "", true),
      text("largeIconResourceName", "Large icon resource", "", true),
      number("color", "Color (decimal RGB)", 0x22c7a9, true),
      text("pauseActionTitle", "Pause label", "Pause", true),
      text("resumeActionTitle", "Resume label", "Resume", true),
      text("stopActionTitle", "Stop label", "Stop", true),
    ],
    actions: [
      action("show", "Show / update"),
      action("hide", "Hide"),
      action("inspect", "Inspect active"),
    ],
  }),
  feature({
    id: "background",
    category: "System",
    title: "Background & lock screen",
    api: "Background modes / foreground service",
    description:
      "Start playback or capture, show its notification, then lock the screen or background the app. Reopen and confirm continuity. Task-removal persistence requires RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL=1 followed by native prebuild/rebuild; default stops with task removal.",
    fields: [],
    actions: [action("inspect", "Inspect build / capture state")],
  }),
];
export function defaults(feature: Feature): Settings {
  return Object.fromEntries(
    feature.fields.map((field) => [field.key, field.value]),
  );
}

export function apiName(feature: Feature) {
  return feature.api;
}

// Fixed companion requirements win; selectable companions use the registry default.
export function companionFor(
  feature: Feature,
  choice?: "playback" | "recording",
) {
  const { companion, defaultCompanion } = feature.workload;
  return companion && companion !== "select"
    ? companion
    : (choice ?? defaultCompanion);
}
