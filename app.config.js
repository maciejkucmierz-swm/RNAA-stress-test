const version = require("react-native-audio-api/package.json").version;

module.exports = ({ config: base }) => ({
  ...base,
  plugins: base.plugins.map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== "react-native-audio-api")
      return plugin;
    const options = {
      ...plugin[1],
      disableStaticExternalLibs: false,
      androidFSStopWithTask:
        process.env.RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL !== "1",
    };
    delete options.disableFFmpeg;
    delete options.enableFFmpeg;
    options.disableFFmpeg = false;
    return [plugin[0], options];
  }),
  extra: {
    audioApiVersion: version,
    channel: "stable",
    ffmpeg: true,
    staticCodecLibraries: true,
    keepRecordingAfterTaskRemoval:
      process.env.RNAA_KEEP_RECORDING_AFTER_TASK_REMOVAL === "1",
  },
});
