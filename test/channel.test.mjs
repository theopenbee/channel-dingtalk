import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { API_TOKEN, CLIENT_ID, CLIENT_SECRET, OAPI_TOKEN, startFakeDingTalk } from "./fake-dingtalk.mjs";
import { fakeBinaries } from "./fakebin.mjs";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function startPlugin() {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  let nextId = 1;
  return {
    child,
    exited,
    messages,
    stderr: () => stderr,
    waitFor(match, ms = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out; stderr: ${stderr}`)), ms);
        waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return this.waitFor((m) => m.id === id, 15000);
    },
  };
}

async function initialized(t, fake, config = {}) {
  const mediaDir = mkdtempSync(join(tmpdir(), "dt-media-"));
  const dataDir = mkdtempSync(join(tmpdir(), "dt-data-"));
  const bin = fakeBinaries();
  const p = startPlugin();
  t.after(async () => {
    p.child.stdin.end();
    await p.exited;
  });
  const res = await p.request("initialize", {
    protocol_version: 1,
    openbee_version: "test",
    channel_id: "dingtalk",
    language: "zh",
    bot_name: "OpenBee",
    config: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      api_base_url: fake.url,
      oapi_base_url: fake.url + "/",
      ffprobe_path: bin.missing,
      ffmpeg_path: bin.missing,
      ...config,
    },
    data_dir: dataDir,
    media_dir: mediaDir,
  });
  return { p, res, mediaDir, bin };
}

function message(fake, over = {}) {
  return {
    conversationId: "cidGroup1==",
    atUsers: [{ dingtalkId: "$:LWCP_v1:$bot" }],
    chatbotCorpId: "dingcorp",
    chatbotUserId: "$:LWCP_v1:$bot",
    msgId: "msg-1",
    senderNick: "Alice",
    isAdmin: false,
    senderStaffId: "staff-1",
    sessionWebhookExpiredTime: Date.now() + 3_600_000,
    createAt: 1700000000000,
    senderCorpId: "dingcorp",
    conversationType: "2",
    senderId: "$:LWCP_v1:$alice",
    conversationTitle: "Team",
    isInAtList: true,
    sessionWebhook: fake.webhook("s1"),
    text: { content: "  hello  " },
    msgtype: "text",
    ...over,
  };
}

const inbound = (p, msgId) => p.waitFor((m) => m.method === "inbound" && m.params.message_id === msgId).then((m) => m.params);
const logged = (p, text) => p.waitFor((m) => m.method === "log" && m.params.message === text);

function assertNoSecrets(p) {
  const output = JSON.stringify(p.messages.filter((m) => m.method === "log")) + p.stderr();
  for (const secret of [CLIENT_SECRET, API_TOKEN, OAPI_TOKEN, "session=xyz", "sig=abc"]) {
    assert.ok(!output.includes(secret), `log output leaks ${secret}`);
  }
}

function writeMedia(dir, name, data) {
  const path = join(dir, name);
  writeFileSync(path, data);
  return { path, name };
}

function send(p, raw, over = {}) {
  return p.request("send", {
    session_key: "dingtalk:cidGroup1==:staff-1",
    chat_id: "cidGroup1==",
    session_scope: "staff-1",
    proactive: false,
    reply_to: raw === undefined ? undefined : { message_id: "msg-1", raw },
    ...over,
  });
}

const emojiPayload = (msgId, conversationId = "cidGroup1==") => ({
  robotCode: CLIENT_ID,
  openMsgId: msgId,
  openConversationId: conversationId,
  emotionType: 2,
  emotionName: "🤔思考中",
  textEmotion: { emotionId: "2659900", emotionName: "🤔思考中", text: "🤔思考中", backgroundId: "im_bg_1" },
});

test("rejected credentials are a config error", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake, { client_secret: "wrong" });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /rejected client_id\/client_secret.*invalidClientIdOrSecret/);
  assert.doesNotMatch(res.error.message, /wrong/);
  assert.equal(await p.exited, 1);
  assert.equal(fake.calls.filter((c) => c.path === "/v1.0/gateway/connections/open").length, 0);
  assertNoSecrets(p);
});

test("missing credentials are a config error", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake, { client_id: "" });
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /client_id is required/);
  assert.equal(await p.exited, 1);
});

test("a rejected stream connection is a config error", async (t) => {
  const fake = await startFakeDingTalk({
    "/v1.0/gateway/connections/open": () => ({ status: 401, body: { code: "authFailed", message: "鉴权失败" } }),
  });
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake);
  assert.equal(res.error.code, -32001);
  assert.match(res.error.message, /authFailed/);
  assert.equal(await p.exited, 1);
});

test("transient startup failures are not config errors", async (t) => {
  const fake = await startFakeDingTalk({ "/v1.0/oauth2/accessToken": () => ({ status: 503, body: "busy", type: "text/plain" }) });
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake);
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /HTTP 503/);
  assert.equal(await p.exited, 1);
});

test("startup connects the stream, answers pings and reconnects on disconnect", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, res } = await initialized(t, fake, { ffprobe_path: "", ffmpeg_path: "" });
  assert.deepEqual(res.result, { protocol_version: 1 });
  const open = fake.calls.find((c) => c.path === "/v1.0/gateway/connections/open");
  assert.match(open.body.ua, /^openbee-channel-dingtalk\/0\.1\.0$/);
  const first = await fake.waitForConnection(1);
  assert.equal(first.ticket, "ticket+1/=");

  fake.push(fake.frame("SYSTEM", "ping", '{"opaque":"1"}', "ping-1"));
  const pong = await fake.waitForResponse("ping-1");
  assert.equal(pong.code, 200);
  assert.equal(pong.data, '{"opaque":"1"}');

  fake.push(fake.frame("SYSTEM", "disconnect", { reason: "server restart" }));
  const second = await fake.waitForConnection(2);
  assert.equal(second.ticket, "ticket+2/=");
  await fake.callback(message(fake, { msgId: "after-reconnect" }), second);
  assert.equal((await inbound(p, "after-reconnect")).text, "hello");
});

test("text messages are acked, dispatched and get the thinking emoji", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  const data = message(fake);
  const ack = await fake.callback(data);
  assert.deepEqual(ack, { code: 200, headers: { contentType: "application/json", messageId: ack.headers.messageId }, message: "", data: "" });

  const got = await inbound(p, "msg-1");
  assert.deepEqual(got, {
    chat_id: "cidGroup1==",
    sender_id: "staff-1",
    message_id: "msg-1",
    text: "hello",
    attachments: [],
    raw: JSON.stringify({
      conversationId: "cidGroup1==",
      conversationType: "2",
      senderStaffId: "staff-1",
      msgId: "msg-1",
      sessionWebhook: data.sessionWebhook,
      sessionWebhookExpiredTime: data.sessionWebhookExpiredTime,
    }),
    context: {
      conversationId: "cidGroup1==",
      atUsers: [{ dingtalkId: "$:LWCP_v1:$bot" }],
      chatbotCorpId: "dingcorp",
      chatbotUserId: "$:LWCP_v1:$bot",
      msgId: "msg-1",
      senderNick: "Alice",
      isAdmin: false,
      senderStaffId: "staff-1",
      senderCorpId: "dingcorp",
      conversationType: "2",
      senderId: "$:LWCP_v1:$alice",
      conversationTitle: "Team",
      msgtype: "text",
    },
    time: 1700000000000,
  });

  const reply = await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/reply");
  assert.equal(reply.headers["x-acs-dingtalk-access-token"], API_TOKEN);
  assert.deepEqual(reply.body, emojiPayload("msg-1"));
});

test("the thinking emoji is retried until it succeeds", async (t) => {
  let failures = 2;
  const fake = await startFakeDingTalk({
    "/v1.0/robot/emotion/reply": () => (failures-- > 0 ? { status: 500, body: { code: "busy" } } : undefined),
  });
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  await fake.callback(message(fake, { msgId: "retry-1" }));
  await inbound(p, "retry-1");
  const replies = () => fake.calls.filter((c) => c.path === "/v1.0/robot/emotion/reply").length;
  await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/reply" && replies() === 3, 5000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(replies(), 3);
});

test("media messages are downloaded into the media dir", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, mediaDir } = await initialized(t, fake);
  await fake.waitForConnection(1);
  fake.addFile("pic-code", "pic", "PNGDATA", "image/png");
  fake.addFile("file-code", "doc", "PDFDATA", "application/octet-stream");
  fake.addFile("audio-code", "voice", "OGGDATA", "application/octet-stream");
  fake.addFile("video-code", "clip", "MOVDATA", "application/octet-stream");
  fake.addFile("rich-code", "rich", "GIFDATA", "image/gif");
  const pictureUrl = fake.addFile("", "direct", "JPGDATA", "image/jpeg");

  await fake.callback(message(fake, { msgId: "pic", msgtype: "picture", text: undefined, content: { downloadCode: "pic-code", pictureDownloadCode: "x" } }));
  await fake.callback(message(fake, { msgId: "file", msgtype: "file", text: undefined, content: { downloadCode: "file-code", fileName: "report.pdf", fileId: "f1" } }));
  await fake.callback(message(fake, { msgId: "audio", msgtype: "audio", text: undefined, content: { downloadCode: "audio-code", recognition: "你好世界", duration: 3000 } }));
  await fake.callback(message(fake, { msgId: "video", msgtype: "video", text: undefined, content: { downloadCode: "video-code", videoType: "mov", duration: 4 } }));
  await fake.callback(
    message(fake, {
      msgId: "rich",
      msgtype: "richText",
      text: undefined,
      content: {
        richText: [
          { text: "first line" },
          { pictureUrl, type: "picture" },
          { downloadCode: "rich-code", type: "picture" },
          { text: "second line" },
          { pictureDownloadCode: "missing-code", type: "picture" },
        ],
      },
    }),
  );

  const check = (att, type, ext, data, name) => {
    assert.equal(att.type, type);
    assert.equal(dirname(att.path), mediaDir);
    assert.ok(att.path.endsWith(ext), `${att.path} should end with ${ext}`);
    assert.equal(readFileSync(att.path, "utf8"), data);
    assert.equal(att.name, name);
  };

  const pic = await inbound(p, "pic");
  assert.equal(pic.text, "");
  assert.equal(pic.attachments.length, 1);
  check(pic.attachments[0], "image", ".png", "PNGDATA", undefined);

  const file = await inbound(p, "file");
  check(file.attachments[0], "document", ".pdf", "PDFDATA", "report.pdf");
  assert.equal(file.context.msgtype, "file");

  const audio = await inbound(p, "audio");
  assert.equal(audio.text, "你好世界");
  check(audio.attachments[0], "audio", ".ogg", "OGGDATA", undefined);

  const video = await inbound(p, "video");
  check(video.attachments[0], "video", ".mov", "MOVDATA", undefined);

  const rich = await inbound(p, "rich");
  assert.equal(rich.text, "first line\nsecond line");
  assert.equal(rich.attachments.length, 3);
  check(rich.attachments[0], "image", ".jpg", "JPGDATA", undefined);
  check(rich.attachments[1], "image", ".gif", "GIFDATA", undefined);
  assert.deepEqual(rich.attachments[2], { type: "image", path: "" });

  const exchange = fake.calls.find((c) => c.path === "/v1.0/robot/messageFiles/download" && c.body.downloadCode === "pic-code");
  assert.deepEqual(exchange.body, { downloadCode: "pic-code", robotCode: CLIENT_ID });
  assertNoSecrets(p);
});

test("failed downloads still dispatch placeholder attachments", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  await fake.callback(message(fake, { msgId: "bad-pic", msgtype: "picture", content: { downloadCode: "nope" } }));
  await fake.callback(message(fake, { msgId: "bad-file", msgtype: "file", content: { downloadCode: "nope", fileName: "a.zip" } }));
  await fake.callback(message(fake, { msgId: "no-content", msgtype: "video" }));
  await fake.callback(message(fake, { msgId: "bad-audio", msgtype: "audio", content: { recognition: "", downloadCode: "nope" } }));
  assert.deepEqual((await inbound(p, "bad-pic")).attachments, [{ type: "image", path: "" }]);
  assert.deepEqual((await inbound(p, "bad-file")).attachments, [{ type: "document", path: "", name: "a.zip" }]);
  assert.deepEqual((await inbound(p, "no-content")).attachments, [{ type: "video", path: "" }]);
  const audio = await inbound(p, "bad-audio");
  assert.equal(audio.text, "");
  assert.deepEqual(audio.attachments, [{ type: "audio", path: "" }]);
  assertNoSecrets(p);
});

test("unsupported, anonymous and empty messages are skipped", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  assert.equal((await fake.callback(message(fake, { msgId: "card", msgtype: "interactiveCard" }))).code, 200);
  await logged(p, "skipping unsupported message type");
  await fake.callback(message(fake, { msgId: "anon", senderStaffId: "" }));
  await logged(p, "skipping message with empty senderStaffId");
  await fake.callback(message(fake, { msgId: "blank", text: { content: "   " } }));
  await fake.callback(message(fake, { msgId: "no-type", msgtype: undefined, text: { content: "default type" } }));
  const first = await p.waitFor((m) => m.method === "inbound");
  assert.equal(first.params.message_id, "no-type");
  assert.equal(first.params.text, "default type");
  assert.equal(first.params.context.msgtype, undefined);
  assert.equal(p.messages.filter((m) => m.method === "inbound").length, 1);
});

test("replies go to the session webhook and recall the thinking emoji", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  await fake.callback(message(fake));
  const got = await inbound(p, "msg-1");
  await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/reply");

  const res = await send(p, got.raw, { content: "**done**" });
  assert.deepEqual(res.result, {});
  const hook = fake.calls.find((c) => c.path === "/webhook/s1");
  assert.deepEqual(hook.body, { msgtype: "markdown", markdown: { title: "OpenBee", text: "**done**" } });
  assert.equal(hook.query.session, "xyz");
  const recall = await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/recall");
  assert.deepEqual(recall.body, emojiPayload("msg-1"));

  await send(p, got.raw, { content: "again" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.calls.filter((c) => c.path === "/v1.0/robot/emotion/recall").length, 1);
});

test("a reply right after dispatch still recalls the emoji", async (t) => {
  const fake = await startFakeDingTalk({
    "/v1.0/robot/emotion/reply": () => new Promise((r) => setTimeout(() => r(undefined), 300)),
  });
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  await fake.callback(message(fake, { msgId: "fast" }));
  const got = await inbound(p, "fast");
  await send(p, got.raw, { content: "instant" });
  await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/recall");
  const paths = fake.calls.map((c) => c.path).filter((path) => path.startsWith("/v1.0/robot/emotion/"));
  assert.deepEqual(paths, ["/v1.0/robot/emotion/reply", "/v1.0/robot/emotion/recall"]);
});

test("text and image are sent in order through the webhook", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, mediaDir } = await initialized(t, fake);
  const raw = JSON.stringify(message(fake, { msgId: "m-media" }));
  const media = writeMedia(mediaDir, "chart.png", "PNG");
  const res = await send(p, raw, { content: "see chart", media });
  assert.deepEqual(res.result, {});
  const order = fake.calls.map((c) => c.path).filter((path) => path === "/webhook/s1" || path === "/media/upload");
  assert.deepEqual(order, ["/webhook/s1", "/media/upload", "/webhook/s1"]);
  const upload = fake.calls.find((c) => c.path === "/media/upload");
  assert.deepEqual(upload.query, { access_token: OAPI_TOKEN, type: "image" });
  assert.match(upload.body, /name="media"; filename="chart.png"\r\nContent-Type: image\/png\r\n\r\nPNG\r\n/);
  const hooks = fake.calls.filter((c) => c.path === "/webhook/s1");
  assert.deepEqual(hooks[0].body, { msgtype: "markdown", markdown: { title: "OpenBee", text: "see chart" } });
  assert.equal(hooks[0].headers["x-acs-dingtalk-access-token"], undefined);
  assert.deepEqual(hooks[1].body, { msgtype: "markdown", markdown: { title: "Image", text: "![image](@media-1)" } });
  assert.equal(hooks[1].headers["x-acs-dingtalk-access-token"], API_TOKEN);
});

test("files, voice and video go through the webhook with fallbacks", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p, mediaDir } = await initialized(t, fake);
  const raw = JSON.stringify(message(fake));
  await send(p, raw, { media: writeMedia(mediaDir, "report.pdf", "PDF") });
  await send(p, raw, { media: writeMedia(mediaDir, "note.amr", "AMR") });
  await send(p, raw, { media: writeMedia(mediaDir, "clip.mp4", "MP4") });
  const hooks = fake.calls.filter((c) => c.path === "/webhook/s1").map((c) => c.body);
  assert.deepEqual(hooks, [
    { msgtype: "file", file: { mediaId: "@media-1", fileName: "report.pdf", fileType: "pdf" } },
    { msgtype: "voice", voice: { mediaId: "@media-2", duration: "0" } },
    { msgtype: "video", video: { duration: "0", videoMediaId: "@media-3", videoType: "mp4", picMediaId: "" } },
  ]);
  const types = fake.calls.filter((c) => c.path === "/media/upload").map((c) => c.query.type);
  assert.deepEqual(types, ["file", "voice", "video"]);
  await logged(p, "could not probe audio duration, using 0");
  await logged(p, "could not extract video thumbnail");
  assertNoSecrets(p);
});

test("replies to a legacy raw stored by the built-in channel", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  const legacy = JSON.stringify({ ...message(fake, { msgId: "legacy-1", content: null }), sessionWebhook: fake.webhook("legacy") });
  await p.request("send", {
    session_key: "dingtalk:cidGroup1==:staff-1",
    chat_id: "cidGroup1==",
    session_scope: "staff-1",
    proactive: false,
    reply_to: { raw: legacy },
    content: "legacy reply",
  });
  const hook = fake.calls.find((c) => c.path === "/webhook/legacy");
  assert.deepEqual(hook.body, { msgtype: "markdown", markdown: { title: "OpenBee", text: "legacy reply" } });

  const expired = JSON.stringify(message(fake, { msgId: "legacy-2", sessionWebhookExpiredTime: Date.now() - 1000 }));
  await send(p, expired, { content: "late reply" });
  const group = fake.calls.find((c) => c.path === "/v1.0/robot/groupMessages/send");
  assert.equal(group.headers["x-acs-dingtalk-access-token"], API_TOKEN);
  assert.deepEqual(group.body, {
    robotCode: CLIENT_ID,
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: "OpenBee", text: "late reply" }),
    openConversationId: "cidGroup1==",
  });
});

test("proactive sends in a single chat use batchSend and keep the pending emoji", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  await fake.waitForConnection(1);
  await fake.callback(message(fake, { msgId: "dm-1", conversationType: "1", conversationId: "cidDM==", sessionWebhookExpiredTime: Date.now() - 1 }));
  const got = await inbound(p, "dm-1");
  await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/reply");

  const res = await send(p, got.raw, { proactive: true, content: "scheduled result", session_key: "dingtalk:cidDM==:staff-1", chat_id: "cidDM==" });
  assert.deepEqual(res.result, {});
  const batch = fake.calls.find((c) => c.path === "/v1.0/robot/oToMessages/batchSend");
  assert.deepEqual(batch.body, {
    robotCode: CLIENT_ID,
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: "OpenBee", text: "scheduled result" }),
    userIds: ["staff-1"],
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.calls.filter((c) => c.path === "/v1.0/robot/emotion/recall").length, 0);

  await send(p, got.raw, { content: "the actual reply", session_key: "dingtalk:cidDM==:staff-1", chat_id: "cidDM==" });
  const recall = await fake.waitFor((c) => c.path === "/v1.0/robot/emotion/recall");
  assert.deepEqual(recall.body, emojiPayload("dm-1", "cidDM=="));
});

test("proactive group media uses ffprobe and ffmpeg metadata", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const bin = fakeBinaries({ duration: "3.4567", frame: "THUMBJPEG" });
  const { p, mediaDir } = await initialized(t, fake, { ffprobe_path: bin.ffprobe, ffmpeg_path: bin.ffmpeg });
  const raw = JSON.stringify(message(fake, { sessionWebhookExpiredTime: 0 }));
  await send(p, raw, { proactive: true, media: writeMedia(mediaDir, "note.mp3", "MP3") });
  await send(p, raw, { proactive: true, media: writeMedia(mediaDir, "clip.mp4", "MP4") });
  await send(p, raw, { proactive: true, media: writeMedia(mediaDir, "photo.jpg", "JPG") });
  await send(p, raw, { proactive: true, media: writeMedia(mediaDir, "data.csv", "a,b") });

  const uploads = fake.calls.filter((c) => c.path === "/media/upload");
  assert.deepEqual(
    uploads.map((c) => c.query.type),
    ["voice", "image", "video", "image", "file"],
  );
  const thumbName = uploads[1].body.match(/filename="(openbee-thumb-[0-9a-f]+\.jpg)"\r\nContent-Type: image\/jpeg\r\n\r\nTHUMBJPEG/)[1];
  assert.equal(existsSync(join(tmpdir(), thumbName)), false);
  assert.match(uploads[2].body, /filename="clip.mp4"\r\nContent-Type: application\/octet-stream/);

  const sent = fake.calls.filter((c) => c.path === "/v1.0/robot/groupMessages/send").map((c) => ({ ...c.body, msgParam: JSON.parse(c.body.msgParam) }));
  const common = { robotCode: CLIENT_ID, openConversationId: "cidGroup1==" };
  assert.deepEqual(sent, [
    { ...common, msgKey: "sampleAudio", msgParam: { mediaId: "@media-1", duration: "3456" } },
    { ...common, msgKey: "sampleVideo", msgParam: { duration: "3", videoMediaId: "@media-3", videoType: "mp4", picMediaId: "@media-2" } },
    { ...common, msgKey: "sampleMarkdown", msgParam: { title: "Image", text: "![image](@media-4)" } },
    { ...common, msgKey: "sampleFile", msgParam: { mediaId: "@media-5", fileName: "data.csv", fileType: "csv" } },
  ]);
  assertNoSecrets(p);
});

test("send errors reach the caller", async (t) => {
  const fake = await startFakeDingTalk({
    "/webhook/broken": () => ({ body: { errcode: 300001, errmsg: "session not found" } }),
    "/v1.0/robot/groupMessages/send": () => ({ status: 400, body: { code: "invalidParameter", message: "robot not in group" } }),
  });
  t.after(() => fake.close());
  const { p, mediaDir } = await initialized(t, fake);

  const none = await send(p, undefined, { content: "hi", proactive: true });
  assert.equal(none.error.code, -32000);
  assert.equal(none.error.message, 'dingtalk: no conversation context for session "dingtalk:cidGroup1==:staff-1"');
  assert.match((await send(p, "not json", { content: "hi" })).error.message, /no conversation context/);

  const broken = JSON.stringify(message(fake, { sessionWebhook: fake.webhook("broken") }));
  assert.match((await send(p, broken, { content: "hi" })).error.message, /^reply send: webhook failed: errcode 300001 session not found$/);

  const expired = JSON.stringify(message(fake, { sessionWebhookExpiredTime: 1 }));
  assert.match((await send(p, expired, { content: "hi" })).error.message, /^proactive text send: .*HTTP 400 .*robot not in group/);

  const big = writeMedia(mediaDir, "big.wav", Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.match((await send(p, broken, { media: big })).error.message, /^upload media: file too large: 2097153 bytes \(max 2097152\)$/);

  const noSender = JSON.stringify(message(fake, { conversationType: "1", senderStaffId: "", sessionWebhookExpiredTime: 0 }));
  assert.match((await send(p, noSender, { content: "hi" })).error.message, /no conversation context/);
  assertNoSecrets(p);
});

test("shutdown closes the stream and exits", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const { p } = await initialized(t, fake);
  const conn = await fake.waitForConnection(1);
  const started = Date.now();
  const res = await p.request("shutdown", {});
  assert.deepEqual(res.result, {});
  assert.equal(await p.exited, 0);
  assert.ok(Date.now() - started < 2000);
  assert.equal(conn.closed, true);
  assert.equal(fake.connections.length, 1);
});
