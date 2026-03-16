import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPluginBoundaryImport,
  compareViolationBaseline,
  findPluginBoundaryViolations,
  toBaselineKey,
} from "../../scripts/check-plugin-boundary-ratchet.mjs";

const repoRoot = "/repo";
const extensionFile = "/repo/extensions/example/src/index.ts";

describe("check-plugin-boundary-ratchet", () => {
  it("allows public plugin-sdk imports", () => {
    expect(
      classifyPluginBoundaryImport("openclaw/plugin-sdk/discord", extensionFile, { repoRoot }),
    ).toBeNull();
    expect(
      classifyPluginBoundaryImport("openclaw/plugin-sdk", extensionFile, { repoRoot }),
    ).toBeNull();
  });

  it("allows compat for now", () => {
    expect(
      classifyPluginBoundaryImport("openclaw/plugin-sdk/compat", extensionFile, { repoRoot }),
    ).toBeNull();
  });

  it("rejects plugin-sdk-internal imports", () => {
    expect(
      classifyPluginBoundaryImport("../../../src/plugin-sdk-internal/discord.js", extensionFile, {
        repoRoot,
      }),
    ).toMatchObject({
      kind: "plugin-sdk-internal",
    });
  });

  it("rejects direct core src imports", () => {
    expect(
      classifyPluginBoundaryImport(
        "../../src/config/config.js",
        "/repo/extensions/example/index.ts",
        {
          repoRoot,
        },
      ),
    ).toMatchObject({
      kind: "core-src",
    });
  });

  it("ignores same-plugin relative imports", () => {
    expect(classifyPluginBoundaryImport("./helpers.js", extensionFile, { repoRoot })).toBeNull();
    expect(
      classifyPluginBoundaryImport("../shared/util.js", extensionFile, { repoRoot }),
    ).toBeNull();
  });

  it("rejects cross-extension relative imports", () => {
    expect(
      classifyPluginBoundaryImport("../../other-plugin/src/helper.js", extensionFile, { repoRoot }),
    ).toMatchObject({
      kind: "cross-extension",
    });
  });

  it("finds import and dynamic import violations", () => {
    const source = `
      import { x } from "../../../src/config/config.js";
      export { y } from "../../../src/plugin-sdk-internal/discord.js";
      const z = await import("../../../src/runtime.js");
    `;
    expect(
      findPluginBoundaryViolations(source, "/repo/extensions/example/nested/file.ts", { repoRoot }),
    ).toEqual([
      {
        kind: "core-src",
        line: 2,
        preferredReplacement:
          "Use openclaw/plugin-sdk/*, openclaw/extension-api, or openclaw/plugin-sdk/compat temporarily.",
        reason: "reaches into core src/** from an extension",
        specifier: "../../../src/config/config.js",
      },
      {
        kind: "plugin-sdk-internal",
        line: 3,
        preferredReplacement:
          "Use openclaw/plugin-sdk/* or openclaw/plugin-sdk/compat temporarily.",
        reason: "imports non-public plugin-sdk-internal surface",
        specifier: "../../../src/plugin-sdk-internal/discord.js",
      },
      {
        kind: "core-src",
        line: 4,
        preferredReplacement:
          "Use openclaw/plugin-sdk/*, openclaw/extension-api, or openclaw/plugin-sdk/compat temporarily.",
        reason: "reaches into core src/** from an extension",
        specifier: "../../../src/runtime.js",
      },
    ]);
  });

  it("finds require and test mock violations", () => {
    const source = `
      const x = require("../../../src/config/config.js");
      vi.mock("../../../src/plugin-sdk-internal/discord.js", () => ({}));
      jest.mock("../../other-plugin/src/helper.js", () => ({}));
    `;
    expect(
      findPluginBoundaryViolations(source, "/repo/extensions/example/nested/file.test.ts", {
        repoRoot,
      }),
    ).toEqual([
      {
        kind: "core-src",
        line: 2,
        preferredReplacement:
          "Use openclaw/plugin-sdk/*, openclaw/extension-api, or openclaw/plugin-sdk/compat temporarily.",
        reason: "reaches into core src/** from an extension",
        specifier: "../../../src/config/config.js",
      },
      {
        kind: "plugin-sdk-internal",
        line: 3,
        preferredReplacement:
          "Use openclaw/plugin-sdk/* or openclaw/plugin-sdk/compat temporarily.",
        reason: "imports non-public plugin-sdk-internal surface",
        specifier: "../../../src/plugin-sdk-internal/discord.js",
      },
      {
        kind: "cross-extension",
        line: 4,
        preferredReplacement:
          "Keep relative imports within the same plugin root, or expose a public surface via openclaw/plugin-sdk/*, openclaw/extension-api, or a dedicated shared package.",
        reason: "reaches into another extension via a relative import",
        specifier: "../../other-plugin/src/helper.js",
      },
    ]);
  });

  it("compares current violations to the baseline by path and specifier", () => {
    const current = [
      { path: "extensions/a/index.ts", specifier: "../../src/config/config.js" },
      { path: "extensions/b/index.ts", specifier: "../../../src/plugin-sdk-internal/discord.js" },
    ];
    const baseline = [
      { path: "extensions/a/index.ts", specifier: "../../src/config/config.js" },
      { path: "extensions/c/index.ts", specifier: "../../src/runtime.js" },
    ];
    expect(compareViolationBaseline(current, baseline)).toEqual({
      newViolations: [
        { path: "extensions/b/index.ts", specifier: "../../../src/plugin-sdk-internal/discord.js" },
      ],
      resolvedViolations: [{ path: "extensions/c/index.ts", specifier: "../../src/runtime.js" }],
    });
  });

  it("builds a stable baseline key", () => {
    expect(
      toBaselineKey({
        path: path.join("extensions", "a", "index.ts"),
        specifier: "../../src/config/config.js",
      }),
    ).toBe("extensions/a/index.ts::../../src/config/config.js");
  });
});
