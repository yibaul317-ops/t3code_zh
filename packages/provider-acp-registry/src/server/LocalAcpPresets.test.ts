import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as LocalAcpPresets from "./LocalAcpPresets.ts";

const textEncoder = new TextEncoder();

interface SpawnScript {
  readonly stdout?: string;
  readonly exitCode?: number;
}

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const testPlatform = process.platform as NodeJS.Platform;
const isWindowsHost = process.platform === "win32";
const executableName = (platform: NodeJS.Platform, base: string) =>
  platform === "win32" && !/\.(exe|cmd|bat|com)$/iu.test(base) ? `${base}.exe` : base;

function makeHandle(script: SpawnScript): ChildProcessSpawner.ChildProcessHandle {
  const stdoutText = script.stdout ?? "";
  return ChildProcessSpawner.makeHandle({
    pid: 1 as ChildProcessSpawner.ProcessId,
    exitCode: Effect.succeed((script.exitCode ?? 0) as ChildProcessSpawner.ExitCode),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout:
      stdoutText.length === 0
        ? Stream.empty
        : Stream.fromIterable([textEncoder.encode(stdoutText)]),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function scriptSpawner(
  calls: Array<SpawnCall>,
  script: (command: string, args: ReadonlyArray<string>) => SpawnScript | undefined,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("unexpected piped command");
    calls.push({ command: command.command, args: command.args });
    const matched = script(command.command, command.args);
    return Effect.succeed(makeHandle(matched ?? { exitCode: 1 }));
  });
}

const makeExecutable = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(filePath), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(filePath, "");
    if (!isWindowsHost) yield* fileSystem.chmod(filePath, 0o755);
  });

const makePackageEntry = (npmRoot: string, packageName: string, entry: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* makeExecutable(path.join(npmRoot, ...packageName.split("/"), ...entry.split("/")));
  });

function makeDependencies(options: {
  readonly calls: Array<SpawnCall>;
  readonly script: (command: string, args: ReadonlyArray<string>) => SpawnScript | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
}) {
  return Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      scriptSpawner(options.calls, options.script),
    ),
    Layer.succeed(HostProcess.Platform, options.platform ?? testPlatform),
    Layer.succeed(HostProcess.Architecture, process.arch),
    Layer.succeed(HostProcess.Environment, options.environment),
    Layer.succeed(HostProcess.HomeDirectory, options.homeDirectory),
  );
}

const detectPresets = (options?: LocalAcpPresets.LocalAcpPresetsOptions) =>
  Effect.gen(function* () {
    const service = yield* LocalAcpPresets.LocalAcpPresets;
    const first = yield* service.detect();
    const second = yield* service.detect();
    expect(second).toEqual(first);
    return first;
  }).pipe(Effect.provide(LocalAcpPresets.layer(options)));

const npmRootScript =
  (npmRoot: string) =>
  (command: string, args: ReadonlyArray<string>): SpawnScript | undefined =>
    /npm(\.(exe|cmd))?$/iu.test(command) && args[0] === "root"
      ? { stdout: `${npmRoot}\n` }
      : undefined;

const nodeVersionScript =
  (versions: ReadonlyArray<{ match: RegExp; version: string }>) =>
  (command: string, args: ReadonlyArray<string>): SpawnScript | undefined => {
    if (args[0] !== "--version") return undefined;
    const matched = versions.find((candidate) => candidate.match.test(command));
    return matched === undefined ? undefined : { stdout: `${matched.version}\n` };
  };

const PRESET_IDS = ["kimi", "dsh", "zcode"] as const;

describe("LocalAcpPresets", () => {
  it.effect("detects Kimi Code from npm root -g and caches the npm root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      const nodePath = path.join(binDirectory, executableName(testPlatform, "node"));
      yield* makeExecutable(nodePath);
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "@moonshot-ai/kimi-code", "dist/main.mjs");
      const calls: Array<SpawnCall> = [];
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls,
              homeDirectory: path.join(root, "home"),
              environment: { PATH: binDirectory },
              script: npmRootScript(npmRoot),
            }),
          ),
        ),
      );

      const kimi = presets.presets.find((preset) => preset.id === "kimi");
      expect(kimi).toMatchObject({
        detected: true,
        instanceId: "acpRegistry_kimi",
        environment: [],
        config: {
          source: "local",
          commandArgs: [path.join(npmRoot, "@moonshot-ai", "kimi-code", "dist", "main.mjs"), "acp"],
        },
      });
      expect(kimi?.config?.commandPath.toLowerCase()).toBe(nodePath.toLowerCase());
      expect(presets.presets.map((preset) => preset.id)).toEqual(PRESET_IDS);
      expect(presets.presets.find((preset) => preset.id === "dsh")?.detected).toBe(false);
      expect(presets.presets.find((preset) => preset.id === "zcode")?.detected).toBe(false);
      expect(calls.filter((call) => call.args[0] === "root")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("marks DSH undetected when only Node.js 22 is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "node")));
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "@deepseek-ai/dsh", "lib/bin.js");
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment: { PATH: binDirectory },
              script: (command, args) =>
                npmRootScript(npmRoot)(command, args) ??
                nodeVersionScript([{ match: /node(24)?(\.(exe|cmd))?$/iu, version: "v22.12.0" }])(
                  command,
                  args,
                ),
            }),
          ),
        ),
      );

      const dsh = presets.presets.find((preset) => preset.id === "dsh");
      expect(dsh?.detected).toBe(false);
      expect(dsh?.config).toBeUndefined();
      expect(dsh?.detail).toContain("Node.js 24");
      expect(dsh?.detail).toContain("v22");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects DSH with a Node.js 24 toolchain from ~/.local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      const homeDirectory = path.join(root, "home");
      const node24Path = isWindowsHost
        ? path.join(homeDirectory, ".local", "node-v24.5.0-win-x64", "node.exe")
        : path.join(homeDirectory, ".local", "node-v24.5.0-linux-x64", "bin", "node");
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "node")));
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makeExecutable(node24Path);
      yield* makePackageEntry(npmRoot, "@deepseek-ai/dsh", "lib/bin.js");
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory,
              environment: { PATH: binDirectory },
              script: (command, args) =>
                npmRootScript(npmRoot)(command, args) ??
                nodeVersionScript([
                  { match: /node-v24/iu, version: "v24.5.0" },
                  { match: /node(24)?(\.(exe|cmd))?$/iu, version: "v22.12.0" },
                ])(command, args),
            }),
          ),
        ),
      );

      const dsh = presets.presets.find((preset) => preset.id === "dsh");
      expect(dsh).toMatchObject({
        detected: true,
        config: {
          source: "local",
          commandPath: node24Path,
          commandArgs: [
            path.join(npmRoot, "@deepseek-ai", "dsh", "lib", "bin.js"),
            "--profile",
            "acp",
          ],
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the per-user npm root when npm is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const emptyBin = path.join(root, "empty-bin");
      yield* fileSystem.makeDirectory(emptyBin, { recursive: true });
      if (testPlatform === "win32") {
        yield* fileSystem.makeDirectory(
          path.join(root, "AppData", "Roaming", "npm", "node_modules"),
          { recursive: true },
        );
      }
      const calls: Array<SpawnCall> = [];
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls,
              homeDirectory: path.join(root, "home"),
              environment:
                testPlatform === "win32"
                  ? {
                      PATH: emptyBin,
                      APPDATA: path.join(root, "AppData", "Roaming"),
                    }
                  : { PATH: emptyBin },
              script: () => undefined,
            }),
          ),
        ),
      );

      for (const preset of presets.presets) {
        expect(preset.detected).toBe(false);
        expect(preset.detail).toMatch(/not installed|npm global root/);
      }
      expect(calls.filter((call) => call.args[0] === "root")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects ZCode with its full environment and a discovered ZCODE_BIN", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      const nodePath = path.join(binDirectory, executableName(testPlatform, "node"));
      const zcodeBin = path.join(
        root,
        "local-appdata",
        "Programs",
        "ZCode",
        "resources",
        "glm",
        "zcode.cjs",
      );
      yield* makeExecutable(nodePath);
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "zcode-acp-server", "dist/index.js");
      yield* makeExecutable(zcodeBin);
      const presets = yield* detectPresets({ zcodeInstallRoots: [] }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment: {
                PATH: binDirectory,
                LOCALAPPDATA: path.join(root, "local-appdata"),
              },
              script: npmRootScript(npmRoot),
            }),
          ),
        ),
      );

      const zcode = presets.presets.find((preset) => preset.id === "zcode");
      expect(zcode).toMatchObject({
        detected: true,
        instanceId: "acpRegistry_zcode",
        config: {
          source: "local",
          commandArgs: [path.join(npmRoot, "zcode-acp-server", "dist", "index.js")],
        },
      });
      expect(zcode?.config?.commandPath.toLowerCase()).toBe(nodePath.toLowerCase());
      expect(zcode?.environment).toEqual([
        {
          name: "ZCODE_ACP_SHOW_COMPLETION_STATUS",
          value: "0",
          sensitive: false,
        },
        {
          name: "ZCODE_PROVIDER",
          value: "builtin:bigmodel-coding-plan",
          sensitive: false,
        },
        { name: "ZCODE_MODEL", value: "GLM-5.3", sensitive: false },
        {
          name: "ZCODE_NODE",
          value: zcode?.config?.commandPath,
          sensitive: false,
        },
        { name: "ZCODE_BIN", value: zcodeBin, sensitive: false },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("honors a verbatim ZCode install root for ZCODE_BIN", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      const installRoot = path.join(root, "custom-zcode");
      const zcodeBin = path.join(installRoot, "resources", "glm", "zcode.cjs");
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "node")));
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "zcode-acp-server", "dist/index.js");
      yield* makeExecutable(zcodeBin);
      const presets = yield* detectPresets({
        zcodeInstallRoots: [installRoot],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment: { PATH: binDirectory },
              script: npmRootScript(npmRoot),
            }),
          ),
        ),
      );

      const zcode = presets.presets.find((preset) => preset.id === "zcode");
      expect(zcode?.detected).toBe(true);
      expect(zcode?.environment).toContainEqual({
        name: "ZCODE_BIN",
        value: zcodeBin,
        sensitive: false,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("omits ZCODE_BIN when no zcode.cjs is found", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const binDirectory = path.join(root, "bin");
      const npmRoot = path.join(root, "global-node_modules");
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "node")));
      yield* makeExecutable(path.join(binDirectory, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "zcode-acp-server", "dist/index.js");
      const presets = yield* detectPresets({ zcodeInstallRoots: [] }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment: { PATH: binDirectory },
              script: npmRootScript(npmRoot),
            }),
          ),
        ),
      );

      const zcode = presets.presets.find((preset) => preset.id === "zcode");
      expect(zcode?.detected).toBe(true);
      expect(zcode?.environment.map((variable) => variable.name)).not.toContain("ZCODE_BIN");
      expect(zcode?.environment.map((variable) => variable.name)).toContain("ZCODE_NODE");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports when Node.js is missing from PATH entirely", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const emptyBin = path.join(root, "empty-bin");
      yield* fileSystem.makeDirectory(emptyBin, { recursive: true });
      const npmRoot = path.join(root, "global-node_modules");
      yield* makeExecutable(path.join(emptyBin, executableName(testPlatform, "npm")));
      yield* makePackageEntry(npmRoot, "@moonshot-ai/kimi-code", "dist/main.mjs");
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment: { PATH: emptyBin },
              script: npmRootScript(npmRoot),
            }),
          ),
        ),
      );

      const kimi = presets.presets.find((preset) => preset.id === "kimi");
      expect(kimi?.detected).toBe(false);
      expect(kimi?.detail).toContain("Node.js was not found");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an undetected preset when the npm global root cannot be located", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-presets-",
      });
      const emptyBin = path.join(root, "empty-bin");
      yield* fileSystem.makeDirectory(emptyBin, { recursive: true });
      const environment: NodeJS.ProcessEnv = { PATH: emptyBin };
      if (testPlatform === "win32") environment.APPDATA = path.join(root, "missing-appdata");
      const presets = yield* detectPresets().pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeDependencies({
              calls: [],
              homeDirectory: path.join(root, "home"),
              environment,
              script: () => undefined,
            }),
          ),
        ),
      );

      for (const preset of presets.presets) {
        expect(preset.detected).toBe(false);
        expect(preset.detail).toContain("npm global root");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
