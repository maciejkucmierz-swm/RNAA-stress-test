export interface AudioIntent {
  playing: boolean;
  recording: boolean;
  muted: boolean;
  gain: number;
  generation: number;
  resumeAllowed: boolean;
  needsUser: boolean;
  interrupted: boolean;
}
export function initialIntent(
  recording: boolean,
  muted = false,
  gain = 0.1,
): AudioIntent {
  return {
    playing: true,
    recording,
    muted,
    gain,
    generation: 0,
    resumeAllowed: false,
    needsUser: false,
    interrupted: false,
  };
}
export function reduceIntent(
  state: AudioIntent,
  event:
    | "stop"
    | "resume"
    | "interrupt"
    | "temporary-end"
    | "permanent-loss"
    | "reset"
    | "mute"
    | "gain",
  value?: number | boolean,
): AudioIntent {
  switch (event) {
    case "stop":
      return {
        ...state,
        playing: false,
        generation: state.generation + 1,
        resumeAllowed: false,
        needsUser: true,
      };
    case "resume":
      return {
        ...state,
        playing: true,
        resumeAllowed: false,
        needsUser: false,
        interrupted: false,
      };
    case "interrupt":
      return {
        ...state,
        interrupted: true,
        resumeAllowed: state.playing && !state.recording,
        needsUser: state.recording,
      };
    case "temporary-end":
      return {
        ...state,
        interrupted: false,
        resumeAllowed:
          value === true &&
          state.resumeAllowed &&
          state.playing &&
          !state.needsUser,
      };
    case "permanent-loss":
    case "reset":
      return {
        ...state,
        interrupted: false,
        resumeAllowed: false,
        needsUser: true,
        playing: false,
        generation: state.generation + 1,
      };
    case "mute":
      return { ...state, muted: !!value };
    case "gain":
      return { ...state, gain: Math.max(0, Math.min(1, Number(value))) };
  }
}
