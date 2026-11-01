import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type LocalAcpPreset,
  type LocalAcpPresetId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { type Icon, DeepSeekIcon, KimiCodeIcon, ZCodeIcon } from "../Icons";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { isConfiguredLocalAcpPreset } from "./AddProviderInstanceDialog.logic";

const LOCAL_ACP_PRESET_ICON_BY_ID: Partial<Record<LocalAcpPresetId, Icon>> = {
  kimi: KimiCodeIcon,
  dsh: DeepSeekIcon,
  zcode: ZCodeIcon,
};

/** Local preset detection for the manual local ACP flow; disabled while the step is hidden. */
export function useLocalAcpPresets(environmentId: EnvironmentId, enabled: boolean) {
  return useEnvironmentQuery(
    enabled ? serverEnvironment.listLocalAcpPresets({ environmentId, input: {} }) : null,
  );
}

export type LocalAcpPresetsQuery = ReturnType<typeof useLocalAcpPresets>;

interface LocalAcpPresetListProps {
  readonly environmentId: EnvironmentId;
  readonly presets: LocalAcpPresetsQuery;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly disabled: boolean;
  readonly onSelect: (preset: LocalAcpPreset) => void;
}

export function LocalAcpPresetList({
  environmentId,
  presets,
  providerInstances,
  disabled,
  onSelect,
}: LocalAcpPresetListProps) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const { data, error, isPending, refresh } = presets;

  return (
    <section className="grid gap-2" aria-labelledby="local-acp-presets-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="local-acp-presets-heading" className="text-sm font-medium text-foreground">
            Local agent presets
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One-click setups for officially supported agents on this environment.
          </p>
        </div>
        <Button
          aria-label="Refresh local agent detection"
          disabled={isPending || disabled}
          onClick={() => refresh()}
          size="xs"
          type="button"
          variant="ghost-muted"
        >
          Refresh
        </Button>
      </div>

      <div className="sr-only" role="status">
        {isPending
          ? "Detecting installed local agents."
          : data
            ? `${data.presets.filter((preset) => preset.detected).length} of ${data.presets.length} local agent presets detected.`
            : ""}
      </div>

      {error ? (
        <Alert variant="error" role="status" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data ? (
        <div className="divide-y divide-border/70 rounded-2xl border border-border/70">
          {data.presets.map((preset) => (
            <LocalAcpPresetRow
              key={preset.id}
              preset={preset}
              alreadyAdded={isConfiguredLocalAcpPreset(providerInstances, preset)}
              canAdd={canManageProviders && !disabled}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : isPending ? (
        <div className="flex min-h-16 items-center justify-center rounded-2xl border border-dashed px-4 text-xs text-muted-foreground">
          Detecting installed agents...
        </div>
      ) : null}
    </section>
  );
}

function LocalAcpPresetRow({
  preset,
  alreadyAdded,
  canAdd,
  onSelect,
}: {
  readonly preset: LocalAcpPreset;
  readonly alreadyAdded: boolean;
  readonly canAdd: boolean;
  readonly onSelect: (preset: LocalAcpPreset) => void;
}) {
  const actionLabel = alreadyAdded
    ? "Already added"
    : preset.detected
      ? "Use preset"
      : "Not detected";
  const PresetIcon = LOCAL_ACP_PRESET_ICON_BY_ID[preset.id];
  return (
    <article className="min-w-0 px-3 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {PresetIcon ? (
            <PresetIcon className="size-6 shrink-0" aria-hidden />
          ) : (
            <ProviderInstanceIcon
              driverKind={ProviderDriverKind.make("acpRegistry")}
              displayName={preset.label}
              iconClassName="size-6 rounded-md text-muted-foreground"
            />
          )}
          <div className="min-w-0 flex-1">
            <h4 className="min-w-0 truncate text-sm font-medium text-foreground">{preset.label}</h4>
            {preset.description ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{preset.description}</p>
            ) : null}
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">{preset.detail}</p>
          </div>
        </div>
        <Button
          aria-label={`${actionLabel} ${preset.label}`}
          disabled={!canAdd || alreadyAdded || !preset.detected}
          onClick={() => onSelect(preset)}
          size="xs"
          type="button"
          variant="outline"
        >
          {alreadyAdded ? "Added" : preset.detected ? "Use preset" : "Not detected"}
        </Button>
      </div>
    </article>
  );
}
