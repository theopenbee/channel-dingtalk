import WebSocket from "ws";
import type { Logger } from "@theopenbee/channel-sdk";

import { DingTalkError, type DingTalkApi } from "./api.js";
import { asObject, errorText, parseJson, sleep, str } from "./helpers.js";
import type { DataFrameResponse, JsonObject, Subscription } from "./types.js";

export const BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";

export const SUBSCRIPTIONS: Subscription[] = [
  { type: "SYSTEM", topic: "disconnect" },
  { type: "SYSTEM", topic: "ping" },
  { type: "CALLBACK", topic: BOT_MESSAGE_TOPIC },
];

export interface StreamTimers {
  idleMs: number;
  pongTimeoutMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  handshakeTimeoutMs: number;
}

export const DEFAULT_TIMERS: StreamTimers = {
  idleMs: 30_000,
  pongTimeoutMs: 5_000,
  minBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  handshakeTimeoutMs: 10_000,
};

export interface StreamOptions {
  api: Pick<DingTalkApi, "openConnection">;
  userAgent: string;
  log: Logger;
  onBotMessage: (data: JsonObject) => void;
  onFatal?: (err: unknown) => void;
  timers?: Partial<StreamTimers>;
}

export function ticketUrl(endpoint: string, ticket: string): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}

function frameText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export class StreamClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private reconnecting = false;
  private backoff: number;
  private idleTimer: NodeJS.Timeout | undefined;
  private pongTimer: NodeJS.Timeout | undefined;
  private readonly controller = new AbortController();
  private readonly timers: StreamTimers;

  constructor(private readonly opts: StreamOptions) {
    this.timers = { ...DEFAULT_TIMERS, ...opts.timers };
    this.backoff = this.timers.minBackoffMs;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    const ws = await this.connect();
    if (this.stopped) {
      ws.terminate();
      return;
    }
    this.attach(ws);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    this.clearKeepalive();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      timer.unref();
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close(1000);
    });
  }

  private async connect(): Promise<WebSocket> {
    const signal = this.controller.signal;
    const { endpoint, ticket } = await this.opts.api.openConnection(SUBSCRIPTIONS, this.opts.userAgent, signal);
    const ws = new WebSocket(ticketUrl(endpoint, ticket), { handshakeTimeout: this.timers.handshakeTimeoutMs });
    let failure: Error | undefined;
    ws.on("error", (err) => {
      failure = err;
      if (this.ws === ws) this.opts.log.warn("stream connection error", { error: err.message });
    });
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => ws.terminate();
      const done = () => {
        signal.removeEventListener("abort", onAbort);
        ws.off("open", onOpen);
        ws.off("close", onClose);
      };
      const onOpen = () => {
        done();
        resolve();
      };
      const onClose = (code: number) => {
        done();
        reject(new Error(`stream connection failed: ${failure?.message ?? `closed with code ${code}`}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ws.on("open", onOpen);
      ws.on("close", onClose);
    });
    return ws;
  }

  private attach(ws: WebSocket): void {
    this.ws = ws;
    this.backoff = this.timers.minBackoffMs;
    ws.on("message", (data, isBinary) => {
      this.alive(ws);
      if (!isBinary) this.handleFrame(ws, frameText(data));
    });
    ws.on("ping", () => this.alive(ws));
    ws.on("pong", () => this.alive(ws));
    ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
    this.armIdle(ws);
  }

  private alive(ws: WebSocket): void {
    if (this.ws !== ws) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = undefined;
    this.armIdle(ws);
  }

  private armIdle(ws: WebSocket): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.keepalive(ws), this.timers.idleMs);
    this.idleTimer.unref();
  }

  private keepalive(ws: WebSocket): void {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch (err) {
      this.opts.log.warn("stream ping failed, reconnecting", { error: errorText(err) });
      ws.terminate();
      return;
    }
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      this.opts.log.warn("stream ping timed out, reconnecting");
      ws.terminate();
    }, this.timers.pongTimeoutMs);
    this.pongTimer.unref();
  }

  private clearKeepalive(): void {
    clearTimeout(this.idleTimer);
    clearTimeout(this.pongTimer);
    this.idleTimer = undefined;
    this.pongTimer = undefined;
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.clearKeepalive();
    if (this.stopped) return;
    this.opts.log.warn("stream connection closed, reconnecting", { code, reason, retry_in_ms: this.backoff });
    this.reconnect(false);
  }

  private reply(ws: WebSocket, messageId: string, code: number, data = "", message = ""): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const response: DataFrameResponse = {
      code,
      headers: { contentType: "application/json", messageId },
      message,
      data,
    };
    ws.send(JSON.stringify(response), (err) => {
      if (err) this.opts.log.warn("send stream response failed", { error: err.message });
    });
  }

  private handleFrame(ws: WebSocket, text: string): void {
    const frame = asObject(parseJson(text));
    const headers = asObject(frame?.headers);
    if (!frame || !headers) {
      this.opts.log.warn("ignoring invalid stream frame", { length: text.length });
      return;
    }
    const type = str(frame, "type");
    const topic = str(headers, "topic");
    const messageId = str(headers, "messageId");
    const data = str(frame, "data");
    if (type === "SYSTEM" && topic === "ping") {
      this.reply(ws, messageId, 200, data, "ok");
      return;
    }
    if (type === "SYSTEM" && topic === "disconnect") {
      this.opts.log.info("DingTalk asked the stream to reconnect");
      this.replace(ws);
      return;
    }
    if (type === "CALLBACK" && topic === BOT_MESSAGE_TOPIC) {
      const message = asObject(parseJson(data));
      if (!message) {
        this.reply(ws, messageId, 500, "", "invalid bot message callback data");
        return;
      }
      this.reply(ws, messageId, 200);
      try {
        this.opts.onBotMessage(message);
      } catch (err) {
        this.opts.log.error("handle bot message failed", { error: errorText(err) });
      }
      return;
    }
    this.reply(ws, messageId, 404);
  }

  private replace(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.clearKeepalive();
    ws.close(1000);
    if (!this.stopped) this.reconnect(true);
  }

  private reconnect(immediate: boolean): void {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    this.reconnectLoop(immediate)
      .catch((err) => {
        if (this.opts.onFatal) this.opts.onFatal(err);
        else this.opts.log.error("stream reconnect loop failed", { error: errorText(err) });
      })
      .finally(() => {
        this.reconnecting = false;
      });
  }

  private async reconnectLoop(immediate: boolean): Promise<void> {
    let wait = !immediate;
    while (!this.stopped) {
      if (wait) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.timers.maxBackoffMs);
        try {
          await sleep(delay, this.controller.signal);
        } catch {
          return;
        }
      }
      wait = true;
      let ws: WebSocket;
      try {
        ws = await this.connect();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof DingTalkError && err.status === 401) {
          this.opts.log.error("DingTalk rejected the stream credentials, retrying", { error: err.message, retry_in_ms: this.backoff });
        } else {
          this.opts.log.warn("stream reconnect failed", { error: errorText(err), retry_in_ms: this.backoff });
        }
        continue;
      }
      if (this.stopped) {
        ws.terminate();
        return;
      }
      this.attach(ws);
      this.opts.log.info("stream reconnected");
      return;
    }
  }
}
