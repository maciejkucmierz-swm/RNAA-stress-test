import * as API from "react-native-audio-api";
import { SessionScope } from "../workshop/session";
import { type Settings } from "../workshop/types";
import { assets, fixtureBytes, fixturePath } from "./fixtures";
import { str } from "./utils";
export async function input(
  s: Settings,
): Promise<string | number | ArrayBuffer> {
  const name = str(s, "fixture", "stereo.wav");
  if (s.input === "url") return str(s, "url");
  if (s.input === "asset") return assets[name];
  if (s.input === "arrayBuffer") return fixtureBytes(name);
  return fixturePath(name);
}
export async function loadFixture(
  s: Settings,
  ctx: API.BaseAudioContext,
  scope: SessionScope,
) {
  const path = await fixturePath(str(s, "fixture", "stereo.wav"));
  scope.ensureActive();
  const buffer = await ctx.decodeAudioData(path);
  scope.ensureActive();
  return buffer;
}
