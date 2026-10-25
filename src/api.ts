import { asObject, int, parseJson, str } from "./helpers.js";
import type { ConnectionEndpoint, JsonObject, Subscription } from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.dingtalk.com";
export const DEFAULT_OAPI_BASE_URL = "https://oapi.dingtalk.com";
export const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024;

const TOKEN_TIMEOUT = 10_000;
const GATEWAY_TIMEOUT = 10_000;
const DOWNLOAD_TIMEOUT = 120_000;
const UPLOAD_TIMEOUT = 60_000;
const SEND_TIMEOUT = 30_000;
const TOKEN_REFRESH_MARGIN = 60_000;
const DEFAULT_TOKEN_LIFETIME = 3600;
const MAX_ERROR_BODY = 500;

export class DingTalkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
  ) {
    super(message);
    this.name = "DingTalkError";
  }
}

export interface ApiOptions {
  clientId: string;
  clientSecret: string;
  apiBaseUrl?: string;
  oapiBaseUrl?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
}

interface IssuedToken {
  token: string;
  expiresIn: number;
}

export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function shorten(text: string): string {
  return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) + "..." : text;
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function describeFailure(action: string, status: number, text: string): DingTalkError {
  const body = asObject(parseJson(text));
  const code = str(body, "code");
  const message = str(body, "message");
  const detail = code || message ? [code, message].filter(Boolean).join(": ") : shorten(text);
  return new DingTalkError(`${action} failed: HTTP ${status}${detail ? " " + detail : ""}`, status, code);
}

class TokenCache {
  private token = "";
  private expiresAt = 0;
  private pending: Promise<string> | undefined;

  constructor(private readonly issue: () => Promise<IssuedToken>) {}

  get(): Promise<string> {
    if (this.token && Date.now() + TOKEN_REFRESH_MARGIN < this.expiresAt) return Promise.resolve(this.token);
    this.pending ??= this.issue()
      .then(({ token, expiresIn }) => {
        this.token = token;
        this.expiresAt = Date.now() + (expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME) * 1000;
        return token;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export class DingTalkApi {
  readonly clientId: string;
  readonly apiBase: string;
  readonly oapiBase: string;
  private readonly clientSecret: string;
  private readonly apiToken = new TokenCache(() => this.issueAccessToken());
  private readonly oapiTokenCache = new TokenCache(() => this.issueOapiToken());

  constructor(opts: ApiOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.apiBase = trimBase(opts.apiBaseUrl || DEFAULT_API_BASE_URL);
    this.oapiBase = trimBase(opts.oapiBaseUrl || DEFAULT_OAPI_BASE_URL);
  }

  accessToken(): Promise<string> {
    return this.apiToken.get();
  }

  oapiToken(): Promise<string> {
    return this.oapiTokenCache.get();
  }

  private async issueAccessToken(): Promise<IssuedToken> {
    const res = await fetch(`${this.apiBase}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT),
    });
    const text = await readText(res);
    if (!res.ok) throw describeFailure("get access token", res.status, text);
    const body = asObject(parseJson(text));
    const token = str(body, "accessToken");
    if (!token) throw new DingTalkError("get access token failed: empty access token in response", res.status);
    return { token, expiresIn: int(body, "expireIn") };
  }

  private async issueOapiToken(): Promise<IssuedToken> {
    const query = new URLSearchParams({ appkey: this.clientId, appsecret: this.clientSecret });
    const res = await fetch(`${this.oapiBase}/gettoken?${query}`, { signal: AbortSignal.timeout(TOKEN_TIMEOUT) });
    const text = await readText(res);
    const body = asObject(parseJson(text));
    if (!body) throw new DingTalkError(`get OAPI token failed: HTTP ${res.status} invalid response`, res.status);
    const errcode = int(body, "errcode");
    if (errcode !== 0) throw new DingTalkError(`get OAPI token failed: ${errcode} ${str(body, "errmsg")}`, res.status, String(errcode));
    const token = str(body, "access_token");
    if (!token) throw new DingTalkError("get OAPI token failed: empty access token", res.status);
    return { token, expiresIn: int(body, "expires_in") };
  }

  async openConnection(subscriptions: Subscription[], userAgent: string, signal?: AbortSignal): Promise<ConnectionEndpoint> {
    const res = await fetch(`${this.apiBase}/v1.0/gateway/connections/open`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions,
        ua: userAgent,
        localIp: "",
      }),
      signal: withTimeout(signal, GATEWAY_TIMEOUT),
    });
    const text = await readText(res);
    if (res.status !== 200) throw describeFailure("open stream connection", res.status, text);
    const body = asObject(parseJson(text));
    const endpoint = str(body, "endpoint");
    const ticket = str(body, "ticket");
    if (!endpoint || !ticket) throw new DingTalkError("open stream connection failed: response has no endpoint or ticket", res.status);
    return { endpoint, ticket };
  }

  async post(path: string, payload: JsonObject, opts: RequestOptions = {}): Promise<JsonObject | undefined> {
    const token = await this.accessToken();
    const res = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(payload),
      signal: withTimeout(opts.signal, opts.timeout ?? SEND_TIMEOUT),
    });
    const text = await readText(res);
    if (res.status !== 200) {
      const code = str(asObject(parseJson(text)), "code");
      throw new DingTalkError(`${path} failed: HTTP ${res.status} ${shorten(text)}`.trimEnd(), res.status, code);
    }
    return asObject(parseJson(text));
  }

  async postWebhook(url: string, payload: JsonObject, opts: RequestOptions & { withToken?: boolean } = {}): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "*/*" };
    if (opts.withToken) headers["x-acs-dingtalk-access-token"] = await this.accessToken();
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: withTimeout(opts.signal, opts.timeout ?? SEND_TIMEOUT),
    });
    const text = await readText(res);
    if (res.status !== 200) throw new DingTalkError(`webhook failed: HTTP ${res.status} ${shorten(text)}`.trimEnd(), res.status);
    const body = asObject(parseJson(text));
    const errcode = body ? int(body, "errcode") : 0;
    if (errcode !== 0) throw new DingTalkError(`webhook failed: errcode ${errcode} ${str(body, "errmsg")}`.trimEnd(), res.status, String(errcode));
  }

  async downloadUrl(downloadCode: string, signal?: AbortSignal): Promise<string> {
    const body = await this.post(
      "/v1.0/robot/messageFiles/download",
      { downloadCode, robotCode: this.clientId },
      { signal, timeout: DOWNLOAD_TIMEOUT },
    );
    const url = str(body, "downloadUrl");
    if (!url) throw new Error("exchange download code failed: empty download URL");
    return url;
  }

  async download(url: string, maxSize = MAX_DOWNLOAD_SIZE, signal?: AbortSignal): Promise<{ data: Buffer; contentType: string }> {
    const res = await fetch(url, { signal: withTimeout(signal, DOWNLOAD_TIMEOUT) });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const tooLarge = () => new Error(`download too large: exceeds ${maxSize} bytes`);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxSize) {
      await res.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxSize) throw tooLarge();
      chunks.push(chunk);
    }
    return { data: Buffer.concat(chunks), contentType: res.headers.get("content-type") ?? "" };
  }

  async upload(data: Uint8Array<ArrayBuffer>, fileName: string, type: string, contentType: string, signal?: AbortSignal): Promise<string> {
    const token = await this.oapiToken();
    const form = new FormData();
    form.append("media", new Blob([data], { type: contentType }), fileName);
    const query = new URLSearchParams({ access_token: token, type });
    const res = await fetch(`${this.oapiBase}/media/upload?${query}`, {
      method: "POST",
      body: form,
      signal: withTimeout(signal, UPLOAD_TIMEOUT),
    });
    const text = await readText(res);
    const body = asObject(parseJson(text));
    if (!body) throw new DingTalkError(`upload failed: HTTP ${res.status} invalid response`, res.status);
    const errcode = int(body, "errcode");
    if (errcode !== 0) throw new DingTalkError(`upload error ${errcode}: ${str(body, "errmsg")}`, res.status, String(errcode));
    const mediaId = str(body, "media_id");
    if (!mediaId) throw new DingTalkError("upload failed: response has no media_id", res.status);
    return mediaId;
  }
}
