import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { audioDurationMs, extractFirstFrame, probeDuration, videoDurationSec } from "../dist/ffmedia.js";
import { fakeBinaries } from "./fakebin.mjs";

test("ffprobe durations are converted like the Go helpers", async () => {
  const bin = fakeBinaries({ duration: "3.9876" });
  assert.equal(await probeDuration("/tmp/a.mp3", bin.ffprobe), 3.9876);
  assert.equal(await audioDurationMs("/tmp/a.mp3", bin.ffprobe), 3987);
  assert.equal(await videoDurationSec("/tmp/a.mp4", bin.ffprobe), 3);
  assert.match(readFileSync(bin.argsLog, "utf8"), /^-v quiet -print_format json -show_format \/tmp\/a.mp3$/m);
});

test("ffprobe failures are errors", async () => {
  const bin = fakeBinaries({ duration: "N/A" });
  await assert.rejects(probeDuration("/tmp/a.mp3", bin.ffprobe), /no duration/);
  await assert.rejects(probeDuration("/tmp/a.mp3", bin.broken));
  await assert.rejects(probeDuration("/tmp/a.mp3", bin.missing), /ENOENT/);
});

test("extractFirstFrame writes a temp jpeg and cleans up", async () => {
  const bin = fakeBinaries({ frame: "THUMB" });
  const thumb = await extractFirstFrame("/tmp/clip.mp4", bin.ffmpeg);
  assert.match(thumb.path, /openbee-thumb-[0-9a-f]+\.jpg$/);
  assert.equal(readFileSync(thumb.path, "utf8"), "THUMB");
  assert.match(readFileSync(bin.argsLog, "utf8"), /^-i \/tmp\/clip.mp4 -ss 00:00:00 -vframes 1 -y \S+openbee-thumb-[0-9a-f]+\.jpg$/m);
  await thumb.cleanup();
  assert.equal(existsSync(thumb.path), false);

  await assert.rejects(extractFirstFrame("/tmp/clip.mp4", bin.broken));
  await assert.rejects(extractFirstFrame("/tmp/clip.mp4", bin.missing), /ENOENT/);
});
