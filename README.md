# openbee DingTalk channel

DingTalk (钉钉) channel for openbee, built on [`@theopenbee/channel-sdk`](https://www.npmjs.com/package/@theopenbee/channel-sdk). It replaces the DingTalk channel that used to be built into openbee and keeps its config, session keys and stored conversations.

## Behaviour

- Stream mode: the plugin keeps a WebSocket connection to DingTalk open, so openbee needs no public address. The connection is kept alive with pings and reopened automatically (backoff from 1s up to 30s) when it drops or DingTalk asks for a reconnect.
- Handles one-on-one chats and group messages that @-mention the bot (DingTalk only delivers those to a bot in a group). Messages from senders without a staff id, such as external contacts, are ignored.
- One openbee session per conversation and user (`dingtalk:<conversationId>:<staffId>`), the same keys the built-in channel used.
- Text, pictures, rich text (text with images), files, voice messages and videos are handled; other message types such as cards are ignored. Attachments up to 100 MB are downloaded into openbee's media directory. For voice messages, DingTalk's speech recognition becomes the message text.
- While openbee works on a message, the message shows a "🤔思考中" reaction. The first reply removes it.
- Replies are sent as Markdown through the conversation's session webhook. When the webhook has expired, and for scheduled results, the robot message API is used instead. Text is sent first, then the file.
- Files the bot sends: `.jpg` `.png` `.gif` `.bmp` as images, `.mp3` `.wav` `.amr` as voice (2 MB max), `.mp4` as video, anything else as a file (20 MB max). Voice and video durations come from `ffprobe`, video thumbnails from `ffmpeg`; without them the duration is 0 and the video has no thumbnail.
- HTTP proxy variables are not used.

## Create the bot

1. In the [DingTalk developer console](https://open-dev.dingtalk.com), create an internal enterprise app (企业内部应用).
2. Add the **Robot** (机器人) capability and set its message receiving mode to **Stream mode** (Stream 模式).
3. Under **Permissions** (权限管理), grant the robot message permissions, including `qyapi_robot_sendmsg` (企业内机器人发送消息权限), which is needed for replies after the session webhook expires and for scheduled messages.
4. Copy the **Client ID (AppKey)** and **Client Secret (AppSecret)** from **Credentials & Basic Info** (凭证与基础信息).
5. Publish a version of the app. Add the bot to a group, or find it in DingTalk search to chat one-on-one.

## Install

```sh
openbee plugin install @theopenbee/channel-dingtalk
```

Or from a local checkout:

```sh
git clone https://github.com/theopenbee/channel-dingtalk.git
cd channel-dingtalk
npm install
openbee plugin install "$(pwd)"
```

Then enable it with `openbee config`, or add it to `config.yaml` and restart openbee. A config written for the built-in channel works unchanged:

```yaml
bee:
  platforms:
    dingtalk:
      enabled: true
      client_id: "<Client ID (AppKey)>"
      client_secret: "<Client Secret (AppSecret)>"
      bot_name: "OpenBee"
```

| Key | Default | |
|---|---|---|
| `client_id` | | Client ID (AppKey) of the app. Required. |
| `client_secret` | | Client Secret (AppSecret) of the app. Required. |
| `ffprobe_path` | `ffprobe` | ffprobe binary, for the duration of voice and video files the bot sends. |
| `ffmpeg_path` | `ffmpeg` | ffmpeg binary, for the thumbnail of videos the bot sends. |
| `api_base_url` | `https://api.dingtalk.com` | Advanced: DingTalk API server, for a reverse proxy or tests. |
| `oapi_base_url` | `https://oapi.dingtalk.com` | Advanced: DingTalk OAPI server (media uploads), for a reverse proxy or tests. |

## Development

```sh
npm install
npm test
```

`npm install` also builds `dist/`; run `npm run build` after changing `src/`. The tests run offline against a local fake of the DingTalk APIs and stream gateway.
