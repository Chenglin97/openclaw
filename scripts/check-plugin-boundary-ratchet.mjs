#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runAsScript, toLine } from "./lib/ts-guard-utils.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(repoRoot, "scripts", "baselines", "plugin-boundary-ratchet.json");

const sourceFilePattern = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u;

function isRelativeOrAbsoluteSpecifier(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:");
}

function normalizeForCompare(filePath) {
  return filePath.replaceAll("\\", "/");
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveImportPath(filePath, specifier) {
  if (specifier.startsWith("file:")) {
    try {
      return new URL(specifier);
    } catch {
      return null;
    }
  }
  return path.resolve(path.dirname(filePath), specifier);
}

function resolvePluginRoot(filePath, repo = repoRoot) {
  const relative = path.relative(path.join(repo, "extensions"), filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const [pluginId] = normalizeForCompare(relative).split("/");
  if (!pluginId) {
    return null;
  }
  return path.join(repo, "extensions", pluginId);
}

export function classifyPluginBoundaryImport(specifier, filePath, options = {}) {
  const repo = options.repoRoot ?? repoRoot;
  const normalizedSpecifier = specifier.trim();
  if (!normalizedSpecifier) {
    return null;
  }

  if (normalizedSpecifier === "openclaw/extension-api") {
    return null;
  }

  if (normalizedSpecifier === "openclaw/plugin-sdk") {
    return null;
  }

  if (normalizedSpecifier === "openclaw/plugin-sdk/compat") {
    return null;
  }

  if (normalizedSpecifier.startsWith("openclaw/plugin-sdk/")) {
    return null;
  }

  if (normalizedSpecifier.includes("plugin-sdk-internal")) {
    return {
      kind: "plugin-sdk-internal",
      reason: "imports non-public plugin-sdk-internal surface",
      preferredReplacement: "Use openclaw/plugin-sdk/* or openclaw/plugin-sdk/compat temporarily.",
    };
  }

  if (!isRelativeOrAbsoluteSpecifier(normalizedSpecifier)) {
    return null;
  }

  const resolved = resolveImportPath(filePath, normalizedSpecifier);
  const resolvedPath =
    resolved instanceof URL
      ? path.resolve(resolved.pathname)
      : resolved
        ? path.resolve(resolved)
        : null;
  if (!resolvedPath) {
    return null;
  }

  const importerPluginRoot = resolvePluginRoot(filePath, repo);
  if (importerPluginRoot && isPathInside(path.join(repo, "extensions"), resolvedPath)) {
    if (!isPathInside(importerPluginRoot, resolvedPath)) {
      return {
        kind: "cross-extension",
        reason: "reaches into another extension via a relative import",
        preferredReplacement:
          "Keep relative imports within the same plugin root, or expose a public surface via openclaw/plugin-sdk/*, openclaw/extension-api, or a dedicated shared package.",
      };
    }
    return null;
  }

  const internalSdkRoot = path.join(repo, "src", "plugin-sdk-internal");
  if (isPathInside(internalSdkRoot, resolvedPath)) {
    return {
      kind: "plugin-sdk-internal",
      reason: "reaches into non-public plugin-sdk-internal implementation",
      preferredReplacement: "Use openclaw/plugin-sdk/* or openclaw/plugin-sdk/compat temporarily.",
    };
  }

  const coreSrcRoot = path.join(repo, "src");
  if (isPathInside(coreSrcRoot, resolvedPath)) {
    return {
      kind: "core-src",
      reason: "reaches into core src/** from an extension",
      preferredReplacement:
        "Use openclaw/plugin-sdk/*, openclaw/extension-api, or openclaw/plugin-sdk/compat temporarily.",
    };
  }

  return null;
}

function getImportLikeSpecifiers(sourceFile) {
  const specifiers = [];

  const push = (node, specifierNode) => {
    if (!ts.isStringLiteralLike(specifierNode)) {
      return;
    }
    specifiers.push({
      specifier: specifierNode.text,
      line: toLine(sourceFile, specifierNode),
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      push(node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push(node, node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      push(node, node.arguments[0]);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "vi") ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === "jest")) &&
          node.expression.name.text === "mock"))
    ) {
      push(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

export function findPluginBoundaryViolations(content, filePath, options = {}) {
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const violations = [];
  for (const entry of getImportLikeSpecifiers(sourceFile)) {
    const classification = classifyPluginBoundaryImport(entry.specifier, filePath, options);
    if (!classification) {
      continue;
    }
    violations.push({
      line: entry.line,
      specifier: entry.specifier,
      kind: classification.kind,
      reason: classification.reason,
      preferredReplacement: classification.preferredReplacement,
    });
  }
  return violations;
}

async function collectSourceFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "coverage"].includes(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !sourceFilePattern.test(entry.name) || fullPath.endsWith(".d.ts")) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files.toSorted();
}

async function collectBundledPluginSourceFiles(repo = repoRoot) {
  const entries = await fs.readdir(path.join(repo, "extensions"), { withFileTypes: true });
  const filesToCheck = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rootDir = path.join(repo, "extensions", entry.name);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    try {
      await fs.access(manifestPath);
    } catch {
      continue;
    }
    const entrySource = path.join(rootDir, "index.ts");
    try {
      await fs.access(entrySource);
      filesToCheck.add(entrySource);
    } catch {
      // Some plugins may be source-only under src/ without a root index.ts.
    }
    for (const srcFile of await collectSourceFiles(rootDir)) {
      filesToCheck.add(srcFile);
    }
  }

  for (const sharedFile of await collectSourceFiles(path.join(repo, "extensions", "shared"))) {
    filesToCheck.add(sharedFile);
  }

  return [...filesToCheck].toSorted((left, right) => left.localeCompare(right));
}

export function toBaselineKey(entry) {
  return `${normalizeForCompare(entry.path)}::${entry.specifier}`;
}

export function compareViolationBaseline(current, baseline) {
  const baselineKeys = new Set(baseline.map(toBaselineKey));
  const currentKeys = new Set(current.map(toBaselineKey));

  const newViolations = current.filter((entry) => !baselineKeys.has(toBaselineKey(entry)));
  const resolvedViolations = baseline.filter((entry) => !currentKeys.has(toBaselineKey(entry)));

  return { newViolations, resolvedViolations };
}

export async function loadViolationBaseline(filePath = baselinePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Baseline file must be an array: ${filePath}`);
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Baseline entry #${index + 1} must be an object.`);
    }
    if (typeof entry.path !== "string" || typeof entry.specifier !== "string") {
      throw new Error(`Baseline entry #${index + 1} must include string path and specifier.`);
    }
    return {
      path: entry.path,
      specifier: entry.specifier,
    };
  });
}

export async function collectCurrentViolations(options = {}) {
  const repo = options.repoRoot ?? repoRoot;
  const files = await collectBundledPluginSourceFiles(repo);
  const violations = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = findPluginBoundaryViolations(content, filePath, { repoRoot: repo });
    for (const violation of fileViolations) {
      violations.push({
        path: path.relative(repo, filePath),
        specifier: violation.specifier,
        line: violation.line,
        kind: violation.kind,
        reason: violation.reason,
        preferredReplacement: violation.preferredReplacement,
      });
    }
  }

  const deduped = [...new Map(violations.map((entry) => [toBaselineKey(entry), entry])).values()];

  return deduped.toSorted((left, right) => {
    const pathCompare = left.path.localeCompare(right.path);
    if (pathCompare !== 0) {
      return pathCompare;
    }
    return left.specifier.localeCompare(right.specifier);
  });
}

function printViolations(header, violations) {
  if (violations.length === 0) {
    return;
  }
  console.error(header);
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}`);
    console.error(`  import: ${JSON.stringify(violation.specifier)}`);
    console.error(`  why: ${violation.reason}`);
    console.error(`  prefer: ${violation.preferredReplacement}`);
  }
}

async function main() {
  const files = await collectBundledPluginSourceFiles(repoRoot);
  const currentViolations = await collectCurrentViolations({ repoRoot });
  const baseline = await loadViolationBaseline();
  const { newViolations, resolvedViolations } = compareViolationBaseline(
    currentViolations,
    baseline,
  );

  if (newViolations.length > 0) {
    printViolations(
      "New extension boundary violations found. Bundled plugins should generally use public plugin SDK/runtime surfaces.",
      newViolations,
    );
    if (resolvedViolations.length > 0) {
      console.error("");
      console.error(
        `Note: ${resolvedViolations.length} baseline violation(s) were removed; delete them from ${path.relative(repoRoot, baselinePath)} after this change lands.`,
      );
    }
    console.error("");
    console.error(
      "Allowed for now: openclaw/plugin-sdk/*, openclaw/plugin-sdk/compat, and openclaw/extension-api.",
    );
    console.error(
      "Reducing existing baseline entries is encouraged; only new violations should fail this ratchet.",
    );
    process.exit(1);
  }

  if (resolvedViolations.length > 0) {
    console.log(
      `OK: no new extension boundary violations (${files.length} files checked). ${resolvedViolations.length} baseline violation(s) are now gone; remove them from ${path.relative(repoRoot, baselinePath)} when convenient.`,
    );
    return;
  }

  console.log(`OK: no new extension boundary violations (${files.length} files checked).`);
}

runAsScript(import.meta.url, main);
