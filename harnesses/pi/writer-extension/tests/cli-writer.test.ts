import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCliAnalyticsWriter } from "../src/cli-writer.ts";

const previousEnv = { ...process.env };
const tempRoots: string[] = [];

afterEach(() => {
  process.env = { ...previousEnv };

  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "token-tally-pi-writer-test-"));
  tempRoots.push(root);
  return root;
}

test("SEA binary is spawned with its containing directory as cwd", async () => {
  const root = makeTempRoot();
  const dataHome = join(root, "data-home");
  const seaDir = join(dataHome, "token-tally", "bin");
  const seaBinary = join(seaDir, "token-tally");
  const cwdFile = join(root, "child-cwd.ndjson");

  mkdirSync(seaDir, { recursive: true });
  writeFileSync(
    seaBinary,
    `#!/usr/bin/env node\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `const typeIndex = process.argv.indexOf("--type");\n` +
      `const recordType = typeIndex >= 0 ? process.argv[typeIndex + 1] : "unknown";\n` +
      `appendFileSync(process.env.TOKEN_TALLY_TEST_CWD_FILE, JSON.stringify({ cwd: process.cwd(), recordType }) + "\\n", "utf8");\n` +
      `process.stdout.write(JSON.stringify({ id: recordType + "-id-from-child" }));\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  chmodSync(seaBinary, 0o755);

  process.env.XDG_DATA_HOME = dataHome;
  process.env.TOKEN_TALLY_TEST_CWD_FILE = cwdFile;

  const writer = createCliAnalyticsWriter();
  const sessionResult = await writer.recordSession({
    harnessId: "pi",
    harnessSessionId: "session-1",
    startedAt: 1,
  });
  const turnResult = await writer.recordTurn({
    harnessId: "pi",
    sessionId: sessionResult.id,
    harnessTurnId: "turn-1",
    startedAt: 2,
  });
  const messageResult = await writer.recordLlmMessage({
    harnessId: "pi",
    sessionId: sessionResult.id,
    turnId: turnResult.id,
    harnessMessageId: "message-1",
    ts: 3,
  });

  assert.equal(sessionResult.id, "session-id-from-child");
  assert.equal(turnResult.id, "turn-id-from-child");
  assert.equal(messageResult.id, "llm-message-id-from-child");

  const records = readFileSync(cwdFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { cwd: string; recordType: string });
  assert.deepEqual(
    records.map((record) => record.recordType),
    ["session", "turn", "llm-message"],
  );
  assert.deepEqual(
    records.map((record) => record.cwd),
    [realpathSync(seaDir), realpathSync(seaDir), realpathSync(seaDir)],
  );
});
