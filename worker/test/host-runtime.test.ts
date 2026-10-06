/**
 * The runtime a host's page shows (#325, #330, design v2 §18.1): the driver
 * its agent reports in `runtime.driver` — compose on docker or on podman, or
 * the Quadlet driver, a unit of its owner's own systemd on rootless podman —
 * and the owner's switch in flight, from the report's `runtime.switch`, in
 * the shape the agent sends it (`run::report`, the host-api fixtures).
 */
import { describe, expect, it } from "vitest";
import { hostHtml } from "../src/pages/host";
import { runScript, scriptOf } from "./fixture";
import settingsReport from "../../crates/omarchy-agent/tests/fixtures/host-api/report-settings.json?raw";

function runtimeWords(): (h: unknown) => string {
  const ran = runScript(scriptOf(hostHtml("h_0123456789", "http://pool.test", { version: "test", deployed_at: null } as never)), {
    pathname: "/hosts/h_0123456789", functions: ["runtimeWords"],
  });
  return ran.runtimeWords as (h: unknown) => string;
}

describe("the runtime on a host's page", () => {
  it("names the driver its agent reports, Quadlet among them, and a switch in flight", () => {
    const words = runtimeWords();
    // As the agent reports it (the fixture the agent's own test holds its report to).
    const reported = JSON.parse(settingsReport).runtime;
    expect(words({ runtime: reported })).toBe("compose on docker");
    expect(words({ runtime: { driver: "compose/podman", switch: null } })).toBe("compose on podman");
    expect(words({ runtime: { driver: "quadlet", switch: null, switch_last: { to: "quadlet", outcome: "done" } } }))
      .toBe("Quadlet: a unit of its owner's systemd, on rootless podman");
    expect(words({ runtime: { driver: "compose/podman", switch: { to: "quadlet", step: "up", since: "2027-01-15T08:00:00Z" } } }))
      .toBe("compose on podman — switching to Quadlet: a unit of its owner's systemd, on rootless podman (up)");
    // A driver a later agent carries is shown as it says it, escaped; none said yet is said so.
    expect(words({ runtime: { driver: "kube<b>" } })).toBe("kube&lt;b&gt;");
    expect(words({ runtime: { driver: null } })).toContain("not said yet");
    expect(words({ runtime: null })).toContain("not said yet");
  });
});
