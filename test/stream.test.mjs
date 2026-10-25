import { test } from "node:test";
import assert from "node:assert/strict";

import { DingTalkApi } from "../dist/api.js";
import { StreamClient, ticketUrl } from "../dist/stream.js";
import { CLIENT_ID, CLIENT_SECRET, startFakeDingTalk } from "./fake-dingtalk.mjs";

function recorder() {
  const entries = [];
  const at = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") } };
}

const fast = { idleMs: 60_000, pongTimeoutMs: 1_000, minBackoffMs: 20, maxBackoffMs: 80, handshakeTimeoutMs: 2_000 };

async function startClient(t, fake, { timers = fast, secret = CLIENT_SECRET } = {}) {
  const messages = [];
  const { entries, log } = recorder();
  const api = new DingTalkApi({ clientId: CLIENT_ID, clientSecret: secret, apiBaseUrl: fake.url });
  const client = new StreamClient({ api, userAgent: "openbee-channel-dingtalk/test", log, timers, onBotMessage: (m) => messages.push(m) });
  t.after(() => client.stop());
  await client.start();
  return { client, messages, entries };
}

const until = async (cond, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("ticketUrl encodes the ticket", () => {
  assert.equal(ticketUrl("wss://host/connect", "a+b/c="), "wss://host/connect?ticket=a%2Bb%2Fc%3D");
  assert.equal(ticketUrl("wss://host/connect?x=1", "t"), "wss://host/connect?x=1&ticket=t");
});

test("opens the gateway connection and answers frames", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { client, messages } = await startClient(t, fake);
  assert.equal(client.connected, true);

  const open = fake.calls.find((c) => c.path === "/v1.0/gateway/connections/open");
  assert.deepEqual(open.body, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    subscriptions: [
      { type: "SYSTEM", topic: "disconnect" },
      { type: "SYSTEM", topic: "ping" },
      { type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" },
    ],
    ua: "openbee-channel-dingtalk/test",
    localIp: "",
  });
  const conn = await fake.waitForConnection(1);
  assert.equal(conn.ticket, "ticket+1/=");

  const ping = fake.frame("SYSTEM", "ping", JSON.stringify({ opaque: "x" }), "ping-1");
  fake.push(ping);
  assert.deepEqual(await fake.waitForResponse("ping-1"), {
    code: 200,
    headers: { contentType: "application/json", messageId: "ping-1" },
    message: "ok",
    data: JSON.stringify({ opaque: "x" }),
  });

  fake.push(fake.frame("EVENT", "chat_update_title", {}, "event-1"));
  assert.deepEqual(await fake.waitForResponse("event-1"), {
    code: 404,
    headers: { contentType: "application/json", messageId: "event-1" },
    message: "",
    data: "",
  });

  const ack = await fake.callback({ msgId: "m1", text: { content: "hi" } });
  assert.equal(ack.code, 200);
  assert.equal(ack.data, "");
  assert.deepEqual(messages, [{ msgId: "m1", text: { content: "hi" } }]);

  fake.push(fake.frame("CALLBACK", "/v1.0/im/bot/messages/get", "not json", "bad-1"));
  assert.equal((await fake.waitForResponse("bad-1")).code, 500);
  assert.equal(messages.length, 1);
});

test("a disconnect frame reconnects with a fresh ticket", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { client, messages } = await startClient(t, fake);
  const first = await fake.waitForConnection(1);
  fake.push(fake.frame("SYSTEM", "disconnect", { reason: "upgrade" }));
  const second = await fake.waitForConnection(2);
  assert.equal(second.ticket, "ticket+2/=");
  await until(() => first.closed);
  await until(() => client.connected);
  await fake.callback({ msgId: "after" }, second);
  assert.deepEqual(messages, [{ msgId: "after" }]);
});

test("keepalive pings an idle connection and keeps it when pong arrives", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  await startClient(t, fake, { timers: { ...fast, idleMs: 30, pongTimeoutMs: 200 } });
  const conn = await fake.waitForConnection(1);
  await until(() => conn.pings >= 3);
  assert.equal(fake.connections.length, 1);
  assert.equal(conn.closed, false);
});

test("a missing pong terminates the connection and reconnects", async (t) => {
  const fake = await startFakeDingTalk({}, { autoPong: false });
  t.after(() => fake.close());
  const { entries } = await startClient(t, fake, { timers: { ...fast, idleMs: 30, pongTimeoutMs: 30 } });
  const first = await fake.waitForConnection(1);
  await fake.waitForConnection(2);
  await until(() => first.closed);
  assert.ok(entries.some((e) => e.message === "stream ping timed out, reconnecting"));
});

test("reconnects with backoff and keeps retrying when the gateway rejects", async (t) => {
  let reject = 0;
  const fake = await startFakeDingTalk({
    "/v1.0/gateway/connections/open": () => (reject-- > 0 ? { status: 401, body: { code: "authFailed", message: "鉴权失败" } } : undefined),
  });
  t.after(() => fake.close());
  const { client, entries } = await startClient(t, fake);
  const first = await fake.waitForConnection(1);
  reject = 3;
  first.ws.terminate();
  await fake.waitForConnection(2, 5000);
  await until(() => client.connected);
  const rejected = entries.filter((e) => e.level === "error" && e.message === "DingTalk rejected the stream credentials, retrying");
  assert.equal(rejected.length, 3);
  assert.deepEqual(
    rejected.map((e) => e.fields.retry_in_ms),
    [40, 80, 80],
  );
  const opens = fake.calls.filter((c) => c.path === "/v1.0/gateway/connections/open");
  assert.equal(opens.length, 5);
});

test("stop closes the connection and prevents reconnects", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { client } = await startClient(t, fake);
  const conn = await fake.waitForConnection(1);
  await client.stop();
  await until(() => conn.closed);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.connections.length, 1);
  assert.equal(client.connected, false);
});
