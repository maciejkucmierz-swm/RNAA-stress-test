const {
  withInfoPlist,
  withAndroidManifest,
  AndroidConfig,
} = require("expo/config-plugins");
module.exports = function withProductionFaults(config) {
  config = withInfoPlist(config, (result) => {
    result.modResults.RNAAProductionFaultsEnabled = true;
    return result;
  });
  return withAndroidManifest(config, (result) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(
      result.modResults,
    );
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      app,
      "RNAAProductionFaultsEnabled",
      "true",
    );
    return result;
  });
};
