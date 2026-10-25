import type { ConversationTarget, DingTalkMediaType, JsonObject, MediaInfo } from "./types.js";

export const MARKDOWN_TITLE = "OpenBee";
export const CONVERSATION_TYPE_SINGLE = "1";
export const PENDING_TTL = 10 * 60_000;
export const RETRY_COUNT = 5;
export const RETRY_DELAY = 500;

export const THINKING_EMOTION_NAME = "🤔思考中";
export const THINKING_EMOTION_ID = "2659900";
export const THINKING_BACKGROUND_ID = "im_bg_1";

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function str(obj: JsonObject | undefined, key: string): string {
  const value = obj?.[key];
  return typeof value === "string" ? value : "";
}

export function int(obj: JsonObject | undefined, key: string): number {
  const value = obj?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return 0;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const mimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/amr": ".amr",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "application/pdf": ".pdf",
};

export function mimeExtension(contentType: string | null | undefined): string | undefined {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return mimeExtensions[ct];
}

export function extensionFromMime(contentType: string | null | undefined): string {
  return mimeExtension(contentType) ?? ".bin";
}

export function extname(name: string): string {
  for (let i = name.length - 1; i >= 0; i--) {
    const c = name[i];
    if (c === "/") return "";
    if (c === ".") return name.slice(i);
  }
  return "";
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f\r\n"\\/:]+/g, "_");
}

export function dingTalkMediaType(name: string): DingTalkMediaType {
  switch (extname(name).toLowerCase()) {
    case ".jpg":
    case ".png":
    case ".gif":
    case ".bmp":
      return "image";
    case ".mp4":
      return "video";
    case ".mp3":
    case ".wav":
    case ".amr":
      return "voice";
    default:
      return "file";
  }
}

export function imageContentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/jpeg";
  }
}

export function encodeRaw(data: JsonObject): string {
  return JSON.stringify({
    conversationId: str(data, "conversationId"),
    conversationType: str(data, "conversationType"),
    senderStaffId: str(data, "senderStaffId"),
    msgId: str(data, "msgId"),
    sessionWebhook: str(data, "sessionWebhook"),
    sessionWebhookExpiredTime: int(data, "sessionWebhookExpiredTime"),
  });
}

export function parseRaw(raw: string | undefined): ConversationTarget | undefined {
  if (!raw) return undefined;
  const data = asObject(parseJson(raw));
  if (!data) return undefined;
  const target: ConversationTarget = {
    conversationId: str(data, "conversationId"),
    conversationType: str(data, "conversationType"),
    senderStaffId: str(data, "senderStaffId"),
    msgId: str(data, "msgId"),
    sessionWebhook: str(data, "sessionWebhook"),
    sessionWebhookExpiredTime: int(data, "sessionWebhookExpiredTime"),
  };
  if (!target.conversationId && !target.senderStaffId && !target.sessionWebhook) return undefined;
  return target;
}

type ContextField = [key: string, kind: "string" | "bool" | "json"];

const contextFields: ContextField[] = [
  ["conversationId", "string"],
  ["atUsers", "json"],
  ["chatbotCorpId", "string"],
  ["chatbotUserId", "string"],
  ["msgId", "string"],
  ["senderNick", "string"],
  ["isAdmin", "bool"],
  ["senderStaffId", "string"],
  ["senderCorpId", "string"],
  ["conversationType", "string"],
  ["senderId", "string"],
  ["conversationTitle", "string"],
  ["msgtype", "string"],
];

export function buildContext(data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, kind] of contextFields) {
    const value = data[key];
    if (kind === "string" ? typeof value === "string" && value !== "" : kind === "bool" ? typeof value === "boolean" : value !== undefined && value !== null) {
      out[key] = value;
    }
  }
  return out;
}

export function isWebhookExpired(target: ConversationTarget, now = Date.now()): boolean {
  if (!target.sessionWebhook) return true;
  if (target.sessionWebhookExpiredTime <= 0) return true;
  return now >= target.sessionWebhookExpiredTime;
}

export function proactivePath(conversationType: string): string {
  return conversationType === CONVERSATION_TYPE_SINGLE ? "/v1.0/robot/oToMessages/batchSend" : "/v1.0/robot/groupMessages/send";
}

export function hasProactiveTarget(target: ConversationTarget): boolean {
  return target.conversationType === CONVERSATION_TYPE_SINGLE ? target.senderStaffId !== "" : target.conversationId !== "";
}

function proactivePayload(robotCode: string, target: ConversationTarget, msgKey: string, msgParam: JsonObject): JsonObject {
  const payload: JsonObject = { robotCode, msgKey, msgParam: JSON.stringify(msgParam) };
  if (target.conversationType === CONVERSATION_TYPE_SINGLE) {
    payload.userIds = [target.senderStaffId];
  } else {
    payload.openConversationId = target.conversationId;
  }
  return payload;
}

export function buildWebhookTextPayload(content: string): JsonObject {
  return { msgtype: "markdown", markdown: { title: MARKDOWN_TITLE, text: content } };
}

export function buildProactiveTextPayload(robotCode: string, target: ConversationTarget, content: string): JsonObject {
  return proactivePayload(robotCode, target, "sampleMarkdown", { title: MARKDOWN_TITLE, text: content });
}

export interface OutgoingMedia {
  type: DingTalkMediaType;
  mediaId: string;
  fileName: string;
  fileType: string;
  info: MediaInfo;
}

export function buildWebhookMediaPayload(media: OutgoingMedia): JsonObject {
  const { mediaId, info } = media;
  switch (media.type) {
    case "image":
      return { msgtype: "markdown", markdown: { title: "Image", text: `![image](${mediaId})` } };
    case "voice":
      return { msgtype: "voice", voice: { mediaId, duration: String(info.durationMs) } };
    case "video":
      return {
        msgtype: "video",
        video: { duration: String(info.durationSec), videoMediaId: mediaId, videoType: "mp4", picMediaId: info.picMediaId },
      };
    default:
      return { msgtype: "file", file: { mediaId, fileName: media.fileName, fileType: media.fileType } };
  }
}

export function buildProactiveMediaPayload(robotCode: string, target: ConversationTarget, media: OutgoingMedia): JsonObject {
  const { mediaId, info } = media;
  switch (media.type) {
    case "image":
      return proactivePayload(robotCode, target, "sampleMarkdown", { title: "Image", text: `![image](${mediaId})` });
    case "voice":
      return proactivePayload(robotCode, target, "sampleAudio", { mediaId, duration: String(info.durationMs) });
    case "video":
      return proactivePayload(robotCode, target, "sampleVideo", {
        duration: String(info.durationSec),
        videoMediaId: mediaId,
        videoType: "mp4",
        picMediaId: info.picMediaId,
      });
    default:
      return proactivePayload(robotCode, target, "sampleFile", { mediaId, fileName: media.fileName, fileType: media.fileType });
  }
}

export function buildEmojiPayload(robotCode: string, msgId: string, conversationId: string): JsonObject {
  return {
    robotCode,
    openMsgId: msgId,
    openConversationId: conversationId,
    emotionType: 2,
    emotionName: THINKING_EMOTION_NAME,
    textEmotion: {
      emotionId: THINKING_EMOTION_ID,
      emotionName: THINKING_EMOTION_NAME,
      text: THINKING_EMOTION_NAME,
      backgroundId: THINKING_BACKGROUND_ID,
    },
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, attempts: number, baseDelay: number, signal?: AbortSignal): Promise<T> {
  let delay = baseDelay;
  let lastError: unknown;
  for (let i = 0; i < Math.max(attempts, 1); i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
    }
    if (i < attempts - 1) {
      await sleep(delay, signal);
      delay *= 2;
    }
  }
  throw lastError;
}

export class PendingEmojis<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();

  constructor(
    private readonly ttl = PENDING_TTL,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.prune();
    return this.entries.size;
  }

  add(id: string, value: T): void {
    this.prune();
    this.entries.delete(id);
    this.entries.set(id, { value, at: this.now() });
  }

  has(id: string): boolean {
    this.prune();
    return this.entries.has(id);
  }

  take(id: string): T | undefined {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    return entry.value;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttl;
    for (const [id, entry] of this.entries) {
      if (entry.at > cutoff) break;
      this.entries.delete(id);
    }
  }
}
