const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [
  ...new Set([
    ...config.resolver.assetExts,
    "flac",
    "ogg",
    "opus",
    "aac",
    "caf",
    "m3u8",
  ]),
];

// Worklets needs lazy module initialization in Expo apps.
config.transformer.getTransformOptions = async () => ({
  transform: { experimentalImportSupport: false, inlineRequires: true },
});

module.exports = config;
