#!/usr/bin/env node
// Generates frontend/src/lib/contract/types_gen.ts from the JSON Schemas.
// Implemented subset: object properties/required fields, scalar/array types,
// string enum/const, local or cross-file $ref, nullable anyOf, opaque JSON,
// and the top-level frame oneOf. Every other construct fails generation.
// Run: node contract/gen_ts.mjs. Output is committed; no runtime codegen.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemasDir = process.env.OMO_CONTRACT_SCHEMAS || join(here, "schemas");
const outPath = process.env.OMO_CONTRACT_TS_OUT || join(here, "..", "frontend", "src", "lib", "contract", "types_gen.ts");

const files = new Map();
async function load(fileID) {
  if (!files.has(fileID)) {
    const parsed = JSON.parse(await readFile(join(schemasDir, fileID), "utf8"));
    validateSchemaDocument(fileID, parsed);
    files.set(fileID, parsed);
  }
  return files.get(fileID);
}

const SCHEMA_KEYWORDS = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type",
  "properties", "required", "items", "enum", "const", "anyOf", "oneOf",
  "additionalProperties", "format",
]);
const SCHEMA_TYPES = new Set(["null", "boolean", "string", "integer", "number", "array", "object"]);

// Fail closed on schema vocabulary the generator does not implement. In
// particular, a misspelled type or semantic keyword must never become JsonValue.
function validateSchemaDocument(fileID, root) {
  const walk = (node, path) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`${fileID}${path}: schema node must be an object`);
    for (const key of Object.keys(node)) if (!SCHEMA_KEYWORDS.has(key)) throw new Error(`${fileID}${path}: unsupported schema keyword ${JSON.stringify(key)}`);
    if ("type" in node && (!SCHEMA_TYPES.has(node.type))) throw new Error(`${fileID}${path}: invalid schema type ${JSON.stringify(node.type)}`);
    if ("format" in node && (node.format !== "rfc3339nano" || node.type !== "string")) throw new Error(`${fileID}${path}: unsupported format ${JSON.stringify(node.format)}`);
    if ("properties" in node) {
      if (!node.properties || typeof node.properties !== "object" || Array.isArray(node.properties)) throw new Error(`${fileID}${path}/properties: must be an object`);
      for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}/properties/${name}`);
    }
    if ("$defs" in node) {
      if (!node.$defs || typeof node.$defs !== "object" || Array.isArray(node.$defs)) throw new Error(`${fileID}${path}/$defs: must be an object`);
      for (const [name, child] of Object.entries(node.$defs)) walk(child, `${path}/$defs/${name}`);
    }
    for (const keyword of ["anyOf", "oneOf"]) if (keyword in node) {
      if (!Array.isArray(node[keyword]) || node[keyword].length === 0) throw new Error(`${fileID}${path}/${keyword}: must be a non-empty array`);
      if (keyword === "oneOf" && !(path === "" && (fileID === "server-frames.json" || fileID === "client-frames.json"))) throw new Error(`${fileID}${path}: unsupported schema construct oneOf`);
      if (keyword === "anyOf") {
        const nulls = node.anyOf.filter((branch) => branch?.type === "null").length;
        if (node.anyOf.length !== 2 || nulls !== 1) throw new Error(`${fileID}${path}: unsupported schema construct anyOf (only nullable values are implemented)`);
      }
      node[keyword].forEach((child, i) => walk(child, `${path}/${keyword}/${i}`));
    }
    if ("items" in node) walk(node.items, `${path}/items`);
    if ("additionalProperties" in node && typeof node.additionalProperties !== "boolean") walk(node.additionalProperties, `${path}/additionalProperties`);
    if ("required" in node) {
      if (!Array.isArray(node.required)) throw new Error(`${fileID}${path}/required: must be an array`);
      for (const name of node.required) if (typeof name !== "string" || !(name in (node.properties ?? {}))) throw new Error(`${fileID}${path}/required: invalid property ${JSON.stringify(name)}`);
    }
    if ("enum" in node && (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.some((v) => typeof v !== "string"))) throw new Error(`${fileID}${path}/enum: only a non-empty string enum is supported`);
    if ("const" in node && typeof node.const !== "string") throw new Error(`${fileID}${path}/const: only string constants are supported`);
    if ("$ref" in node && (typeof node.$ref !== "string" || node.$ref === "")) throw new Error(`${fileID}${path}/$ref: must be a non-empty string`);
  };
  walk(root, "");
}

function defName(ref) {
  const i = ref.lastIndexOf("/");
  return ref.slice(i + 1);
}

function resolveRef(ref, ctxFile) {
  let fileID = ctxFile;
  let rest = ref;
  const i = ref.indexOf("#");
  if (i >= 0) {
    if (ref.slice(0, i) !== "") fileID = ref.slice(0, i);
    rest = ref.slice(i + 1);
  }
  let node = doc(fileID);
  for (const part of rest.split("/").filter(Boolean)) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !(part in node)) throw new Error(`bad ref ${JSON.stringify(ref)} in ${ctxFile}`);
    node = node[part];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`bad ref ${JSON.stringify(ref)} in ${ctxFile}`);
  return node;
}

function doc(fileID) {
  // sync wrapper over the preloaded cache
  if (!files.has(fileID)) throw new Error(`schema ${fileID} not preloaded`);
  return files.get(fileID);
}

const OPAQUE_KEYS = ["type", "properties", "items", "enum", "const", "anyOf", "$ref"];
function isOpaque(node) {
  return !OPAQUE_KEYS.some((k) => k in node);
}

// tsType maps a schema node to a TypeScript type expression.
function tsType(node, ctxFile) {
  if ("$ref" in node) {
    if (isOpaque(resolveRef(node.$ref, ctxFile))) return "JsonValue";
    return defName(node.$ref);
  }
  if ("anyOf" in node) {
    const nonNull = node.anyOf.filter((b) => b?.type !== "null");
    if (nonNull.length === 1) return `${tsType(nonNull[0], ctxFile)} | null`;
    return "JsonValue";
  }
  if ("const" in node) return JSON.stringify(node.const);
  if ("enum" in node) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  switch (node.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `readonly ${tsType(node.items ?? {}, ctxFile)}[]`;
    case "object":
      return tsObjectLiteral(node, ctxFile);
    default:
      return "JsonValue";
  }
}

function tsObjectLiteral(node, ctxFile) {
  const required = new Set(node.required ?? []);
  const props = node.properties ?? {};
  const lines = Object.keys(props).map((key) => {
    const pn = props[key];
    const opt = required.has(key) ? "" : "?";
    const desc = pn.description ? `  /** ${pn.description} */\n` : "";
    return `${desc}  readonly ${key}${opt}: ${tsType(pn, ctxFile)};`;
  });
  return `{\n${lines.join("\n")}\n}`;
}

function validationSchema(node, ctxFile) {
  if (node.$ref) return validationSchema(resolveRef(node.$ref, ctxFile), node.$ref.includes("#") && node.$ref.split("#")[0] ? node.$ref.split("#")[0] : ctxFile);
  if (isOpaque(node)) return { json: true };
  const out = {};
  for (const key of ["type", "const", "enum", "required", "format"]) if (key in node) out[key] = node[key];
  if (node.anyOf) out.anyOf = node.anyOf.map((child) => validationSchema(child, ctxFile));
  if (node.properties) out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, validationSchema(child, ctxFile)]));
  if (node.items) out.items = validationSchema(node.items, ctxFile);
  return out;
}

function unionDefs(fileID) {
  const d = doc(fileID);
  return d.oneOf.map((item) => {
    const ref = item.$ref;
    const name = defName(ref);
    const def = resolveRef(ref, fileID);
    return { name, wireConst: def.properties.type.const, validation: validationSchema(def, ref.includes("#") && ref.split("#")[0] ? ref.split("#")[0] : fileID) };
  });
}

async function main() {
  for (const f of ["shared-types.json", "hello.json", "server-frames.json", "client-frames.json", "error-codes.json", "notice-kinds.json", "wire-names.json"]) {
    await load(f);
  }
  const checkRefs = (node, fileID) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (typeof node.$ref === "string") resolveRef(node.$ref, fileID);
    for (const children of [node.properties, node.$defs]) if (children) Object.values(children).forEach((child) => checkRefs(child, fileID));
    for (const children of [node.anyOf, node.oneOf]) if (children) children.forEach((child) => checkRefs(child, fileID));
    if (node.items) checkRefs(node.items, fileID);
    if (node.additionalProperties && typeof node.additionalProperties !== "boolean") checkRefs(node.additionalProperties, fileID);
  };
  for (const [fileID, root] of files) checkRefs(root, fileID);

  const b = [];
  b.push("// Code generated by contract/gen_ts.mjs from contract/schemas; DO NOT EDIT.");
  b.push("//");
  b.push("// Single-source WS contract for v2 (same source as internal/wscontract/types_gen.go).");
  b.push("// Regenerate both mirrors with: go generate ./contract (requires Node.js).");
  b.push("");
  b.push("export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };");
  b.push("export type JsonObject = { readonly [key: string]: JsonValue };");
  b.push("");

  // Object defs -> interfaces; enum defs -> literal unions + const arrays.
  for (const fileID of ["shared-types.json", "hello.json", "error-codes.json", "notice-kinds.json", "server-frames.json", "client-frames.json"]) {
    const defs = doc(fileID).$defs ?? {};
    for (const name of Object.keys(defs).sort()) {
      const def = defs[name];
      if ("enum" in def) {
        b.push(`export type ${name} = ${def.enum.map((v) => JSON.stringify(v)).join(" | ")};`);
        b.push(`export const ${snakeUpper(name)}: readonly ${name}[] = [${def.enum.map((v) => JSON.stringify(v)).join(", ")}] as const;`);
        b.push("");
      } else if (def.type === "object" && !isOpaque(def)) {
        if (def.description) b.push(`/** ${def.description} */`);
        const required = new Set(def.required ?? []);
        const props = def.properties ?? {};
        b.push(`export interface ${name} {`);
        for (const key of Object.keys(props).sort()) {
          const pn = props[key];
          if (pn.description) b.push(`  /** ${pn.description} */`);
          const opt = required.has(key) ? "" : "?";
          b.push(`  readonly ${key}${opt}: ${tsType(pn, fileID)};`);
        }
        b.push("}");
        b.push("");
      }
    }
  }

  // Unions with an UnknownFrame passthrough (forward compatibility, R1).
  const server = unionDefs("server-frames.json");
  const client = unionDefs("client-frames.json");
  b.push("/** Any frame whose type is outside the closed union (dropped by the parser, never a parse failure). */");
  b.push("export interface UnknownFrame {");
  b.push("  readonly type: string;");
  b.push("  readonly [key: string]: unknown;");
  b.push("}");
  b.push("");
  b.push("export type ChatServerFrame =");
  b.push(server.map((d) => `  | ${d.name}`).join("\n"));
  b.push("  | UnknownFrame;");
  b.push("");
  b.push("export type ChatClientFrame =");
  b.push(client.map((d) => `  | ${d.name}`).join("\n"));
  b.push("  | UnknownFrame;");
  b.push("");

  b.push(`export const SERVER_FRAME_TYPES: readonly string[] = [${server.map((d) => JSON.stringify(d.wireConst)).join(", ")}] as const;`);
  b.push(`export const CLIENT_FRAME_TYPES: readonly string[] = [${client.map((d) => JSON.stringify(d.wireConst)).join(", ")}] as const;`);
  b.push("");
  b.push("/** Wire type of a decoded frame, or null when the payload is not an object. */");
  b.push("export function frameTypeOf(raw: unknown): string | null {");
  b.push("  if (typeof raw !== \"object\" || raw === null || Array.isArray(raw)) return null;");
  b.push("  const t = (raw as { type?: unknown }).type;");
  b.push("  return typeof t === \"string\" ? t : null;");
  b.push("}");
  b.push("");
  b.push("type ValidationSchema = { readonly json?: true; readonly type?: string; readonly const?: string; readonly enum?: readonly string[]; readonly required?: readonly string[]; readonly format?: string; readonly anyOf?: readonly ValidationSchema[]; readonly properties?: Readonly<Record<string, ValidationSchema>>; readonly items?: ValidationSchema };");
  b.push(`const SERVER_SCHEMAS: Readonly<Record<string, ValidationSchema>> = ${JSON.stringify(Object.fromEntries(server.map((d) => [d.wireConst, d.validation])))};`);
  b.push(`const CLIENT_SCHEMAS: Readonly<Record<string, ValidationSchema>> = ${JSON.stringify(Object.fromEntries(client.map((d) => [d.wireConst, d.validation])))};`);
  b.push("function isJsonValue(value: unknown): boolean {");
  b.push("  if (value === null || typeof value === \"string\" || typeof value === \"boolean\") return true;");
  b.push("  if (typeof value === \"number\") return Number.isFinite(value);");
  b.push("  if (Array.isArray(value)) return value.every(isJsonValue);");
  b.push("  if (typeof value !== \"object\") return false;");
  b.push("  return Object.values(value as Record<string, unknown>).every(isJsonValue);");
  b.push("}");
  b.push("function isRFC3339Nano(value: string): boolean {");
  b.push("  const match = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:[.,]\\d{1,9})?(?:Z|([+-])(\\d{2}):(\\d{2}))$/.exec(value);");
  b.push("  if (!match) return false;");
  b.push("  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);");
  b.push("  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);");
  b.push("  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);");
  b.push("  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];");
  b.push("  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]! || hour > 23 || minute > 59 || second > 59) return false;");
  b.push("  return match[8] === undefined || (Number(match[8]) <= 24 && Number(match[9]) <= 60);");
  b.push("}");
  b.push("function validates(value: unknown, spec: ValidationSchema): boolean {");
  b.push("  if (spec.anyOf) return spec.anyOf.some((branch) => validates(value, branch));");
  b.push("  if (spec.json) return isJsonValue(value);");
  b.push("  if (spec.const !== undefined && value !== spec.const) return false;");
  b.push("  if (spec.enum && (typeof value !== \"string\" || !spec.enum.includes(value))) return false;");
  b.push("  switch (spec.type) {");
  b.push("    case \"null\": return value === null;");
  b.push("    case \"string\": return typeof value === \"string\" && (spec.format !== \"rfc3339nano\" || isRFC3339Nano(value));");
  b.push("    case \"boolean\": return typeof value === \"boolean\";");
  b.push("    case \"number\": return typeof value === \"number\" && Number.isFinite(value);");
  b.push("    case \"integer\": return typeof value === \"number\" && Number.isInteger(value);");
  b.push("    case \"array\": return Array.isArray(value) && (!spec.items || value.every((item) => validates(item, spec.items!)));");
  b.push("    case \"object\": {");
  b.push("      if (typeof value !== \"object\" || value === null || Array.isArray(value)) return false;");
  b.push("      const object = value as Record<string, unknown>;");
  b.push("      if (spec.required?.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) return false;");
  b.push("      return Object.entries(spec.properties ?? {}).every(([key, child]) => !Object.prototype.hasOwnProperty.call(object, key) || validates(object[key], child));");
  b.push("    }");
  b.push("    default: return true;");
  b.push("  }");
  b.push("}");
  b.push("/** Strictly validates known server frames; unknown string types pass through unchanged. */");
  b.push("export function parseServerFrame(raw: unknown): ChatServerFrame | null {");
  b.push("  const type = frameTypeOf(raw); if (type === null) return null;");
  b.push("  const spec = SERVER_SCHEMAS[type];");
  b.push("  return spec && !validates(raw, spec) ? null : raw as ChatServerFrame;");
  b.push("}");
  b.push("/** Strictly validates known client frames; unknown string types pass through unchanged. */");
  b.push("export function parseClientFrame(raw: unknown): ChatClientFrame | null {");
  b.push("  const type = frameTypeOf(raw); if (type === null) return null;");
  b.push("  const spec = CLIENT_SCHEMAS[type];");
  b.push("  return spec && !validates(raw, spec) ? null : raw as ChatClientFrame;");
  b.push("}");
  b.push("");

  // Wire-name mapping (v2 FrameKind -> wire type), from wire-names.json.
  const wn = resolveRef("#/$defs/WireNames", "wire-names.json");
  const serverMap = wn.properties.server.properties;
  const clientMap = wn.properties.client.properties;
  b.push("/** v2 session FrameKind -> wire type emitted on the socket (owned by the bridge). */");
  b.push("export const FrameKindToWireName: Readonly<Record<string, string>> = Object.freeze({");
  for (const k of Object.keys(serverMap).sort()) b.push(`  ${JSON.stringify(k)}: ${JSON.stringify(serverMap[k].const)},`);
  b.push("});");
  b.push("");
  b.push("/** Client command names (identity mapping; v1 continuity). */");
  b.push("export const ClientWireNames: Readonly<Record<string, string>> = Object.freeze({");
  for (const k of Object.keys(clientMap).sort()) b.push(`  ${JSON.stringify(k)}: ${JSON.stringify(clientMap[k].const)},`);
  b.push("});");
  b.push("");

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, b.join("\n"), "utf8");
  console.log(`gen_ts: wrote ${outPath}`);
}

function snakeUpper(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

main().catch((err) => {
  console.error("gen_ts:", err);
  process.exit(1);
});
