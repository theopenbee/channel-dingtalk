import { test } from "node:test";
import assert from "node:assert/strict";

import { DingTalkApi, DingTalkError } from "../dist/api.js";
import { API_TOKEN, CLIENT_ID, CLIENT_SECRET, OAPI_TOKEN, startFakeDingTalk } from "./fake-dingtalk.mjs";

const newApi = (fake, over = {}) =>
  new DingTalkApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiBaseUrl: fake.url + "/", oapiBaseUrl: fake.url, ...over });

test("access token is fetched once and cached", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const api = newApi(fake);
  const [a, b] = await Promise.all([api.accessToken(), api.accessToken()]);
  assert.equal(a, API_TOKEN);
  assert.equal(b, API_TOKEN);
  assert.equal(await api.accessToken(), API_TOKEN);
  const tokenCalls = fake.calls.filter((c) => c.path === "/v1.0/oauth2/accessToken");
  assert.equal(tokenCalls.length, 1);
  assert.deepEqual(tokenCalls[0].body, { appKey: CLIENT_ID, appSecret: CLIENT_SECRET });
});

test("rejected credentials surface the HTTP status and code", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const err = await newApi(fake, { clientSecret: "wrong" })
    .accessToken()
    .catch((e) => e);
  assert.ok(err instanceof DingTalkError);
  assert.equal(err.status, 400);
  assert.equal(err.code, "invalidClientIdOrSecret");
  assert.match(err.message, /invalidClientIdOrSecret/);
  assert.doesNotMatch(err.message, /wrong/);

  const gateway = await newApi(fake, { clientSecret: "wrong" })
    .openConnection([], "ua")
    .catch((e) => e);
  assert.equal(gateway.status, 401);
  assert.equal(gateway.code, "authFailed");
});

test("access tokens refresh shortly before they expire", async (t) => {
  let issued = 0;
  const fake = await startFakeDingTalk({
    "/v1.0/oauth2/accessToken": () => ({ body: { accessToken: `short-${++issued}`, expireIn: 30 } }),
  });
  t.after(() => fake.close());
  const api = newApi(fake);
  assert.equal(await api.accessToken(), "short-1");
  assert.equal(await api.accessToken(), "short-2");
});

test("OAPI token errors are reported", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  assert.equal(await newApi(fake).oapiToken(), OAPI_TOKEN);
  const err = await newApi(fake, { clientSecret: "wrong" })
    .oapiToken()
    .catch((e) => e);
  assert.match(err.message, /40089/);
  assert.doesNotMatch(err.message, /wrong/);
});

test("upload sends multipart media and returns the media id", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const id = await newApi(fake).upload(Buffer.from("PNGDATA"), "chart.png", "image", "image/png");
  assert.equal(id, "@media-1");
  const call = fake.calls.find((c) => c.path === "/media/upload");
  assert.deepEqual(call.query, { access_token: OAPI_TOKEN, type: "image" });
  assert.match(call.contentType, /multipart\/form-data/);
  assert.match(call.body, /name="media"; filename="chart.png"\r\nContent-Type: image\/png\r\n\r\nPNGDATA/);
});

test("upload errors carry errcode and errmsg", async (t) => {
  const fake = await startFakeDingTalk({ "/media/upload": () => ({ body: { errcode: 40004, errmsg: "invalid media type" } }) });
  t.after(() => fake.close());
  await assert.rejects(newApi(fake).upload(Buffer.from("x"), "a.bin", "file", "application/octet-stream"), /upload error 40004: invalid media type/);
});

test("download enforces the size cap and reports HTTP errors", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  const url = fake.addFile("", "ten.bin", "0123456789", "image/png");
  const api = newApi(fake);
  const got = await api.download(url, 10);
  assert.equal(got.data.toString(), "0123456789");
  assert.equal(got.contentType, "image/png");
  await assert.rejects(api.download(url, 9), /download too large: exceeds 9 bytes/);
  await assert.rejects(api.download(`${fake.url}/files/missing`, 10), /HTTP 404/);
});

test("download code exchange uses the robot code and token", async (t) => {
  const fake = await startFakeDingTalk();
  t.after(() => fake.close());
  fake.addFile("code-1", "pic.png", "PNG", "image/png");
  const api = newApi(fake);
  assert.match(await api.downloadUrl("code-1"), /\/files\/pic.png\?sig=abc$/);
  const call = fake.calls.find((c) => c.path === "/v1.0/robot/messageFiles/download");
  assert.equal(call.headers["x-acs-dingtalk-access-token"], API_TOKEN);
  assert.deepEqual(call.body, { downloadCode: "code-1", robotCode: CLIENT_ID });
  await assert.rejects(api.downloadUrl("unknown"), /HTTP 400/);
});

test("webhook posts fail on HTTP errors and non-zero errcode", async (t) => {
  const fake = await startFakeDingTalk({
    "/webhook/bad": () => ({ body: { errcode: 300001, errmsg: "session expired" } }),
    "/webhook/down": () => ({ status: 500, body: "boom", type: "text/plain" }),
  });
  t.after(() => fake.close());
  const api = newApi(fake);
  await api.postWebhook(fake.webhook("ok"), { msgtype: "text" }, { withToken: true });
  const ok = fake.calls.find((c) => c.path === "/webhook/ok");
  assert.equal(ok.headers["x-acs-dingtalk-access-token"], API_TOKEN);
  await api.postWebhook(fake.webhook("plain"), { msgtype: "text" });
  assert.equal(fake.calls.find((c) => c.path === "/webhook/plain").headers["x-acs-dingtalk-access-token"], undefined);
  await assert.rejects(api.postWebhook(fake.webhook("bad"), {}), /errcode 300001 session expired/);
  await assert.rejects(api.postWebhook(fake.webhook("down"), {}), /HTTP 500 boom/);
});
