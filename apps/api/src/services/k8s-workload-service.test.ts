import { describe, expect, it } from "vitest";
import type { ContainerSpec } from "@optio/shared";
import {
  K8sWorkloadManager,
  WORKLOAD_ALLOWED_CAPABILITIES,
  validateWorkloadCapabilities,
} from "./k8s-workload-service.js";

function baseSpec(overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    image: "optio-agent:latest",
    command: ["/opt/optio/repo-init.sh"],
    env: {},
    workDir: "/workspace",
    labels: { "optio.type": "repo-pod" },
    ...overrides,
  };
}

function buildTemplate(spec: ContainerSpec, restartPolicy: "Always" | "Never" = "Always") {
  const manager = Object.create(K8sWorkloadManager.prototype) as {
    buildPodTemplate: (
      spec: ContainerSpec,
      instanceName: string,
      restartPolicy: "Always" | "Never",
    ) => unknown;
  };
  return manager.buildPodTemplate(spec, "repo-abc", restartPolicy) as any;
}

describe("K8sWorkloadManager security context", () => {
  it("drops capabilities and disables privilege escalation by default", () => {
    const template = buildTemplate(baseSpec());
    const container = template.spec.containers[0];

    expect(container.securityContext.capabilities).toEqual({ drop: ["ALL"] });
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.seccompProfile).toEqual({ type: "RuntimeDefault" });
  });

  it("allows only capabilities from the workload allowlist", () => {
    const template = buildTemplate(baseSpec({ capabilities: ["SYS_CHROOT"] }));
    const container = template.spec.containers[0];

    expect(container.securityContext.capabilities).toEqual({
      drop: ["ALL"],
      add: ["SYS_CHROOT"],
    });
  });

  it("rejects disallowed capabilities", () => {
    expect(() => buildTemplate(baseSpec({ capabilities: ["SYS_ADMIN"] }))).toThrow(
      "Disallowed container capabilities requested: SYS_ADMIN",
    );
  });

  it("keeps the workload allowlist aligned with Docker-in-Docker needs", () => {
    expect(WORKLOAD_ALLOWED_CAPABILITIES.has("SYS_CHROOT")).toBe(true);
    expect(WORKLOAD_ALLOWED_CAPABILITIES.has("SYS_ADMIN")).toBe(false);
    expect(() => validateWorkloadCapabilities(["SYS_CHROOT"])).not.toThrow();
  });
});
