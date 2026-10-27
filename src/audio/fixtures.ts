/* eslint-disable @typescript-eslint/no-require-imports -- Metro assets require literal module references. */
import { Asset } from "expo-asset";
import { File } from "expo-file-system";
import manifest from "../../assets/audio/manifest.json";

export const assets: Record<string, number> = {
  // Android resource IDs omit extensions, so encoded files include the format in their basename.
  "mono.wav": require("../../assets/audio/mono.wav"),
  "stereo.wav": require("../../assets/audio/stereo.wav"),
  "silence.wav": require("../../assets/audio/silence.wav"),
  "melody.wav": require("../../assets/audio/melody.wav"),
  "impulse.wav": require("../../assets/audio/impulse.wav"),
  "stereo.mp3": require("../../assets/audio/stereo_mp3.mp3"),
  "stereo.flac": require("../../assets/audio/stereo_flac.flac"),
  "stereo.ogg": require("../../assets/audio/stereo_ogg.ogg"),
  "stereo.opus": require("../../assets/audio/stereo_opus.opus"),
  "stereo.aac": require("../../assets/audio/stereo_aac.aac"),
  "stereo.m4a": require("../../assets/audio/stereo_m4a.m4a"),
  "stereo.mp4": require("../../assets/audio/stereo_mp4.mp4"),
};
export const fixtureMetadata: Record<
  string,
  { duration: number; sampleRate: number; channels: number; bytes: number }
> = manifest;
export async function fixturePath(name: string) {
  if (!assets[name]) throw new Error(`Unknown fixture ${name}`);
  const asset = Asset.fromModule(assets[name]);
  await asset.downloadAsync();
  if (!asset.localUri)
    throw new Error(`Fixture did not resolve locally: ${name}`);
  return asset.localUri;
}
export async function fixtureBytes(name: string) {
  return new File(await fixturePath(name)).arrayBuffer();
}
