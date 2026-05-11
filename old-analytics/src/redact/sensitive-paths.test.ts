/**
 * sensitive-paths.test.ts — Tests for DEFAULT_SENSITIVE_PATTERNS and pathIsSensitive.
 *
 * For each default pattern, we verify:
 *   1. It matches the canonical path it targets.
 *   2. It rejects similar-looking non-secret paths.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathIsSensitive, DEFAULT_SENSITIVE_PATTERNS } from "./sensitive-paths.ts";

// ---------------------------------------------------------------------------
// .env files
// ---------------------------------------------------------------------------

describe("sensitive-paths — .env", () => {
  it("matches .env", () => {
    assert(pathIsSensitive("/home/user/.env"));
    assert(pathIsSensitive(".env"));
  });

  it("matches .env.local", () => {
    assert(pathIsSensitive("/project/.env.local"));
  });

  it("matches .env.production", () => {
    assert(pathIsSensitive("/app/.env.production"));
  });

  it("does NOT match environment.ts", () => {
    assert(!pathIsSensitive("src/environment.ts"));
  });

  it("does NOT match dotenv.js", () => {
    assert(!pathIsSensitive("node_modules/dotenv/dotenv.js"));
  });

  it("does NOT match envconfig.json", () => {
    assert(!pathIsSensitive("envconfig.json"));
  });
});

// ---------------------------------------------------------------------------
// AWS credentials
// ---------------------------------------------------------------------------

describe("sensitive-paths — .aws", () => {
  it("matches ~/.aws/credentials", () => {
    assert(pathIsSensitive("/Users/alice/.aws/credentials"));
  });

  it("matches ~/.aws/config", () => {
    assert(pathIsSensitive("/home/bob/.aws/config"));
  });

  it("does NOT match /path/to/aws-sdk.js", () => {
    assert(!pathIsSensitive("/path/to/aws-sdk.js"));
  });
});

// ---------------------------------------------------------------------------
// SSH keys
// ---------------------------------------------------------------------------

describe("sensitive-paths — .ssh", () => {
  it("matches ~/.ssh/id_rsa", () => {
    assert(pathIsSensitive("/home/user/.ssh/id_rsa"));
  });

  it("matches ~/.ssh/known_hosts", () => {
    assert(pathIsSensitive("/home/user/.ssh/known_hosts"));
  });

  it("does NOT match /path/to/ssh-agent.js", () => {
    assert(!pathIsSensitive("/path/to/ssh-agent.js"));
  });
});

// ---------------------------------------------------------------------------
// kubeconfig
// ---------------------------------------------------------------------------

describe("sensitive-paths — .kube", () => {
  it("matches ~/.kube/config", () => {
    assert(pathIsSensitive("/home/user/.kube/config"));
  });

  it("does NOT match kubernetes-manifest.yaml", () => {
    assert(!pathIsSensitive("k8s/kubernetes-manifest.yaml"));
  });
});

// ---------------------------------------------------------------------------
// PEM files
// ---------------------------------------------------------------------------

describe("sensitive-paths — .pem", () => {
  it("matches certificate.pem", () => {
    assert(pathIsSensitive("/etc/ssl/certs/certificate.pem"));
  });

  it("matches private.pem", () => {
    assert(pathIsSensitive("private.pem"));
  });

  it("does NOT match template.html", () => {
    assert(!pathIsSensitive("templates/template.html"));
  });
});

// ---------------------------------------------------------------------------
// .key files
// ---------------------------------------------------------------------------

describe("sensitive-paths — .key", () => {
  it("matches server.key", () => {
    assert(pathIsSensitive("/etc/ssl/server.key"));
  });

  it("does NOT match monkey.keys.ts (has 'key' but not as extension)", () => {
    assert(!pathIsSensitive("src/monkey.keys.ts"));
  });

  it("does NOT match keyboard.ts", () => {
    assert(!pathIsSensitive("src/keyboard.ts"));
  });
});

// ---------------------------------------------------------------------------
// PKCS files
// ---------------------------------------------------------------------------

describe("sensitive-paths — .p12 / .pfx", () => {
  it("matches certificate.p12", () => {
    assert(pathIsSensitive("certs/certificate.p12"));
  });

  it("matches identity.pfx", () => {
    assert(pathIsSensitive("identity.pfx"));
  });

  it("does NOT match config.json", () => {
    assert(!pathIsSensitive("config.json"));
  });
});

// ---------------------------------------------------------------------------
// SSH private key filenames
// ---------------------------------------------------------------------------

describe("sensitive-paths — id_rsa / id_ed25519 etc.", () => {
  it("matches id_rsa", () => {
    assert(pathIsSensitive("/home/user/.ssh/id_rsa"));
  });

  it("matches id_ed25519", () => {
    assert(pathIsSensitive("/home/user/.ssh/id_ed25519"));
  });

  it("matches id_ecdsa", () => {
    assert(pathIsSensitive("id_ecdsa"));
  });

  it("matches id_dsa", () => {
    assert(pathIsSensitive("id_dsa"));
  });

  it("does NOT match identity.ts (starts with id but wrong format)", () => {
    assert(!pathIsSensitive("src/identity.ts"));
  });

  it("does NOT match suid_rsa (wrong prefix)", () => {
    assert(!pathIsSensitive("suid_rsa"));
  });
});

// ---------------------------------------------------------------------------
// credentials files
// ---------------------------------------------------------------------------

describe("sensitive-paths — credentials", () => {
  it("matches credentials.json", () => {
    assert(pathIsSensitive("/home/user/.config/credentials.json"));
  });

  it("matches credentials (no extension)", () => {
    assert(pathIsSensitive("/home/user/.aws/credentials"));
  });

  it("does NOT match accreditation.json (longer prefix)", () => {
    // "accreditation" ends with "credentials" — depends on regex anchoring
    // Our pattern: /credentials(\.json)?$/ — requires it to be at end, but
    // "accreditation.json" ends with "ation.json" not "credentials.json".
    assert(!pathIsSensitive("accreditation.json"));
  });
});

// ---------------------------------------------------------------------------
// Extra patterns parameter
// ---------------------------------------------------------------------------

describe("pathIsSensitive — extra patterns", () => {
  it("respects caller-supplied extra patterns", () => {
    const extra = [/my-secrets\//];
    assert(pathIsSensitive("/project/my-secrets/vault.json", extra));
    assert(!pathIsSensitive("/project/my-public/data.json", extra));
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SENSITIVE_PATTERNS array sanity
// ---------------------------------------------------------------------------

describe("DEFAULT_SENSITIVE_PATTERNS", () => {
  it("is a non-empty array of RegExp", () => {
    assert(Array.isArray(DEFAULT_SENSITIVE_PATTERNS));
    assert(DEFAULT_SENSITIVE_PATTERNS.length > 0);
    for (const p of DEFAULT_SENSITIVE_PATTERNS) {
      assert(p instanceof RegExp, `expected RegExp, got ${typeof p}`);
    }
  });
});
