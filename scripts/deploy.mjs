#!/usr/bin/env node

import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_CONFIG_PATH = ".tmux-cc-deploy.json";
const CONFIG_PATH_ENV = "TMUX_CC_DEPLOY_CONFIG";
const CONFIG_JSON_ENV = "TMUX_CC_DEPLOY_CONFIG_JSON";
const DEPLOYMENT_STAGES = new Set(["canary", "remaining"]);
const REQUESTED_STAGES = new Set(["canary", "remaining", "all"]);

export async function loadDeploymentConfig(options = {}) {
  const env = options.env ?? process.env;
  const inlineJson = env[CONFIG_JSON_ENV];

  if (inlineJson) {
    return normalizeDeploymentConfig(parseJson(inlineJson));
  }

  const configPath = options.configPath ?? env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH;
  try {
    await access(configPath, constants.R_OK);
  } catch {
    throw new Error("Deployment config not found");
  }

  return normalizeDeploymentConfig(parseJson(await readFile(configPath, "utf8")));
}

export function selectTargets(config, stage) {
  assertRequestedStage(stage);

  if (stage === "all") {
    return [
      ...config.targets.filter((target) => target.stage === "canary"),
      ...config.targets.filter((target) => target.stage === "remaining"),
    ];
  }

  return config.targets.filter((target) => target.stage === stage);
}

export function formatDryRunPlan({ stage, targets }) {
  const lines = ["tmux-cc deployment dry run", `stage: ${stage}`, `targets: ${targets.length}`];

  targets.forEach((target, targetIndex) => {
    lines.push(`target ${targetIndex + 1}: ${target.stage}, ${target.steps.length} step(s)`);
    target.steps.forEach((step, stepIndex) => {
      lines.push(`  step ${stepIndex + 1}: ${step.command} <redacted>`);
    });
  });

  return `${lines.join("\n")}\n`;
}

export async function runDeployment(options = {}) {
  const stage = options.stage ?? "canary";
  const config = await loadDeploymentConfig(options);
  const targets = selectTargets(config, stage);

  if (targets.length === 0) {
    throw new Error(`No deployment targets configured for stage "${stage}"`);
  }

  if (options.dryRun) {
    return formatDryRunPlan({ stage, targets });
  }

  const runner = options.runner ?? runStep;
  for (const target of targets) {
    for (const step of target.steps) {
      await runner(step);
    }
  }

  return `deployment stage "${stage}" completed\n`;
}

export function parseArgs(argv) {
  const options = { stage: "canary", dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage") {
      options.stage = readFlagValue(argv, ++i, "--stage");
    } else if (arg === "--config") {
      options.configPath = readFlagValue(argv, ++i, "--config");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help) assertRequestedStage(options.stage);
  return options;
}

async function runStep(step) {
  await new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { shell: false, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Deployment step failed with exit code ${code}`));
      }
    });
  });
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Deployment config is invalid JSON");
  }
}

function normalizeDeploymentConfig(value) {
  if (!isRecord(value) || !Array.isArray(value.targets)) {
    throw new Error("Deployment config must contain a targets array");
  }

  const targets = value.targets.map((target, targetIndex) => normalizeTarget(target, targetIndex));
  if (!targets.some((target) => target.stage === "canary")) {
    throw new Error("Deployment config must include a canary target");
  }

  return { targets };
}

function normalizeTarget(target, targetIndex) {
  if (!isRecord(target)) {
    throw new Error(`Deployment target ${targetIndex + 1} must be an object`);
  }
  if (!DEPLOYMENT_STAGES.has(target.stage)) {
    throw new Error(`Deployment target ${targetIndex + 1} must use stage "canary" or "remaining"`);
  }
  if (!Array.isArray(target.steps) || target.steps.length === 0) {
    throw new Error(`Deployment target ${targetIndex + 1} must contain at least one step`);
  }

  return {
    stage: target.stage,
    steps: target.steps.map((step, stepIndex) => normalizeStep(step, targetIndex, stepIndex)),
  };
}

function normalizeStep(step, targetIndex, stepIndex) {
  if (!isRecord(step)) {
    throw new Error(`Deployment step ${targetIndex + 1}.${stepIndex + 1} must be an object`);
  }
  if (!isSafeCommandName(step.command)) {
    throw new Error(`Deployment step ${targetIndex + 1}.${stepIndex + 1} must use a command name from PATH`);
  }
  if (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string"))) {
    throw new Error(`Deployment step ${targetIndex + 1}.${stepIndex + 1} args must be strings`);
  }

  return {
    command: step.command,
    args: step.args ?? [],
  };
}

function isSafeCommandName(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value);
}

function assertRequestedStage(stage) {
  if (!REQUESTED_STAGES.has(stage)) {
    throw new Error('Deployment stage must be "canary", "remaining", or "all"');
  }
}

function readFlagValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function usage() {
  return `Usage: npm run deploy -- --stage <canary|remaining|all> [--config <path>] [--dry-run]

Configuration is read from ${CONFIG_JSON_ENV}, ${CONFIG_PATH_ENV}, or ${DEFAULT_CONFIG_PATH}.
Dry-run output redacts target values and command arguments.
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      process.stdout.write(await runDeployment(options));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
