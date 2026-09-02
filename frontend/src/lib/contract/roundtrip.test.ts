import { describe, expect, it } from "vitest";
import {
  CLIENT_FRAME_TYPES,
  ClientWireNames,
  DURABLE_NOTICE_KIND,
  ERROR_CODE,
  FrameKindToWireName,
  SERVER_FRAME_TYPES,
  parseClientFrame,
  parseServerFrame,
} from "./types_gen";

// Same fixtures the Go roundtrip test consumes (internal/wscontract/
// roundtrip_test.go reads ../../contract/fixtures) — proving both language
// surfaces come from the one schema source. Glob is resolved by Vite/vitest
// relative to this file; no node builtins needed.
const fixtureModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../../../../contract/fixtures/*.json",
  { eager: true },
);

interface Fixture {
  name: string;
  data: Record<string, unknown>;
}

const fixtures: Fixture[] = Object.entries(fixtureModules)
  .map(([path, mod]) => ({
    name: path.split("/").pop() ?? path,
    data: mod.default,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const typeOf = (f: Fixture): unknown => f.data["type"];
const isUnknownFixture = (f: Fixture) => f.name.includes("unknown");

describe("server frame fixtures roundtrip against generated types", () => {
  it("every non-unknown server fixture decodes into its generated type, field-identical", () => {
    const relevant = fixtures.filter(
      (f) => f.name.startsWith("server-") || (f.name.startsWith("tolerant-") && !isUnknownFixture(f)),
    );
    expect(relevant.length).toBeGreaterThan(20);
    for (const f of relevant) {
      const type = typeOf(f);
      expect(typeof type, f.name).toBe("string");
      expect(SERVER_FRAME_TYPES, f.name).toContain(type);
      const frame = parseServerFrame(f.data);
      expect(frame, f.name).not.toBeNull();
      expect(frame, f.name).toEqual(f.data);
    }
  });

  it("client fixtures decode into the generated client union, field-identical", () => {
    const relevant = fixtures.filter((f) => f.name.startsWith("client-"));
    expect(relevant.length).toBeGreaterThanOrEqual(15);
    for (const f of relevant) {
      expect(CLIENT_FRAME_TYPES, f.name).toContain(typeOf(f));
      const frame = parseClientFrame(f.data);
      expect(frame, f.name).not.toBeNull();
      expect(frame, f.name).toEqual(f.data);
    }
  });

  it("unknown type values are representable as UnknownFrame (R1)", () => {
    const unknowns = fixtures.filter(isUnknownFixture);
    expect(unknowns.length).toBeGreaterThanOrEqual(1);
    for (const f of unknowns) {
      const type = typeOf(f);
      expect(typeof type).toBe("string");
      expect(SERVER_FRAME_TYPES).not.toContain(type);
      expect(CLIENT_FRAME_TYPES).not.toContain(type);
      const passthrough = parseServerFrame(f.data);
      expect(passthrough?.type).toBe(type);
      expect(passthrough).toEqual(f.data);
    }
  });

  it("rejects malformed required properties and enum values", () => {
    const missing = fixtures.find((f) => f.name === "invalid-server-hello-missing-required.json");
    const badEnum = fixtures.find((f) => f.name === "invalid-client-run-kind.json");
    expect(missing).toBeDefined();
    expect(badEnum).toBeDefined();
    expect(parseServerFrame(missing?.data)).toBeNull();
    expect(parseClientFrame(badEnum?.data)).toBeNull();
  });

  it("validates RFC3339Nano exactly rather than using Date.parse leniency", () => {
    const base = { type: "notice", sessionId: "s1", kind: "k" };
    expect(parseServerFrame({ ...base, at: "2026-01-02T03:04:05.123456789Z" })).not.toBeNull();
    for (const at of ["2026-02-29T03:04:05Z", "2026-01-02 03:04:05Z", "2026-01-02T03:04:05.1234567890Z"]) {
      expect(parseServerFrame({ ...base, at })).toBeNull();
    }
  });

  it("distinguishes nullable and optional wire shapes", () => {
    for (const name of [
      "server-ready-null.json",
      "tolerant-state-model-absent.json",
      "tolerant-state-model-null.json",
      "tolerant-approval-empty-options.json",
    ]) {
      const fixture = fixtures.find((f) => f.name === name);
      expect(fixture, name).toBeDefined();
      expect(parseServerFrame(fixture?.data), name).toEqual(fixture?.data);
    }
  });
});

describe("contract requirements pinned by fixtures", () => {
  it("entries.final is required on every entries frame (invariant 18)", () => {
    const entries = fixtures.filter((f) => typeOf(f) === "entries");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const f of entries) {
      expect(f.data, f.name).toHaveProperty("final");
      expect(typeof f.data["final"], f.name).toBe("boolean");
    }
  });

  it("error frames use the closed code enum and carry candidates on resume_failed (invariant 7)", () => {
    const errors = fixtures.filter((f) => typeOf(f) === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const f of errors) {
      if (f.data["code"] !== undefined) {
        expect(ERROR_CODE, f.name).toContain(f.data["code"]);
      }
      expect(typeof f.data["message"], f.name).toBe("string");
      if (f.data["code"] === "resume_failed") {
        expect(f.data, f.name).toHaveProperty("dangling");
        expect(Array.isArray(f.data["candidates"]), f.name).toBe(true);
      }
    }
  });

  it("notice.at is RFC3339Nano and the fixture kind is one of the durable six (invariant 14)", () => {
    const rfc3339Nano = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    const notices = fixtures.filter((f) => typeOf(f) === "notice");
    expect(notices.length).toBeGreaterThanOrEqual(1);
    for (const f of notices) {
      expect(typeof f.data["at"], f.name).toBe("string");
      expect(rfc3339Nano.test(f.data["at"] as string), f.name).toBe(true);
      expect(DURABLE_NOTICE_KIND, f.name).toContain(f.data["kind"]);
    }
  });

  it("hello carries the version envelope", () => {
    const hello = fixtures.find((f) => f.name === "server-hello.json");
    expect(hello).toBeDefined();
    expect(hello?.data["version"]).toBeTypeOf("number");
    expect(hello?.data["serverVersion"]).toBeTypeOf("string");
  });
});

describe("wire-name mapping (bridge-owned, v1 continuity)", () => {
  it("maps all 20 v2 FrameKinds onto known server wire types", () => {
    expect(Object.keys(FrameKindToWireName).length).toBe(20);
    expect(FrameKindToWireName["message.delta"]).toBe("messageDelta");
    expect(FrameKindToWireName["name"]).toBe("chat.name");
    for (const wire of Object.values(FrameKindToWireName)) {
      expect(SERVER_FRAME_TYPES).toContain(wire);
    }
  });

  it("client wire names are identity and inside the closed client union", () => {
    for (const [kind, wire] of Object.entries(ClientWireNames)) {
      expect(wire).toBe(kind);
      expect(CLIENT_FRAME_TYPES).toContain(wire);
    }
  });
});
