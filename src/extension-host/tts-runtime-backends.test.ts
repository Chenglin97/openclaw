import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTENSION_HOST_TTS_RUNTIME_BACKEND_IDS,
  getExtensionHostTtsRuntimeBackend,
  listExtensionHostTtsRuntimeBackends,
} from "./tts-runtime-backends.js";

describe("tts-runtime-backends", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the built-in backend order stable", () => {
    expect(EXTENSION_HOST_TTS_RUNTIME_BACKEND_IDS).toEqual(["openai", "elevenlabs", "edge"]);
    expect(listExtensionHostTtsRuntimeBackends().map((backend) => backend.id)).toEqual([
      "openai",
      "elevenlabs",
      "edge",
    ]);
  });

  it("resolves API keys and configuration through shared backend definitions", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XI_API_KEY", "");

    const config = {
      openai: { apiKey: "openai-key" },
      elevenlabs: { apiKey: "" },
      edge: { enabled: true },
    } as const;

    expect(getExtensionHostTtsRuntimeBackend("openai")?.resolveApiKey(config)).toBe("openai-key");
    expect(getExtensionHostTtsRuntimeBackend("elevenlabs")?.isConfigured(config)).toBe(false);
    expect(getExtensionHostTtsRuntimeBackend("edge")?.supportsTelephony).toBe(false);
  });
});
