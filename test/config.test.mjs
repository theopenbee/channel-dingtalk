import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError } from "@theopenbee/channel-sdk";

import { readConfig } from "../dist/dingtalk.js";

test("readConfig applies defaults for empty values", () => {
  assert.deepEqual(readConfig({ client_id: " id ", client_secret: "secret", ffprobe_path: "", ffmpeg_path: "", api_base_url: "", oapi_base_url: "" }), {
    clientId: "id",
    clientSecret: "secret",
    ffprobePath: "ffprobe",
    ffmpegPath: "ffmpeg",
    apiBaseUrl: "https://api.dingtalk.com",
    oapiBaseUrl: "https://oapi.dingtalk.com",
  });
  const custom = readConfig({ client_id: "id", client_secret: "s", ffprobe_path: "/opt/ffprobe", ffmpeg_path: "/opt/ffmpeg", api_base_url: "http://proxy" });
  assert.equal(custom.ffprobePath, "/opt/ffprobe");
  assert.equal(custom.ffmpegPath, "/opt/ffmpeg");
  assert.equal(custom.apiBaseUrl, "http://proxy");
});

test("readConfig requires the client credentials", () => {
  assert.throws(() => readConfig({ client_secret: "s" }), (err) => err instanceof ConfigError && /client_id is required/.test(err.message));
  assert.throws(() => readConfig({ client_id: "id", client_secret: "" }), (err) => err instanceof ConfigError && /client_secret is required/.test(err.message));
  assert.throws(() => readConfig({ client_id: 5, client_secret: "s" }), ConfigError);
});
