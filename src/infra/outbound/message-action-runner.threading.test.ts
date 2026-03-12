import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPlugin } from "../../../extensions/matrix/src/channel.js";
import { setMatrixRuntime } from "../../../extensions/matrix/src/runtime.js";
import { slackPlugin } from "../../../extensions/slack/src/channel.js";
import { setSlackRuntime } from "../../../extensions/slack/src/runtime.js";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../../extensions/telegram/src/runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  executeSendAction: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./outbound-send-service.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-send-service.js")>(
    "./outbound-send-service.js",
  );
  return {
    ...actual,
    executeSendAction: mocks.executeSendAction,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  };
});

type MessageActionRunnerModule = typeof import("./message-action-runner.js");
type MessageActionRunnerTestHelpersModule =
  typeof import("./message-action-runner.test-helpers.js");

let runMessageAction: MessageActionRunnerModule["runMessageAction"];
let installMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["installMessageActionRunnerTestRegistry"];
let resetMessageActionRunnerTestRegistry: MessageActionRunnerTestHelpersModule["resetMessageActionRunnerTestRegistry"];
let slackConfig: MessageActionRunnerTestHelpersModule["slackConfig"];
let telegramConfig: MessageActionRunnerTestHelpersModule["telegramConfig"];

const matrixConfig = {
  channels: {
    matrix: {
      homeserver: "https://matrix.example.org",
      accessToken: "matrix-test",
    },
  },
} as OpenClawConfig;

async function runThreadingAction(params: {
  cfg: MessageActionRunnerTestHelpersModule["slackConfig"];
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "send",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    agentId: "main",
  });
  return mocks.executeSendAction.mock.calls[0]?.[0] as {
    threadId?: string;
    replyToId?: string;
    ctx?: { agentId?: string; mirror?: { sessionKey?: string }; params?: Record<string, unknown> };
  };
}

function mockHandledSendAction() {
  mocks.executeSendAction.mockResolvedValue({
    handledBy: "plugin",
    payload: {},
  });
}

const defaultTelegramToolContext = {
  currentChannelId: "telegram:123",
  currentThreadTs: "42",
} as const;

const defaultMatrixToolContext = {
  currentChannelId: "room:!room:example.org",
  currentThreadTs: "$thread",
} as const;

const defaultMatrixDmToolContext = {
  currentChannelId: "room:!dm:example.org",
  currentThreadTs: "$thread",
  currentDirectUserId: "@alice:example.org",
} as const;

describe("runMessageAction threading auto-injection", () => {
  beforeAll(() => {
    const runtime = createPluginRuntime();
    setMatrixRuntime(runtime);
    setSlackRuntime(runtime);
    setTelegramRuntime(runtime);
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ runMessageAction } = await import("./message-action-runner.js"));
    ({
      installMessageActionRunnerTestRegistry,
      resetMessageActionRunnerTestRegistry,
      slackConfig,
      telegramConfig,
    } = await import("./message-action-runner.test-helpers.js"));
    installMessageActionRunnerTestRegistry();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: matrixPlugin,
        },
        {
          pluginId: "slack",
          source: "test",
          plugin: slackPlugin,
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: telegramPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    resetMessageActionRunnerTestRegistry?.();
    mocks.executeSendAction.mockClear();
    mocks.recordSessionMetaFromInbound.mockClear();
  });

  it.each([
    {
      name: "exact channel id",
      target: "channel:C123",
      threadTs: "111.222",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:111.222",
    },
    {
      name: "case-insensitive channel id",
      target: "channel:c123",
      threadTs: "333.444",
      expectedSessionKey: "agent:main:slack:channel:c123:thread:333.444",
    },
  ] as const)("auto-threads slack using $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: slackConfig,
      actionParams: {
        channel: "slack",
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: testCase.threadTs,
        replyToMode: "all",
      },
    });

    expect(call?.ctx?.agentId).toBe("main");
    expect(call?.ctx?.mirror?.sessionKey).toBe(testCase.expectedSessionKey);
  });

  it.each([
    {
      name: "injects threadId for matching target",
      target: "telegram:123",
      expectedThreadId: "42",
    },
    {
      name: "injects threadId for prefixed group target",
      target: "telegram:group:123",
      expectedThreadId: "42",
    },
    {
      name: "skips threadId when target chat differs",
      target: "telegram:999",
      expectedThreadId: undefined,
    },
  ] as const)("telegram auto-threading: $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: testCase.target,
        message: "hi",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.ctx?.params?.threadId).toBe(testCase.expectedThreadId);
    if (testCase.expectedThreadId !== undefined) {
      expect(call?.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("uses explicit telegram threadId when provided", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        threadId: "999",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.threadId).toBe("999");
    expect(call?.ctx?.params?.threadId).toBe("999");
  });

  it("threads explicit replyTo through executeSendAction", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: telegramConfig,
      actionParams: {
        channel: "telegram",
        target: "telegram:123",
        message: "hi",
        replyTo: "777",
      },
      toolContext: defaultTelegramToolContext,
    });

    expect(call?.replyToId).toBe("777");
    expect(call?.ctx?.params?.replyTo).toBe("777");
  });

  it.each([
    {
      name: "injects threadId for bare room id",
      target: "!room:example.org",
      expectedThreadId: "$thread",
    },
    {
      name: "injects threadId for room target prefix",
      target: "room:!room:example.org",
      expectedThreadId: "$thread",
    },
    {
      name: "injects threadId for matrix room target",
      target: "matrix:room:!room:example.org",
      expectedThreadId: "$thread",
    },
    {
      name: "skips threadId when target room differs",
      target: "!other:example.org",
      expectedThreadId: undefined,
    },
  ] as const)("matrix auto-threading: $name", async (testCase) => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: matrixConfig,
      actionParams: {
        channel: "matrix",
        target: testCase.target,
        message: "hi",
      },
      toolContext: defaultMatrixToolContext,
    });

    expect(call?.ctx?.params?.threadId).toBe(testCase.expectedThreadId);
    if (testCase.expectedThreadId !== undefined) {
      expect(call?.threadId).toBe(testCase.expectedThreadId);
    }
  });

  it("uses explicit matrix threadId when provided", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: matrixConfig,
      actionParams: {
        channel: "matrix",
        target: "room:!room:example.org",
        message: "hi",
        threadId: "$explicit",
      },
      toolContext: defaultMatrixToolContext,
    });

    expect(call?.threadId).toBe("$explicit");
    expect(call?.ctx?.params?.threadId).toBe("$explicit");
  });

  it("skips threadId for Matrix dm user targets until the resolved room matches", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: matrixConfig,
      actionParams: {
        channel: "matrix",
        target: "user:@alice:example.org",
        message: "hi",
      },
      toolContext: defaultMatrixDmToolContext,
    });

    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });

  it("skips threadId for different Matrix dm user target", async () => {
    mockHandledSendAction();

    const call = await runThreadingAction({
      cfg: matrixConfig,
      actionParams: {
        channel: "matrix",
        target: "user:@bob:example.org",
        message: "hi",
      },
      toolContext: defaultMatrixDmToolContext,
    });

    expect(call?.threadId).toBeUndefined();
    expect(call?.ctx?.params?.threadId).toBeUndefined();
  });
});
