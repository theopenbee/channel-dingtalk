import { defineChannel } from "@theopenbee/channel-sdk";

import { createDingTalkChannel } from "./dingtalk.js";

defineChannel(createDingTalkChannel());
