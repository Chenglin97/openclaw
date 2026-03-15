import type { TtsProvider } from "../config/types.tts.js";
import type { ResolvedTtsConfig } from "./tts-config.js";

export type ExtensionHostTtsRuntimeBackend = {
  id: TtsProvider;
  supportsTelephony: boolean;
  resolveApiKey: (config: ResolvedTtsConfig) => string | undefined;
  isConfigured: (config: ResolvedTtsConfig) => boolean;
};

const EXTENSION_HOST_TTS_RUNTIME_BACKENDS: readonly ExtensionHostTtsRuntimeBackend[] = [
  {
    id: "openai",
    supportsTelephony: true,
    resolveApiKey(config) {
      return config.openai.apiKey || process.env.OPENAI_API_KEY;
    },
    isConfigured(config) {
      return Boolean(this.resolveApiKey(config));
    },
  },
  {
    id: "elevenlabs",
    supportsTelephony: true,
    resolveApiKey(config) {
      return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
    },
    isConfigured(config) {
      return Boolean(this.resolveApiKey(config));
    },
  },
  {
    id: "edge",
    supportsTelephony: false,
    resolveApiKey() {
      return undefined;
    },
    isConfigured(config) {
      return config.edge.enabled;
    },
  },
] as const;

export const EXTENSION_HOST_TTS_RUNTIME_BACKEND_IDS = EXTENSION_HOST_TTS_RUNTIME_BACKENDS.map(
  (backend) => backend.id,
) as readonly TtsProvider[];

export function listExtensionHostTtsRuntimeBackends(): readonly ExtensionHostTtsRuntimeBackend[] {
  return EXTENSION_HOST_TTS_RUNTIME_BACKENDS;
}

export function getExtensionHostTtsRuntimeBackend(
  id: TtsProvider,
): ExtensionHostTtsRuntimeBackend | undefined {
  return EXTENSION_HOST_TTS_RUNTIME_BACKENDS.find((backend) => backend.id === id);
}
