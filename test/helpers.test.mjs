import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PendingEmojis,
  buildContext,
  buildEmojiPayload,
  buildProactiveMediaPayload,
  buildProactiveTextPayload,
  buildWebhookMediaPayload,
  buildWebhookTextPayload,
  dingTalkMediaType,
  encodeRaw,
  extensionFromMime,
  extname,
  hasProactiveTarget,
  imageContentType,
  isWebhookExpired,
  mimeExtension,
  parseRaw,
  proactivePath,
  retryWithBackoff,
  sanitizeFileName,
} from "../dist/helpers.js";

const legacyRaw = {
  conversationId: "cid-group==",
  atUsers: [{ dingtalkId: "$:LWCP_v1:$abc", staffId: "" }],
  chatbotCorpId: "dingcorp",
  chatbotUserId: "$:LWCP_v1:$bot",
  msgId: "msgABC",
  senderNick: "Alice",
  isAdmin: false,
  senderStaffId: "staff-1",
  sessionWebhookExpiredTime: 1700000600000,
  createAt: 1700000000000,
  senderCorpId: "dingcorp",
  conversationType: "2",
  senderId: "$:LWCP_v1:$alice",
  conversationTitle: "Team",
  isInAtList: true,
  sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
  text: { content: " hello " },
  msgtype: "text",
  content: null,
};

test("extensionFromMime follows the media service table", () => {
  assert.equal(extensionFromMime("image/png"), ".png");
  assert.equal(extensionFromMime("image/jpeg; charset=binary"), ".jpg");
  assert.equal(extensionFromMime("audio/x-m4a"), ".m4a");
  assert.equal(extensionFromMime("video/quicktime"), ".mov");
  assert.equal(extensionFromMime("application/octet-stream"), ".bin");
  assert.equal(extensionFromMime(""), ".bin");
  assert.equal(mimeExtension("application/octet-stream"), undefined);
  assert.equal(mimeExtension("Audio/AMR"), ".amr");
});

test("extname matches Go filepath.Ext", () => {
  assert.equal(extname("report.pdf"), ".pdf");
  assert.equal(extname("/tmp/archive.tar.gz"), ".gz");
  assert.equal(extname("noext"), "");
  assert.equal(extname("dir.v2/file"), "");
  assert.equal(extname(""), "");
});

test("sanitizeFileName replaces control characters and separators", () => {
  const cases = [
    ["report.pdf", "report.pdf"],
    ["my report.pdf", "my report.pdf"],
    ["file\x00name\x1f.txt", "file_name_.txt"],
    ["file\r\nname.txt", "file_name.txt"],
    ["file\\name.txt", "file_name.txt"],
    ['file"name.txt', "file_name.txt"],
    ["path/to/file.txt", "path_to_file.txt"],
    ["C:file.txt", "C_file.txt"],
    ["a\x00\x01\x02b.txt", "a_b.txt"],
    ["", ""],
    ["café.pdf", "café.pdf"],
    ["file\x7fname.txt", "file_name.txt"],
  ];
  for (const [input, want] of cases) assert.equal(sanitizeFileName(input), want, JSON.stringify(input));
});

test("dingTalkMediaType and imageContentType map extensions", () => {
  assert.equal(dingTalkMediaType("a.JPG"), "image");
  assert.equal(dingTalkMediaType("a.png"), "image");
  assert.equal(dingTalkMediaType("a.jpeg"), "file");
  assert.equal(dingTalkMediaType("clip.mp4"), "video");
  assert.equal(dingTalkMediaType("clip.mov"), "file");
  assert.equal(dingTalkMediaType("v.amr"), "voice");
  assert.equal(dingTalkMediaType("v.wav"), "voice");
  assert.equal(dingTalkMediaType("report.pdf"), "file");
  assert.equal(imageContentType("a.PNG"), "image/png");
  assert.equal(imageContentType("a.gif"), "image/gif");
  assert.equal(imageContentType("a.bmp"), "image/bmp");
  assert.equal(imageContentType("a.jpg"), "image/jpeg");
});

test("encodeRaw keeps only what the sender needs", () => {
  const raw = encodeRaw(legacyRaw);
  assert.equal(
    raw,
    JSON.stringify({
      conversationId: "cid-group==",
      conversationType: "2",
      senderStaffId: "staff-1",
      msgId: "msgABC",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
      sessionWebhookExpiredTime: 1700000600000,
    }),
  );
  assert.deepEqual(parseRaw(raw), parseRaw(JSON.stringify(legacyRaw)));
});

test("parseRaw reads new and legacy raw", () => {
  assert.deepEqual(parseRaw(JSON.stringify(legacyRaw)), {
    conversationId: "cid-group==",
    conversationType: "2",
    senderStaffId: "staff-1",
    msgId: "msgABC",
    sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    sessionWebhookExpiredTime: 1700000600000,
  });
  assert.equal(parseRaw(undefined), undefined);
  assert.equal(parseRaw(""), undefined);
  assert.equal(parseRaw("not-json"), undefined);
  assert.equal(parseRaw("[1]"), undefined);
  assert.equal(parseRaw("{}"), undefined);
  assert.equal(parseRaw(JSON.stringify({ conversationId: "c", sessionWebhookExpiredTime: "1700" })).sessionWebhookExpiredTime, 1700);
});

test("buildContext reproduces the Go context fields", () => {
  const raw = {
    conversationId: "conv1",
    atUsers: [
      { dingtalkId: "dt001", staffId: "s001" },
      { dingtalkId: "dt002", staffId: "" },
    ],
    chatbotCorpId: "botcorp1",
    chatbotUserId: "botuser1",
    msgId: "msg1",
    senderNick: "Alice",
    isAdmin: true,
    senderStaffId: "emp001",
    senderCorpId: "corp1",
    conversationType: "2",
    senderId: "sender1",
    conversationTitle: "Test Group",
    msgtype: "text",
    sessionWebhook: "https://should-be-excluded.example.com",
    createAt: 1700000000000,
  };
  const ctx = buildContext(raw);
  assert.deepEqual(ctx, {
    conversationId: "conv1",
    atUsers: raw.atUsers,
    chatbotCorpId: "botcorp1",
    chatbotUserId: "botuser1",
    msgId: "msg1",
    senderNick: "Alice",
    isAdmin: true,
    senderStaffId: "emp001",
    senderCorpId: "corp1",
    conversationType: "2",
    senderId: "sender1",
    conversationTitle: "Test Group",
    msgtype: "text",
  });
  assert.deepEqual(Object.keys(ctx), [
    "conversationId",
    "atUsers",
    "chatbotCorpId",
    "chatbotUserId",
    "msgId",
    "senderNick",
    "isAdmin",
    "senderStaffId",
    "senderCorpId",
    "conversationType",
    "senderId",
    "conversationTitle",
    "msgtype",
  ]);
  assert.deepEqual(buildContext({ conversationId: "c", conversationTitle: "", atUsers: null, isAdmin: false, senderNick: 5 }), {
    conversationId: "c",
    isAdmin: false,
  });
});

test("isWebhookExpired", () => {
  const now = 1_000_000;
  const t = (expires, hook = "https://hook") => ({ sessionWebhook: hook, sessionWebhookExpiredTime: expires });
  assert.equal(isWebhookExpired(t(now - 1000), now), true);
  assert.equal(isWebhookExpired(t(now), now), true);
  assert.equal(isWebhookExpired(t(now + 60000), now), false);
  assert.equal(isWebhookExpired(t(0), now), true);
  assert.equal(isWebhookExpired(t(now + 60000, ""), now), true);
});

test("proactive routing by conversation type", () => {
  assert.equal(proactivePath("1"), "/v1.0/robot/oToMessages/batchSend");
  assert.equal(proactivePath("2"), "/v1.0/robot/groupMessages/send");
  assert.equal(hasProactiveTarget({ conversationType: "1", senderStaffId: "", conversationId: "c" }), false);
  assert.equal(hasProactiveTarget({ conversationType: "2", senderStaffId: "s", conversationId: "" }), false);
  assert.equal(hasProactiveTarget({ conversationType: "2", senderStaffId: "", conversationId: "c" }), true);
});

const group = { conversationType: "2", conversationId: "groupId", senderStaffId: "staffId" };
const single = { conversationType: "1", conversationId: "convId", senderStaffId: "staffId" };
const param = (payload) => JSON.parse(payload.msgParam);
const info = (over = {}) => ({ durationMs: 0, durationSec: 0, picMediaId: "", ...over });

test("proactive text payload targets the group or the sender", () => {
  assert.deepEqual(buildProactiveTextPayload("testBot", group, "Hello World"), {
    robotCode: "testBot",
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: "OpenBee", text: "Hello World" }),
    openConversationId: "groupId",
  });
  assert.deepEqual(buildProactiveTextPayload("testBot", single, "Hello World"), {
    robotCode: "testBot",
    msgKey: "sampleMarkdown",
    msgParam: JSON.stringify({ title: "OpenBee", text: "Hello World" }),
    userIds: ["staffId"],
  });
  assert.deepEqual(buildWebhookTextPayload("hi"), { msgtype: "markdown", markdown: { title: "OpenBee", text: "hi" } });
});

test("proactive media payloads", () => {
  const file = { type: "file", mediaId: "media123", fileName: "report.pdf", fileType: "pdf", info: info() };
  const filePayload = buildProactiveMediaPayload("testBot", group, file);
  assert.equal(filePayload.msgKey, "sampleFile");
  assert.equal(filePayload.openConversationId, "groupId");
  assert.equal(filePayload.userIds, undefined);
  assert.deepEqual(param(filePayload), { mediaId: "media123", fileName: "report.pdf", fileType: "pdf" });
  assert.deepEqual(buildProactiveMediaPayload("testBot", single, file).userIds, ["staffId"]);

  const voice = buildProactiveMediaPayload("testBot", group, { ...file, type: "voice", mediaId: "audio456", info: info({ durationMs: 60000 }) });
  assert.equal(voice.msgKey, "sampleAudio");
  assert.deepEqual(param(voice), { mediaId: "audio456", duration: "60000" });

  const video = buildProactiveMediaPayload("testBot", group, { ...file, type: "video", mediaId: "vid789", info: info({ durationSec: 30, picMediaId: "thumb001" }) });
  assert.equal(video.msgKey, "sampleVideo");
  assert.deepEqual(param(video), { duration: "30", videoMediaId: "vid789", videoType: "mp4", picMediaId: "thumb001" });

  const image = buildProactiveMediaPayload("testBot", group, { ...file, type: "image", mediaId: "img001" });
  assert.equal(image.msgKey, "sampleMarkdown");
  assert.deepEqual(param(image), { title: "Image", text: "![image](img001)" });
});

test("webhook media payloads", () => {
  const base = { mediaId: "m1", fileName: "a.pdf", fileType: "pdf", info: info({ durationMs: 1500, durationSec: 7, picMediaId: "p1" }) };
  assert.deepEqual(buildWebhookMediaPayload({ ...base, type: "image" }), { msgtype: "markdown", markdown: { title: "Image", text: "![image](m1)" } });
  assert.deepEqual(buildWebhookMediaPayload({ ...base, type: "voice" }), { msgtype: "voice", voice: { mediaId: "m1", duration: "1500" } });
  assert.deepEqual(buildWebhookMediaPayload({ ...base, type: "video" }), {
    msgtype: "video",
    video: { duration: "7", videoMediaId: "m1", videoType: "mp4", picMediaId: "p1" },
  });
  assert.deepEqual(buildWebhookMediaPayload({ ...base, type: "file" }), { msgtype: "file", file: { mediaId: "m1", fileName: "a.pdf", fileType: "pdf" } });
});

test("emoji payload matches the Go payload", () => {
  assert.deepEqual(buildEmojiPayload("bot", "msg1", "cid1"), {
    robotCode: "bot",
    openMsgId: "msg1",
    openConversationId: "cid1",
    emotionType: 2,
    emotionName: "🤔思考中",
    textEmotion: { emotionId: "2659900", emotionName: "🤔思考中", text: "🤔思考中", backgroundId: "im_bg_1" },
  });
});

test("retryWithBackoff retries with doubling delays", async () => {
  let calls = 0;
  const started = Date.now();
  const value = await retryWithBackoff(
    async () => {
      if (++calls < 3) throw new Error(`fail ${calls}`);
      return "ok";
    },
    5,
    5,
  );
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.ok(Date.now() - started >= 15);

  calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => {
      calls++;
      throw new Error("always");
    }, 5, 1),
    /always/,
  );
  assert.equal(calls, 5);

  const controller = new AbortController();
  calls = 0;
  const pending = retryWithBackoff(async () => {
    calls++;
    throw new Error("x");
  }, 5, 1000, controller.signal);
  controller.abort(new Error("window closed"));
  await assert.rejects(pending, /window closed/);
  assert.equal(calls, 1);
});

test("PendingEmojis expires entries after the TTL", () => {
  let now = 0;
  const pending = new PendingEmojis(1000, () => now);
  pending.add("a", 1);
  now = 500;
  pending.add("b", 2);
  assert.equal(pending.size, 2);
  now = 1000;
  assert.equal(pending.has("a"), false);
  assert.equal(pending.take("b"), 2);
  assert.equal(pending.take("b"), undefined);
  pending.add("c", 3);
  now = 1999;
  assert.equal(pending.take("c"), 3);
});
