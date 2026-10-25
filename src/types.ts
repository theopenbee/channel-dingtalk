export type JsonObject = Record<string, unknown>;

export interface DataFrameResponse {
  code: number;
  headers: Record<string, string>;
  message: string;
  data: string;
}

export interface Subscription {
  type: string;
  topic: string;
}

export interface ConnectionEndpoint {
  endpoint: string;
  ticket: string;
}

export interface ConversationTarget {
  conversationId: string;
  conversationType: string;
  senderStaffId: string;
  msgId: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime: number;
}

export type DingTalkMediaType = "image" | "voice" | "video" | "file";

export interface MediaInfo {
  durationMs: number;
  durationSec: number;
  picMediaId: string;
}
