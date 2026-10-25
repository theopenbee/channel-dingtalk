import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export const CLIENT_ID = "dingtestappkey";
export const CLIENT_SECRET = "test-app-secret";
export const API_TOKEN = "api-token-1";
export const OAPI_TOKEN = "oapi-token-1";

const TOKEN_PATHS = new Set([
  "/v1.0/robot/messageFiles/download",
  "/v1.0/robot/emotion/reply",
  "/v1.0/robot/emotion/recall",
  "/v1.0/robot/oToMessages/batchSend",
  "/v1.0/robot/groupMessages/send",
]);

function waitList() {
  const items = [];
  const waiters = [];
  return {
    items,
    add(item) {
      items.push(item);
      for (const w of [...waiters]) {
        if (w.match(item)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(item);
        }
      }
    },
    waitFor(match, ms = 5000, label = "item") {
      const found = items.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
        waiters.push({ match, resolve: (v) => (clearTimeout(timer), resolve(v)) });
      });
    },
  };
}

export async function startFakeDingTalk(handlers = {}, { autoPong = true } = {}) {
  const calls = waitList();
  const connections = waitList();
  const responses = waitList();
  const files = new Map();
  const codes = new Map();
  let tickets = 0;
  let mediaIds = 0;
  let base = "";

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://localhost");
    const contentType = req.headers["content-type"] ?? "";
    let body = raw.toString("latin1");
    if (contentType.includes("json")) {
      try {
        body = JSON.parse(raw.toString("utf8") || "null");
      } catch {
        body = raw.toString("utf8");
      }
    }
    const call = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      contentType,
      body,
      raw,
    };
    calls.add(call);
    const send = (status, payload, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    if (handlers[url.pathname]) {
      const out = await handlers[url.pathname](call);
      if (out !== undefined) return send(out.status ?? 200, out.body ?? {}, out.type);
    }
    if (TOKEN_PATHS.has(url.pathname) && req.headers["x-acs-dingtalk-access-token"] !== API_TOKEN) {
      return send(401, { code: "InvalidAuthentication", message: "token invalid" });
    }
    switch (url.pathname) {
      case "/v1.0/oauth2/accessToken":
        if (body?.appKey !== CLIENT_ID || body?.appSecret !== CLIENT_SECRET) {
          return send(400, { code: "invalidClientIdOrSecret", message: "无效的clientId或者clientSecret" });
        }
        return send(200, { expireIn: 7200, accessToken: API_TOKEN });
      case "/gettoken":
        if (call.query.appkey !== CLIENT_ID || call.query.appsecret !== CLIENT_SECRET) {
          return send(200, { errcode: 40089, errmsg: "invalid appkey or appsecret" });
        }
        return send(200, { errcode: 0, errmsg: "ok", access_token: OAPI_TOKEN, expires_in: 7200 });
      case "/v1.0/gateway/connections/open":
        if (body?.clientId !== CLIENT_ID || body?.clientSecret !== CLIENT_SECRET) {
          return send(401, { code: "authFailed", message: "鉴权失败" });
        }
        return send(200, { endpoint: `${base.replace(/^http/, "ws")}/connect`, ticket: `ticket+${++tickets}/=` });
      case "/v1.0/robot/messageFiles/download": {
        const name = codes.get(body?.downloadCode);
        if (!name || body?.robotCode !== CLIENT_ID) return send(400, { code: "invalidParameter", message: "downloadCode is invalid" });
        return send(200, { downloadUrl: `${base}/files/${encodeURIComponent(name)}?sig=abc` });
      }
      case "/media/upload":
        if (call.query.access_token !== OAPI_TOKEN) return send(200, { errcode: 40014, errmsg: "invalid access_token" });
        return send(200, { errcode: 0, errmsg: "ok", type: call.query.type, media_id: `@media-${++mediaIds}`, created_at: 1 });
      case "/v1.0/robot/emotion/reply":
      case "/v1.0/robot/emotion/recall":
        return send(200, { success: true });
      case "/v1.0/robot/oToMessages/batchSend":
      case "/v1.0/robot/groupMessages/send":
        return send(200, { processQueryKey: "pqk-1" });
    }
    if (url.pathname.startsWith("/files/")) {
      const file = files.get(decodeURIComponent(url.pathname.slice("/files/".length)));
      if (!file) return send(404, "not found", "text/plain");
      return send(200, file.data, file.type);
    }
    if (url.pathname.startsWith("/webhook/")) return send(200, { errcode: 0, errmsg: "ok" });
    return send(404, { code: "notFound", message: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true, autoPong });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/connect" || !url.searchParams.get("ticket")) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = { ws, ticket: url.searchParams.get("ticket"), closed: false, pings: 0 };
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        responses.add({ conn, frame });
      });
      ws.on("ping", () => conn.pings++);
      ws.on("close", () => (conn.closed = true));
      connections.add(conn);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  let frameIds = 0;

  const fake = {
    url: base,
    calls: calls.items,
    connections: connections.items,
    responses: responses.items,
    files,
    addFile(downloadCode, name, data, type = "application/octet-stream") {
      files.set(name, { data: Buffer.from(data), type });
      if (downloadCode) codes.set(downloadCode, name);
      return `${base}/files/${encodeURIComponent(name)}`;
    },
    webhook(name = "session") {
      return `${base}/webhook/${name}?session=xyz`;
    },
    waitFor(match, ms) {
      return calls.waitFor(match, ms, "dingtalk call");
    },
    waitForConnection(n, ms) {
      return connections.waitFor((c) => connections.items.indexOf(c) === n - 1, ms, `stream connection ${n}`);
    },
    waitForResponse(messageId, ms) {
      return responses.waitFor((r) => r.frame.headers?.messageId === messageId, ms, `response to ${messageId}`).then((r) => r.frame);
    },
    current() {
      return connections.items.at(-1);
    },
    push(frame, conn = fake.current()) {
      conn.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    frame(type, topic, data, messageId = `frame-${++frameIds}`) {
      return {
        specVersion: "1.0",
        type,
        headers: { topic, messageId, contentType: "application/json", time: String(Date.now()), appId: "app-1" },
        data: typeof data === "string" ? data : JSON.stringify(data),
      };
    },
    async callback(data, conn) {
      const frame = fake.frame("CALLBACK", "/v1.0/im/bot/messages/get", data);
      fake.push(frame, conn);
      return fake.waitForResponse(frame.headers.messageId);
    },
    async close() {
      for (const c of connections.items) c.ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return fake;
}
