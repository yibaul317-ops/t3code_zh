import {
  type LocalAcpPresetId,
  LocalAcpPresetListResult,
  type LocalAcpPresetListResult as LocalAcpPresetListResultType,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const NPM_ROOT_TIMEOUT = "15 seconds";
const NODE_VERSION_TIMEOUT = "10 seconds";
const PROBE_OUTPUT_MAX_BYTES = 64 * 1024;

interface LocalAcpPresetEnvironmentVariable {
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
}

interface LocalAcpPresetDefinitionBase {
  readonly id: LocalAcpPresetId;
  readonly label: string;
  readonly description: string;
  readonly instanceId: string;
}

interface LocalPackageAcpPresetDefinition extends LocalAcpPresetDefinitionBase {
  readonly kind: "localPackage";
  readonly packageName: string;
  readonly entry: string;
  readonly minimumNodeMajor: number;
  readonly commandArgs: (entryPath: string) => ReadonlyArray<string>;
  readonly environment: (input: {
    readonly nodePath: string;
    readonly environment: NodeJS.ProcessEnv;
  }) => Effect.Effect<ReadonlyArray<LocalAcpPresetEnvironmentVariable>, never>;
}

interface RegistryAcpPresetDefinition extends LocalAcpPresetDefinitionBase {
  readonly kind: "registry";
  readonly agentId: string;
}

type LocalAcpPresetDefinition = LocalPackageAcpPresetDefinition | RegistryAcpPresetDefinition;

const KIMI_PRESET: RegistryAcpPresetDefinition = {
  kind: "registry",
  id: "kimi",
  label: "Kimi Code",
  description:
    "Moonshot AI's Kimi CLI. T3 downloads the official build from the ACP Registry and keeps it updated.",
  instanceId: "acpRegistry_kimi",
  agentId: "kimi",
};

const DSH_PRESET: LocalPackageAcpPresetDefinition = {
  kind: "localPackage",
  id: "dsh",
  label: "DeepSeek Harness (DSH)",
  description:
    "DeepSeek's DSH agent running its official ACP profile (dsh --profile acp). Requires Node.js 24 or newer.",
  instanceId: "acpRegistry_dsh",
  packageName: "@deepseek-ai/dsh",
  entry: "lib/bin.js",
  minimumNodeMajor: 24,
  commandArgs: (entryPath) => [entryPath, "--profile", "acp"],
  environment: () => Effect.succeed([]),
};

const ZCODE_ENVIRONMENT_BASE: ReadonlyArray<LocalAcpPresetEnvironmentVariable> = [
  { name: "ZCODE_ACP_SHOW_COMPLETION_STATUS", value: "0", sensitive: false },
  {
    name: "ZCODE_PROVIDER",
    value: "builtin:bigmodel-coding-plan",
    sensitive: false,
  },
  { name: "ZCODE_MODEL", value: "GLM-5.3", sensitive: false },
];

function readEnvironmentVariable(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = environment[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  return Object.entries(environment).find(([key]) => key.toLowerCase() === lowerName)?.[1];
}

function parseNodeMajorVersion(output: string): number | undefined {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  const match = line === undefined ? null : /^v(\d+)(?:\.|$)/u.exec(line);
  return match === null ? undefined : Number(match[1]);
}

const CachedRegistryIndex = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({ id: Schema.String, version: Schema.optional(Schema.String) }),
  ),
});
const decodeCachedRegistryIndex = Schema.decodeUnknownOption(CachedRegistryIndex);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodePresetListResult = Schema.decodeEffect(LocalAcpPresetListResult);

export class LocalAcpPresets extends Context.Service<
  LocalAcpPresets,
  {
    /** Probe the environment for officially supported local ACP agents. */
    readonly detect: (
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<LocalAcpPresetListResultType, never>;
  }
>()("@t3tools/provider-acp-registry/server/LocalAcpPresets") {}

export interface LocalAcpPresetsOptions {
  /** Verbatim ZCode install roots checked before Program Files-style discovery. */
  readonly zcodeInstallRoots?: ReadonlyArray<string>;
}

const DEFAULT_ZCODE_INSTALL_ROOTS = ["E:\\work_software\\zcode"] as const;

const makeLocalAcpPresets = Effect.fn("LocalAcpPresets.make")(function* (
  options: LocalAcpPresetsOptions,
): Effect.fn.Return<
  LocalAcpPresets["Service"],
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const resolveExecutable = yield* SpawnExecutableResolution;
  const { paths: hostPaths } = yield* ProviderHost.ProviderHost;
  const registryCachePath = path.join(
    hostPaths.providerStatusCacheDir,
    "acp-registry",
    "registry.json",
  );

  const runCommandText = Effect.fn("LocalAcpPresets.runCommandText")(function* (
    command: string,
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
    timeout: Duration.Input,
  ): Effect.fn.Return<Option.Option<string>, never> {
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(command, args, {
        env: environment,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: environment,
          shell: resolved.shell,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: PROBE_OUTPUT_MAX_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: PROBE_OUTPUT_MAX_BYTES,
          }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0 || stdout.truncated || stdout.invalidUtf8) {
        return Option.none<string>();
      }
      return Option.some(stdout.text);
    }).pipe(Effect.scoped);
    return yield* collect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.succeed(Option.none<string>()),
      }),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

  const probeZcodeBin = Effect.fn("LocalAcpPresets.probeZcodeBin")(function* (
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string | undefined, never> {
    const installRoots: Array<string> = [
      ...(platform === "win32" ? (options.zcodeInstallRoots ?? DEFAULT_ZCODE_INSTALL_ROOTS) : []),
    ];
    const programsRoots = [
      readEnvironmentVariable(environment, "LOCALAPPDATA"),
      readEnvironmentVariable(environment, "ProgramFiles"),
      readEnvironmentVariable(environment, "ProgramFiles(x86)"),
    ]
      .filter(
        (directory): directory is string => typeof directory === "string" && directory.length > 0,
      )
      .map((directory) => path.join(directory, "Programs"));
    for (const parent of programsRoots) {
      const entries = yield* fileSystem
        .readDirectory(parent)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const entry of entries) {
        if (/^zcode/i.test(entry)) installRoots.push(path.join(parent, entry));
      }
    }
    for (const root of installRoots) {
      for (const relative of [["resources", "glm", "zcode.cjs"], ["zcode.cjs"]] as const) {
        const candidate = path.join(root, ...relative);
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          return candidate;
        }
      }
    }
    return undefined;
  });

  const ZCODE_PRESET: LocalPackageAcpPresetDefinition = {
    kind: "localPackage",
    id: "zcode",
    label: "ZCode",
    description:
      "ZCode's GLM coding agent through the zcode-acp-server bridge, which reuses your ZCode desktop sign-in and refreshes it automatically (no API key to manage).",
    instanceId: "acpRegistry_zcode",
    packageName: "zcode-acp-server",
    entry: "dist/index.js",
    minimumNodeMajor: 0,
    commandArgs: (entryPath) => [entryPath],
    environment: (input) =>
      Effect.map(probeZcodeBin(input.environment), (zcodeBin) => [
        ...ZCODE_ENVIRONMENT_BASE,
        { name: "ZCODE_NODE", value: input.nodePath, sensitive: false },
        ...(zcodeBin === undefined
          ? []
          : [{ name: "ZCODE_BIN", value: zcodeBin, sensitive: false }]),
      ]),
  };

  const localAcpPresets: ReadonlyArray<LocalAcpPresetDefinition> = [
    KIMI_PRESET,
    DSH_PRESET,
    ZCODE_PRESET,
  ];

  const registryAgentVersion = Effect.fn("LocalAcpPresets.registryAgentVersion")(function* (
    agentId: string,
  ): Effect.fn.Return<string | undefined, never> {
    const json = yield* fileSystem.readFileString(registryCachePath).pipe(
      Effect.flatMap((text) => decodeJsonText(text)),
      Effect.orElseSucceed((): null => null),
    );
    if (json === null) return undefined;
    const decoded = decodeCachedRegistryIndex(json);
    if (Option.isNone(decoded)) return undefined;
    return decoded.value.agents.find((agent) => agent.id === agentId)?.version;
  });

  const npmRootFallbackCandidates = (environment: NodeJS.ProcessEnv): ReadonlyArray<string> => {
    if (platform === "win32") {
      const appData = readEnvironmentVariable(environment, "APPDATA");
      return appData === undefined || appData.length === 0
        ? []
        : [path.join(appData, "npm", "node_modules")];
    }
    return ["/usr/local/lib/node_modules", "/usr/lib/node_modules"];
  };

  const npmRootCache = yield* Ref.make<Option.Option<string>>(Option.none());

  const resolveNpmRoot = Effect.fn("LocalAcpPresets.resolveNpmRoot")(function* (
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string | undefined, never> {
    const cached = yield* Ref.get(npmRootCache);
    if (Option.isSome(cached)) return cached.value;

    let root: string | undefined;
    const npmPath = resolveExecutable("npm", platform, environment);
    if (npmPath !== undefined) {
      const output = yield* runCommandText(npmPath, ["root", "-g"], environment, NPM_ROOT_TIMEOUT);
      if (Option.isSome(output)) {
        const line = output.value
          .split(/\r?\n/u)
          .map((entry) => entry.trim())
          .find((entry) => entry.length > 0);
        if (line !== undefined && path.isAbsolute(line)) root = line;
      }
    }
    if (root === undefined) {
      for (const candidate of npmRootFallbackCandidates(environment)) {
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          root = candidate;
          break;
        }
      }
    }
    if (root !== undefined) yield* Ref.set(npmRootCache, Option.some(root));
    return root;
  });

  const nodeRuntimeFor = Effect.fn("LocalAcpPresets.nodeRuntimeFor")(function* (
    minimumMajor: number,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    | {
        readonly status: "ok";
        readonly nodePath: string;
        readonly detail?: string;
      }
    | { readonly status: "too_old"; readonly found: string }
    | { readonly status: "missing" },
    never
  > {
    if (minimumMajor <= 0) {
      const nodePath = resolveExecutable("node", platform, environment);
      return nodePath === undefined ? { status: "missing" } : { status: "ok", nodePath };
    }

    const candidates: Array<string> = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: string | undefined) => {
      if (candidate !== undefined && !seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    };
    pushCandidate(resolveExecutable("node24", platform, environment));
    const localToolchains = path.join(homeDirectory, ".local");
    const localEntries = yield* fileSystem
      .readDirectory(localToolchains)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    for (const entry of localEntries) {
      if (!/^node-v\d+/iu.test(entry)) continue;
      pushCandidate(
        platform === "win32"
          ? path.join(localToolchains, entry, "node.exe")
          : path.join(localToolchains, entry, "bin", "node"),
      );
    }
    pushCandidate(resolveExecutable("node", platform, environment));

    let best: { readonly nodePath: string; readonly major: number } | undefined;
    for (const candidate of candidates) {
      const output = yield* runCommandText(
        candidate,
        ["--version"],
        environment,
        NODE_VERSION_TIMEOUT,
      );
      if (Option.isNone(output)) continue;
      const major = parseNodeMajorVersion(output.value);
      if (major === undefined) continue;
      if (best === undefined || major > best.major) best = { nodePath: candidate, major };
      if (major >= minimumMajor) {
        return { status: "ok", nodePath: candidate, detail: `v${major}` };
      }
    }
    return best === undefined
      ? { status: "missing" }
      : { status: "too_old", found: `v${best.major}` };
  });

  interface ProbedLocalAcpPreset {
    readonly id: LocalAcpPresetId;
    readonly label: string;
    readonly description: string;
    readonly detected: boolean;
    readonly detail: string;
    readonly instanceId: string;
    readonly config?:
      | {
          readonly source: "local";
          readonly commandPath: string;
          readonly commandArgs: Array<string>;
        }
      | {
          readonly source: "registry";
          readonly agentId: string;
          readonly distribution: "auto" | "binary" | "npx" | "uvx";
        };
    readonly environment: ReadonlyArray<LocalAcpPresetEnvironmentVariable>;
  }

  const detectLocalPackagePreset = Effect.fn("LocalAcpPresets.detectLocalPackagePreset")(function* (
    definition: LocalPackageAcpPresetDefinition,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<ProbedLocalAcpPreset, never> {
    const base = {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      instanceId: definition.instanceId,
    } as const;

    const npmRoot = yield* resolveNpmRoot(environment);
    if (npmRoot === undefined) {
      return {
        ...base,
        detected: false,
        detail:
          "Could not locate the npm global root: npm is not on PATH and no fallback directory exists.",
        environment: [],
      };
    }

    const entryPath = path.join(
      npmRoot,
      ...definition.packageName.split("/"),
      ...definition.entry.split("/"),
    );
    const entryExists = yield* fileSystem.exists(entryPath).pipe(Effect.orElseSucceed(() => false));
    if (!entryExists) {
      return {
        ...base,
        detected: false,
        detail: `${definition.packageName} is not installed in the npm global root (${npmRoot}). Install it with: npm install -g ${definition.packageName}`,
        environment: [],
      };
    }

    const nodeRuntime = yield* nodeRuntimeFor(definition.minimumNodeMajor, environment);
    if (nodeRuntime.status === "missing") {
      return {
        ...base,
        detected: false,
        detail:
          definition.minimumNodeMajor > 0
            ? `No Node.js runtime was found on PATH or in ~/.local, but ${definition.label} requires Node.js ${definition.minimumNodeMajor} or newer.`
            : "Node.js was not found on this environment's PATH.",
        environment: [],
      };
    }
    if (nodeRuntime.status === "too_old") {
      return {
        ...base,
        detected: false,
        detail: `${definition.label} requires Node.js ${definition.minimumNodeMajor} or newer; the newest runtime found was ${nodeRuntime.found}. Install Node.js ${definition.minimumNodeMajor}+ (for example under ~/.local/node-v24*) or put a node24 shim on PATH.`,
        environment: [],
      };
    }

    const environmentVariables = yield* definition.environment({
      nodePath: nodeRuntime.nodePath,
      environment,
    });
    return {
      ...base,
      detected: true,
      detail:
        definition.id === "dsh"
          ? `Found at ${entryPath} with Node.js ${nodeRuntime.detail ?? ""} at ${nodeRuntime.nodePath}.`
          : `Found at ${entryPath}.`,
      config: {
        source: "local",
        commandPath: nodeRuntime.nodePath,
        commandArgs: [...definition.commandArgs(entryPath)],
      },
      environment: environmentVariables.map((variable) => ({ ...variable })),
    };
  });

  const detectRegistryPreset = Effect.fn("LocalAcpPresets.detectRegistryPreset")(function* (
    definition: RegistryAcpPresetDefinition,
  ): Effect.fn.Return<ProbedLocalAcpPreset, never> {
    const cachedVersion = yield* registryAgentVersion(definition.agentId);
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      instanceId: definition.instanceId,
      // The registry search path is online-capable, so the card stays addable even
      // before the cached index mentions the agent.
      detected: true,
      detail:
        cachedVersion === undefined
          ? `T3 downloads ${definition.label} from the official ACP Registry on first use and keeps it updated.`
          : `Official ACP Registry entry found (v${cachedVersion}). T3 downloads ${definition.label} and keeps it updated automatically.`,
      config: {
        source: "registry",
        agentId: definition.agentId,
        distribution: "auto",
      },
      environment: [],
    };
  });

  const detect = Effect.fn("LocalAcpPresets.detect")(function* (
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<LocalAcpPresetListResultType, never> {
    const effectiveEnvironment = environment ?? hostEnvironment;
    const probed = yield* Effect.forEach(localAcpPresets, (definition) =>
      definition.kind === "registry"
        ? detectRegistryPreset(definition)
        : detectLocalPackagePreset(definition, effectiveEnvironment),
    );
    return yield* decodePresetListResult({ presets: probed }).pipe(Effect.orDie);
  });

  return LocalAcpPresets.of({ detect });
});

export const layer = (
  options: LocalAcpPresetsOptions = {},
): Layer.Layer<
  LocalAcpPresets,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost
> => Layer.effect(LocalAcpPresets, makeLocalAcpPresets(options));
