// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  _setNonInteractiveForTest,
  _setPromptForTest,
  buildSandboxConfigSyncScript,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  promptOrDefault,
  writeSandboxConfigSyncFile,
} = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that only writes nemoclaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    // Writes NemoClaw selection config to writable ~/.nemoclaw/
    expect(script).toMatch(/cat > ~\/\.nemoclaw\/config\.json/);
    expect(script).toMatch(/"model": "nemotron-3-nano:30b"/);
    expect(script).toMatch(/"credentialEnv": "OPENAI_API_KEY"/);

    // Must NOT modify openclaw config from inside the sandbox — model routing
    // is handled by the host-side gateway (openshell inference set)
    expect(script).not.toMatch(/openclaw\.json/);
    expect(script).not.toMatch(/openclaw models set/);

    expect(script).toMatch(/^exit$/m);
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.12");
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.13");
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });

  it("writes sandbox sync scripts to a temp file for stdin redirection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-test-"));
    try {
      const scriptFile = writeSandboxConfigSyncFile("echo test", tmpDir, 1234);
      expect(scriptFile).toBe(path.join(tmpDir, "nemoclaw-sync-1234.sh"));
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// Non-interactive branch: exercises env-var / default fallback logic.
describe("promptOrDefault (non-interactive)", () => {
  let savedTestPromptCustom;

  beforeAll(() => {
    savedTestPromptCustom = process.env.TEST_PROMPT_CUSTOM;
    _setNonInteractiveForTest(true);
  });

  afterAll(() => {
    _setNonInteractiveForTest(false);
    if (savedTestPromptCustom === undefined) {
      delete process.env.TEST_PROMPT_CUSTOM;
    } else {
      process.env.TEST_PROMPT_CUSTOM = savedTestPromptCustom;
    }
  });

  it("returns custom value from env var", async () => {
    process.env.TEST_PROMPT_CUSTOM = "my-sandbox";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toBe("my-sandbox");
  });

  it("falls back to defaultValue when env var is unset", async () => {
    delete process.env.TEST_PROMPT_CUSTOM;
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toBe("my-assistant");
  });

  it("falls back to defaultValue when env var is empty", async () => {
    process.env.TEST_PROMPT_CUSTOM = "";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toBe("my-assistant");
  });

  it("falls back to defaultValue when envVar param is null", async () => {
    const result = await promptOrDefault("Name: ", null, "fallback-name");
    expect(result).toBe("fallback-name");
  });

  it("preserves valid custom name with hyphens", async () => {
    process.env.TEST_PROMPT_CUSTOM = "dev-sandbox-1";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toBe("dev-sandbox-1");
  });

  it("returned value passes RFC 1123 validation when using default", async () => {
    delete process.env.TEST_PROMPT_CUSTOM;
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("returned value passes RFC 1123 validation with custom name", async () => {
    process.env.TEST_PROMPT_CUSTOM = "test-sandbox-42";
    const result = await promptOrDefault("Name: ", "TEST_PROMPT_CUSTOM", "my-assistant");
    expect(result).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

// Interactive branch: uses an injected prompt function to simulate user input.
describe("promptOrDefault (interactive)", () => {
  beforeAll(() => {
    _setNonInteractiveForTest(false);
  });

  afterAll(() => {
    _setPromptForTest(null);
    _setNonInteractiveForTest(false);
  });

  it("falls back to defaultValue when user presses Enter (empty input)", async () => {
    _setPromptForTest(() => "");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    expect(result).toBe("my-assistant");
  });

  it("falls back to defaultValue when user enters only whitespace", async () => {
    _setPromptForTest(() => "   ");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    expect(result).toBe("my-assistant");
  });

  it("returns trimmed custom value when user enters padded input", async () => {
    _setPromptForTest(() => "  custom  ");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    expect(result).toBe("custom");
  });

  it("returns user input as-is when already trimmed", async () => {
    _setPromptForTest(() => "dev-box");
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    expect(result).toBe("dev-box");
  });

  it("falls back to defaultValue when prompt returns null", async () => {
    _setPromptForTest(() => null);
    const result = await promptOrDefault("Name: ", "UNUSED", "my-assistant");
    expect(result).toBe("my-assistant");
  });
});
