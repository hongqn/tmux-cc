import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const deploy = await import("../scripts/deploy.mjs");

describe("deployment contract", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  function writeConfig(json: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "tmux-cc-deploy-"));
    tmpDirs.push(dir);
    const path = join(dir, "deploy.json");
    writeFileSync(path, JSON.stringify(json, null, 2));
    return path;
  }

  it("loads private deployment targets from an ignored config file", async () => {
    const configPath = writeConfig({
      targets: [
        {
          stage: "canary",
          steps: [{ command: "echo", args: ["private-host-one:/private/path"] }],
        },
        {
          stage: "remaining",
          steps: [{ command: "echo", args: ["private-host-two:/private/path"] }],
        },
      ],
    });

    const config = await deploy.loadDeploymentConfig({
      configPath,
      env: {},
    });

    expect(config.targets).toHaveLength(2);
    expect(config.targets[0].steps[0].args[0]).toBe("private-host-one:/private/path");
  });

  it("loads private deployment targets from an environment variable", async () => {
    const config = await deploy.loadDeploymentConfig({
      env: {
        TMUX_CC_DEPLOY_CONFIG_JSON: JSON.stringify({
          targets: [
            {
              stage: "canary",
              steps: [{ command: "echo", args: ["private-host-from-env"] }],
            },
          ],
        }),
      },
    });

    expect(config.targets[0].steps[0].args[0]).toBe("private-host-from-env");
  });

  it("selects canary, remaining, and all stages in the required order", () => {
    const config = {
      targets: [
        { stage: "remaining", steps: [{ command: "echo", args: ["second"] }] },
        { stage: "canary", steps: [{ command: "echo", args: ["first"] }] },
        { stage: "remaining", steps: [{ command: "echo", args: ["third"] }] },
      ],
    };

    expect(deploy.selectTargets(config, "canary").map((target) => target.stage)).toEqual(["canary"]);
    expect(deploy.selectTargets(config, "remaining").map((target) => target.stage)).toEqual([
      "remaining",
      "remaining",
    ]);
    expect(deploy.selectTargets(config, "all").map((target) => target.stage)).toEqual([
      "canary",
      "remaining",
      "remaining",
    ]);
  });

  it("redacts private command values from dry-run output", () => {
    const output = deploy.formatDryRunPlan({
      stage: "all",
      targets: [
        {
          stage: "canary",
          steps: [
            { command: "rsync", args: ["./", "private-host-one:/private/path"] },
            { command: "ssh", args: ["private-host-one", "restart-private-service"] },
          ],
        },
      ],
    });

    expect(output).toContain("stage: all");
    expect(output).toContain("target 1: canary, 2 step(s)");
    expect(output).toContain("step 1: rsync <redacted>");
    expect(output).not.toContain("private-host-one");
    expect(output).not.toContain("/private/path");
    expect(output).not.toContain("restart-private-service");
  });

  it("fails closed when deployment config is missing", async () => {
    await expect(
      deploy.loadDeploymentConfig({
        configPath: join(tmpdir(), "tmux-cc-missing-deploy-config.json"),
        env: {},
      }),
    ).rejects.toThrow("Deployment config not found");
  });
});
