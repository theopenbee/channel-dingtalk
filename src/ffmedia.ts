import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE_TIMEOUT = 30_000;
const FRAME_TIMEOUT = 60_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

function run(command: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, signal, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function probeDuration(path: string, ffprobePath: string, signal?: AbortSignal): Promise<number> {
  const out = await run(ffprobePath, ["-v", "quiet", "-print_format", "json", "-show_format", path], PROBE_TIMEOUT, signal);
  let parsed: { format?: { duration?: unknown } };
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const raw = parsed?.format?.duration;
  const seconds = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(seconds)) throw new Error("ffprobe returned no duration");
  return seconds;
}

export async function audioDurationMs(path: string, ffprobePath: string, signal?: AbortSignal): Promise<number> {
  return Math.trunc((await probeDuration(path, ffprobePath, signal)) * 1000);
}

export async function videoDurationSec(path: string, ffprobePath: string, signal?: AbortSignal): Promise<number> {
  return Math.trunc(await probeDuration(path, ffprobePath, signal));
}

export interface Thumbnail {
  path: string;
  cleanup: () => Promise<void>;
}

export async function extractFirstFrame(videoPath: string, ffmpegPath: string, signal?: AbortSignal): Promise<Thumbnail> {
  const path = join(tmpdir(), `openbee-thumb-${randomBytes(8).toString("hex")}.jpg`);
  const cleanup = () => rm(path, { force: true });
  try {
    await run(ffmpegPath, ["-i", videoPath, "-ss", "00:00:00", "-vframes", "1", "-y", path], FRAME_TIMEOUT, signal);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { path, cleanup };
}
