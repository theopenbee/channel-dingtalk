import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fakeBinaries({ duration = "3.456", frame = "JPEGTHUMB" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dt-bin-"));
  const ffprobe = join(dir, "ffprobe");
  const ffmpeg = join(dir, "ffmpeg");
  const broken = join(dir, "broken");
  const argsLog = join(dir, "args.log");
  writeFileSync(ffprobe, `#!/bin/sh\necho "$@" >> "${argsLog}"\necho '{"format":{"duration":"${duration}"}}'\n`);
  writeFileSync(ffmpeg, `#!/bin/sh\necho "$@" >> "${argsLog}"\nfor a; do last="$a"; done\nprintf '${frame}' > "$last"\n`);
  writeFileSync(broken, `#!/bin/sh\necho "no such file" >&2\nexit 1\n`);
  for (const f of [ffprobe, ffmpeg, broken]) chmodSync(f, 0o755);
  return { dir, ffprobe, ffmpeg, broken, missing: join(dir, "missing"), argsLog };
}
