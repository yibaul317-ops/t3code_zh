import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DeepSeekIcon, KimiCodeIcon, ZCodeIcon } from "../Icons";
import {
  localAcpRegistryBrandIconForDisplayName,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});

describe("localAcpRegistryBrandIconForDisplayName", () => {
  it("matches the official CN agent display names case-insensitively", () => {
    expect(localAcpRegistryBrandIconForDisplayName("Kimi Code")).toBe(KimiCodeIcon);
    expect(localAcpRegistryBrandIconForDisplayName("  kimi code ")).toBe(KimiCodeIcon);
    expect(localAcpRegistryBrandIconForDisplayName("DeepSeek Harness (DSH)")).toBe(DeepSeekIcon);
    expect(localAcpRegistryBrandIconForDisplayName("deepseek harness")).toBe(DeepSeekIcon);
    expect(localAcpRegistryBrandIconForDisplayName("ZCode")).toBe(ZCodeIcon);
    expect(localAcpRegistryBrandIconForDisplayName("zcode")).toBe(ZCodeIcon);
  });

  it("returns null for other display names", () => {
    expect(localAcpRegistryBrandIconForDisplayName("Kilo")).toBeNull();
    expect(localAcpRegistryBrandIconForDisplayName("")).toBeNull();
  });
});
