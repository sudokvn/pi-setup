import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { persistSnapshot } from "./src/artifacts.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { SpawnTask } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import { EXECUTION_PROFILES } from "./src/profiles.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-recovery-test-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

// Both axes (legacy vs current profile name, native vs continuation) are
// covered without running the full matrix.
for (const [profile, mode] of [
  ["reviewer", "continuation"],
  ["review", "native"],
] as const) {
  test(`${profile} retains its recorded role and review scope on ${mode} recovery`, async () => {
    const captured: SpawnTask[] = [];
    const stub = makeStubBackend({
      backend: "claude",
      defaultModelLabel: "stub",
      contextWindow: 1000,
      toolName: "Read",
      cadenceMs: 1,
    });
    const registry = Layer.succeed(
      BackendRegistry,
      new Map([
        [
          "claude",
          {
            ...stub,
            spawn(task: SpawnTask) {
              captured.push(task);
              return stub.spawn(task);
            },
          },
        ],
      ]),
    );
    const createRuntime = () =>
      ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
    const parent = {
      parentCwd: process.cwd(),
      parentSessionId: `${profile}-${mode}`,
      projectTrusted: true,
    };
    const reviewTarget = { type: "commit", sha: "abcdef1234567" } as const;
    let runtime = createRuntime();
    try {
      let manager = await runtime.runPromise(SubagentManager);
      const snap = await runtime.runPromise(
        manager.spawn("claude", {
          prompt: "Original read-only contract. Assess correctness.",
          title: "review",
          cwd: process.cwd(),
          parent,
          reviewTarget,
          profile: "review",
          model: "stub",
        }),
      );
      await runtime.runPromise(manager.waitFor([snap.id]));
      const settled = manager.view.get(snap.id)!;
      assert.equal(settled.execution.attempts, undefined);
      await runtime.dispose();
      if (profile === "reviewer") {
        // Simulate an older on-disk run, not a newly selectable profile.
        persistSnapshot({
          ...settled,
          execution: {
            ...settled.execution,
            requested: { type: "profile", profile },
            attempts: [{ ...settled.execution.selected, outcome: "selected" }],
          },
        });
      }
      runtime = createRuntime();
      manager = await runtime.runPromise(SubagentManager);
      await runtime.runPromise(
        manager.restore(parent.parentSessionId, process.cwd()),
      );
      assert.deepEqual(manager.view.get(snap.id)?.execution.requested, {
        type: "profile",
        profile,
      });
      const recordedExecution = manager.view.get(snap.id)!.execution;
      await runtime.runPromise(
        manager.resume(snap.id, "Continue the review.", parent, mode),
      );
      assert.deepEqual(manager.view.get(snap.id)!.execution, recordedExecution);
      const resumed = captured.at(-1)!;
      assert.deepEqual(resumed.reviewTarget, reviewTarget);
      assert.match(resumed.prompt, /abcdef1234567/);
      assert.match(resumed.prompt, /Do not modify files/);
      if (mode === "continuation")
        assert.match(resumed.prompt, /Original read-only contract/);
      await runtime.runPromise(manager.waitFor([snap.id]));
    } finally {
      await runtime.dispose();
    }
  });
}

test("a recorded ui run keeps its Fable 5.1 contract after the profile moves to 5.2", async () => {
  const recorded = "proxy/claude-fable-5-1";
  assert.deepEqual(EXECUTION_PROFILES.ui.execution, {
    harness: "pi",
    model: "proxy/claude-fable-5-2",
    reasoningEffort: "high",
    runMode: "agent",
  });
  const captured: SpawnTask[] = [];
  const stub = makeStubBackend({
    backend: "pi",
    defaultModelLabel: "stub",
    contextWindow: 1000,
    toolName: "read",
    cadenceMs: 1,
  });
  const registry = Layer.succeed(
    BackendRegistry,
    new Map([
      [
        "pi",
        {
          ...stub,
          spawn(task: SpawnTask) {
            captured.push(task);
            return stub.spawn(task);
          },
        },
      ],
    ]),
  );
  const createRuntime = () =>
    ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
  const parent = {
    parentCwd: process.cwd(),
    parentSessionId: "ui-fable-migration",
    projectTrusted: true,
  };
  let runtime = createRuntime();
  try {
    let manager = await runtime.runPromise(SubagentManager);
    // A run started before the migration recorded the old profile pin.
    const snap = await runtime.runPromise(
      manager.spawn("pi", {
        prompt: "Polish the settings screen.",
        title: "ui",
        cwd: process.cwd(),
        parent,
        profile: "ui",
        model: recorded,
        reasoningEffort: "high",
      }),
    );
    await runtime.runPromise(manager.waitFor([snap.id]));
    await runtime.dispose();

    runtime = createRuntime();
    manager = await runtime.runPromise(SubagentManager);
    await runtime.runPromise(
      manager.restore(parent.parentSessionId, process.cwd()),
    );
    await runtime.runPromise(
      manager.resume(snap.id, "Continue.", parent, "continuation"),
    );
    const resumed = captured.at(-1)!;
    assert.equal(resumed.model, recorded);
    assert.equal(resumed.reasoningEffort, "high");
    assert.deepEqual(manager.view.get(snap.id)!.execution.selected, {
      harness: "pi",
      model: recorded,
      reasoningEffort: "high",
      runMode: "agent",
    });
    await runtime.runPromise(manager.waitFor([snap.id]));
  } finally {
    await runtime.dispose();
  }
});
