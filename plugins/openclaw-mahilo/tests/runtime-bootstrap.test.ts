import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MahiloRuntimeBootstrapStore } from "../src";

function createTempStore(): {
  cleanup: () => void;
  store: MahiloRuntimeBootstrapStore;
} {
  const directory = mkdtempSync(join(tmpdir(), "mahilo-runtime-bootstrap-"));
  const path = join(directory, "runtime-store.json");

  return {
    cleanup: () => {
      rmSync(directory, {
        force: true,
        recursive: true
      });
    },
    store: new MahiloRuntimeBootstrapStore({
      path
    })
  };
}

describe("MahiloRuntimeBootstrapStore", () => {
  it("stores bootstrap state per Mahilo base URL", () => {
    const runtime = createTempStore();

    try {
      runtime.store.write("https://mahilo.example", {
        apiKey: "mhl_primary",
        username: "primary-user"
      });
      runtime.store.write("https://mahilo-alt.example", {
        apiKey: "mhl_secondary",
        username: "secondary-user"
      });

      expect(runtime.store.read("https://mahilo.example")).toMatchObject({
        apiKey: "mhl_primary",
        username: "primary-user"
      });
      expect(runtime.store.read("https://mahilo-alt.example")).toMatchObject({
        apiKey: "mhl_secondary",
        username: "secondary-user"
      });
    } finally {
      runtime.cleanup();
    }
  });

  it("preserves stored callback secrets across partial updates", () => {
    const runtime = createTempStore();

    try {
      runtime.store.write("https://mahilo.example", {
        callbackConnectionId: "conn_default",
        callbackSecret: "callback-secret",
        callbackUrl: "https://openclaw.example/mahilo/incoming"
      });
      runtime.store.write("https://mahilo.example", {
        callbackConnectionId: "conn_default",
        callbackUrl: "https://openclaw.example/mahilo/incoming"
      });

      expect(runtime.store.read("https://mahilo.example")).toMatchObject({
        callbackConnectionId: "conn_default",
        callbackSecret: "callback-secret",
        callbackUrl: "https://openclaw.example/mahilo/incoming"
      });
    } finally {
      runtime.cleanup();
    }
  });
});
