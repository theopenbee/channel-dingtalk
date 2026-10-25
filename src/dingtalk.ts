import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import { ConfigError, type Attachment, type AttachmentType, type ChannelContext, type ChannelDefinition, type SendRequest } from "@theopenbee/channel-sdk";

import { DEFAULT_API_BASE_URL, DEFAULT_OAPI_BASE_URL, DingTalkApi, DingTalkError, MAX_DOWNLOAD_SIZE } from "./api.js";
import { audioDurationMs, extractFirstFrame, videoDurationSec, type Thumbnail } from "./ffmedia.js";
import {
  PendingEmojis,
  RETRY_COUNT,
  RETRY_DELAY,
  asObject,
  buildContext,
  buildEmojiPayload,
  buildProactiveMediaPayload,
  buildProactiveTextPayload,
  buildWebhookMediaPayload,
  buildWebhookTextPayload,
  dingTalkMediaType,
  encodeRaw,
  errorText,
  extensionFromMime,
  extname,
  hasProactiveTarget,
  imageContentType,
  int,
  isWebhookExpired,
  mimeExtension,
  parseRaw,
  proactivePath,
  retryWithBackoff,
  sanitizeFileName,
  str,
  type OutgoingMedia,
} from "./helpers.js";
import { StreamClient } from "./stream.js";
import type { ConversationTarget, DingTalkMediaType, JsonObject, MediaInfo } from "./types.js";

export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
export const MAX_VOICE_UPLOAD_SIZE = 2 * 1024 * 1024;

const EMOJI_RETRY_WINDOW = 30_000;
const EMOJI_REPLY_TIMEOUT = 5_000;
const EMOJI_RECALL_TIMEOUT = 3_000;
const SUPPORTED_TYPES = new Set(["text", "picture", "richText", "file", "audio", "video"]);

export interface DingTalkConfig {
  clientId: string;
  clientSecret: string;
  ffprobePath: string;
  ffmpegPath: string;
  apiBaseUrl: string;
  oapiBaseUrl: string;
}

function stringValue(raw: Record<string, unknown>, key: string, fallback = ""): string {
  const value = raw[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function readConfig(raw: Record<string, unknown>): DingTalkConfig {
  const clientId = stringValue(raw, "client_id");
  if (!clientId) throw new ConfigError("client_id is required");
  const clientSecret = stringValue(raw, "client_secret");
  if (!clientSecret) throw new ConfigError("client_secret is required");
  return {
    clientId,
    clientSecret,
    ffprobePath: stringValue(raw, "ffprobe_path", "ffprobe"),
    ffmpegPath: stringValue(raw, "ffmpeg_path", "ffmpeg"),
    apiBaseUrl: stringValue(raw, "api_base_url", DEFAULT_API_BASE_URL),
    oapiBaseUrl: stringValue(raw, "oapi_base_url", DEFAULT_OAPI_BASE_URL),
  };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const USER_AGENT = `openbee-channel-dingtalk/${packageVersion()}`;

function isCredentialRejection(err: unknown): err is DingTalkError {
  return err instanceof DingTalkError && (err.status === 400 || err.status === 401 || err.status === 403);
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("send cancelled");
}

function wrap(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${errorText(err)}`);
}

interface Extracted {
  text: string;
  attachments: Attachment[];
}

export function createDingTalkChannel(): ChannelDefinition {
  let cfg: DingTalkConfig;
  let api: DingTalkApi | undefined;
  const pending = new PendingEmojis<Promise<void>>();
  const background = new AbortController();

  const emoji = async (ctx: ChannelContext, action: "reply" | "recall", msgId: string, conversationId: string): Promise<void> => {
    const deadline = AbortSignal.any([background.signal, AbortSignal.timeout(EMOJI_RETRY_WINDOW)]);
    const payload = buildEmojiPayload(cfg.clientId, msgId, conversationId);
    const timeout = action === "reply" ? EMOJI_REPLY_TIMEOUT : EMOJI_RECALL_TIMEOUT;
    try {
      await retryWithBackoff(() => api!.post(`/v1.0/robot/emotion/${action}`, payload, { signal: deadline, timeout }), RETRY_COUNT, RETRY_DELAY, deadline);
    } catch (err) {
      if (background.signal.aborted) return;
      ctx.log.warn(`${action} emoji failed after retries`, { msg_id: msgId, error: errorText(err) });
    }
  };

  const failed = (type: AttachmentType, name?: string): Attachment => (name ? { type, path: "", name } : { type, path: "" });

  const save = async (ctx: ChannelContext, type: AttachmentType, url: string, ext: (contentType: string) => string, name?: string): Promise<Attachment> => {
    const { data, contentType } = await api!.download(url, MAX_DOWNLOAD_SIZE, background.signal);
    const path = await ctx.saveMedia(data, ext(contentType));
    return name ? { type, path, name } : { type, path };
  };

  const fetchByCode = async (
    ctx: ChannelContext,
    type: AttachmentType,
    downloadCode: string,
    ext: (contentType: string) => string,
    name?: string,
  ): Promise<Attachment> => {
    if (!downloadCode) return failed(type, name);
    try {
      const url = await api!.downloadUrl(downloadCode, background.signal);
      return await save(ctx, type, url, ext, name);
    } catch (err) {
      ctx.log.error(`download ${type} failed`, { error: errorText(err) });
      return failed(type, name);
    }
  };

  const fetchByUrl = async (ctx: ChannelContext, url: string): Promise<Attachment> => {
    try {
      return await save(ctx, "image", url, extensionFromMime);
    } catch (err) {
      ctx.log.error("download richtext image failed", { error: errorText(err) });
      return failed("image");
    }
  };

  const richText = async (ctx: ChannelContext, content: JsonObject | undefined): Promise<Extracted> => {
    const items = Array.isArray(content?.richText) ? content.richText : [];
    const results = await Promise.all(
      items.map(async (item): Promise<{ text: string; image?: Attachment }> => {
        const entry = asObject(item);
        if (!entry) return { text: "" };
        const text = str(entry, "text");
        const pictureUrl = str(entry, "pictureUrl");
        if (pictureUrl) return { text, image: await fetchByUrl(ctx, pictureUrl) };
        const code = str(entry, "downloadCode") || str(entry, "pictureDownloadCode");
        if (code) return { text, image: await fetchByCode(ctx, "image", code, extensionFromMime) };
        return { text };
      }),
    );
    return {
      text: results
        .map((r) => r.text)
        .filter(Boolean)
        .join("\n"),
      attachments: results.flatMap((r) => (r.image ? [r.image] : [])),
    };
  };

  const extract = async (ctx: ChannelContext, msgtype: string, data: JsonObject): Promise<Extracted> => {
    const content = asObject(data.content);
    const code = str(content, "downloadCode");
    switch (msgtype) {
      case "text":
        return { text: str(asObject(data.text), "content").trim(), attachments: [] };
      case "picture":
        return { text: "", attachments: [await fetchByCode(ctx, "image", code, extensionFromMime)] };
      case "video": {
        const videoType = str(content, "videoType");
        const ext = (ct: string) => mimeExtension(ct) ?? (videoType ? "." + videoType : ".mp4");
        return { text: "", attachments: [await fetchByCode(ctx, "video", code, ext)] };
      }
      case "file": {
        const fileName = str(content, "fileName");
        const ext = () => extname(fileName) || ".bin";
        return { text: "", attachments: [await fetchByCode(ctx, "document", code, ext, fileName || undefined)] };
      }
      case "audio": {
        const ext = (ct: string) => mimeExtension(ct) ?? ".ogg";
        return { text: str(content, "recognition").trim(), attachments: [await fetchByCode(ctx, "audio", code, ext)] };
      }
      case "richText":
        return richText(ctx, content);
      default:
        return { text: "", attachments: [] };
    }
  };

  const handleBotMessage = async (ctx: ChannelContext, data: JsonObject): Promise<void> => {
    const msgtype = str(data, "msgtype") || "text";
    const msgId = str(data, "msgId");
    const conversationId = str(data, "conversationId");
    const senderStaffId = str(data, "senderStaffId");
    ctx.log.info("received message", {
      msg_id: msgId,
      conversation_id: conversationId,
      conversation_type: str(data, "conversationType"),
      msgtype,
    });
    if (!SUPPORTED_TYPES.has(msgtype)) {
      ctx.log.warn("skipping unsupported message type", { msgtype });
      return;
    }
    if (!senderStaffId) {
      ctx.log.warn("skipping message with empty senderStaffId", { msg_id: msgId });
      return;
    }
    const { text, attachments } = await extract(ctx, msgtype, data);
    if (!text && attachments.length === 0) return;
    const createAt = int(data, "createAt");
    ctx.dispatch({
      chat_id: conversationId,
      sender_id: senderStaffId,
      message_id: msgId || undefined,
      text,
      attachments,
      raw: encodeRaw(data),
      context: buildContext(data),
      time: createAt > 0 ? createAt : undefined,
    });
    if (msgId) pending.add(msgId, emoji(ctx, "reply", msgId, conversationId));
  };

  const uploadFile = async (path: string, fileName: string, type: DingTalkMediaType, signal: AbortSignal): Promise<string> => {
    const info = await stat(path);
    const limit = type === "voice" ? MAX_VOICE_UPLOAD_SIZE : MAX_UPLOAD_SIZE;
    if (info.size > limit) throw new Error(`file too large: ${info.size} bytes (max ${limit})`);
    const data = await readFile(path);
    const contentType = type === "image" ? imageContentType(fileName) : "application/octet-stream";
    return api!.upload(data, fileName, type, contentType, signal);
  };

  const sendText = async (target: ConversationTarget, expired: boolean, content: string, signal: AbortSignal): Promise<void> => {
    if (expired) {
      try {
        await api!.post(proactivePath(target.conversationType), buildProactiveTextPayload(cfg.clientId, target, content), { signal });
      } catch (err) {
        throw wrap("proactive text send", err);
      }
      return;
    }
    try {
      await api!.postWebhook(target.sessionWebhook, buildWebhookTextPayload(content), { signal });
    } catch (err) {
      throw wrap("reply send", err);
    }
  };

  const sendMedia = async (ctx: ChannelContext, target: ConversationTarget, expired: boolean, media: NonNullable<SendRequest["media"]>, signal: AbortSignal) => {
    const fileName = sanitizeFileName(media.name || basename(media.path));
    const ext = extname(fileName) || extname(media.path);
    const type = dingTalkMediaType(ext);
    const info: MediaInfo = { durationMs: 0, durationSec: 0, picMediaId: "" };
    if (type === "voice") {
      try {
        info.durationMs = await audioDurationMs(media.path, cfg.ffprobePath, signal);
      } catch (err) {
        ctx.log.warn("could not probe audio duration, using 0", { error: errorText(err) });
      }
    } else if (type === "video") {
      try {
        info.durationSec = await videoDurationSec(media.path, cfg.ffprobePath, signal);
      } catch (err) {
        ctx.log.warn("could not probe video duration, using 0", { error: errorText(err) });
      }
      let thumb: Thumbnail | undefined;
      try {
        thumb = await extractFirstFrame(media.path, cfg.ffmpegPath, signal);
      } catch (err) {
        ctx.log.warn("could not extract video thumbnail", { error: errorText(err) });
      }
      if (thumb) {
        try {
          checkAborted(signal);
          info.picMediaId = await uploadFile(thumb.path, sanitizeFileName(basename(thumb.path)), "image", signal);
        } catch (err) {
          ctx.log.warn("could not upload video thumbnail", { error: errorText(err) });
        } finally {
          await thumb.cleanup();
        }
      }
    }
    checkAborted(signal);
    let mediaId: string;
    try {
      mediaId = await uploadFile(media.path, fileName, type, signal);
    } catch (err) {
      throw wrap("upload media", err);
    }
    checkAborted(signal);
    const outgoing: OutgoingMedia = { type, mediaId, fileName, fileType: ext.replace(/^\./, ""), info };
    if (expired) {
      try {
        await api!.post(proactivePath(target.conversationType), buildProactiveMediaPayload(cfg.clientId, target, outgoing), { signal });
      } catch (err) {
        throw wrap("proactive media send", err);
      }
      return;
    }
    try {
      await api!.postWebhook(target.sessionWebhook, buildWebhookMediaPayload(outgoing), { signal, withToken: true });
    } catch (err) {
      throw wrap("send media", err);
    }
  };

  return {
    async start(ctx) {
      cfg = readConfig(ctx.config);
      api = new DingTalkApi({
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        apiBaseUrl: cfg.apiBaseUrl,
        oapiBaseUrl: cfg.oapiBaseUrl,
      });
      try {
        await api.accessToken();
      } catch (err) {
        if (isCredentialRejection(err)) throw new ConfigError(`DingTalk rejected client_id/client_secret: ${err.message}`);
        throw err;
      }
      const stream = new StreamClient({
        api,
        userAgent: USER_AGENT,
        log: ctx.log,
        onBotMessage: (data) => {
          handleBotMessage(ctx, data).catch((err) => ctx.log.error("handle message failed", { error: errorText(err) }));
        },
        onFatal: (err) => {
          process.stderr.write(`fatal: ${errorText(err)}\n`);
          process.exit(1);
        },
      });
      try {
        await stream.start();
      } catch (err) {
        await stream.stop();
        if (isCredentialRejection(err)) throw new ConfigError(`DingTalk rejected the stream connection: ${err.message}`);
        throw err;
      }
      ctx.log.info("DingTalk bot started", { client_id: cfg.clientId });
      return {
        stop: async () => {
          background.abort();
          await stream.stop();
        },
      };
    },

    async send(msg: SendRequest, ctx, signal) {
      if (!api) throw new Error("dingtalk channel is not started");
      const target = parseRaw(msg.reply_to?.raw);
      if (!target) throw new Error(`dingtalk: no conversation context for session ${JSON.stringify(msg.session_key)}`);
      if (!msg.proactive && target.msgId) {
        const added = pending.take(target.msgId);
        if (added) void added.then(() => emoji(ctx, "recall", target.msgId, target.conversationId));
      }
      const expired = isWebhookExpired(target);
      if (expired) {
        if (!hasProactiveTarget(target)) throw new Error(`dingtalk: no conversation context for session ${JSON.stringify(msg.session_key)}`);
        ctx.log.info("sessionWebhook expired, using proactive API", {
          session_key: msg.session_key,
          conversation_type: target.conversationType,
        });
      }
      if (msg.content) {
        checkAborted(signal);
        await sendText(target, expired, msg.content, signal);
      }
      if (msg.media) {
        checkAborted(signal);
        await sendMedia(ctx, target, expired, msg.media, signal);
      }
      return {};
    },
  };
}
