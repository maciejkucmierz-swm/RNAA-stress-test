module.exports = function (api) {
  api.cache(true);
  return {
    // Includes react-native-worklets/plugin automatically when installed.
    presets: ["babel-preset-expo"],
  };
};
