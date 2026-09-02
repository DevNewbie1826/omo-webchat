//go:generate go run gen_go.go
//go:generate node gen_ts.mjs

// Command gen_go.go regenerates internal/wscontract/types_gen.go from the JSON
// Schemas in contract/schemas/. `go generate ./contract` runs both this Go
// generator and gen_ts.mjs (Node.js is therefore required) and writes the
// committed Go and TypeScript mirrors; there is no runtime codegen.
package main

import (
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type schema map[string]any

func main() {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		fatal("cannot locate gen_go.go source path")
	}
	dir := filepath.Dir(thisFile)
	g := newGen(filepath.Join(dir, "schemas"))
	g.generate(filepath.Join(dir, "..", "internal", "wscontract", "types_gen.go"))
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "gen_go: "+format+"\n", args...)
	os.Exit(1)
}

// ---------------------------------------------------------------- schema load

type gen struct {
	schemasDir string
	files      map[string]schema // file id ("server-frames.json") -> parsed doc
	structs    []*structDef      // accumulated named structs, render order
	structIdx  map[string]bool
}

type structDef struct {
	Name   string
	Doc    string
	Fields []fieldDef
	Marker string // interface marker method receiver comment, "" for shared types
}

type fieldDef struct {
	GoName       string
	JSONName     string
	Type         string
	Pointer      bool
	OmitEmpty    bool
	PreserveMode string // "nullable" or "array" when omission must round-trip
	Doc          string
}

func newGen(schemasDir string) *gen {
	return &gen{schemasDir: schemasDir, files: map[string]schema{}, structIdx: map[string]bool{}}
}

func (g *gen) load(fileID string) schema {
	if doc, ok := g.files[fileID]; ok {
		return doc
	}
	raw, err := os.ReadFile(filepath.Join(g.schemasDir, fileID))
	if err != nil {
		fatal("read %s: %v", fileID, err)
	}
	var doc schema
	if err := json.Unmarshal(raw, &doc); err != nil {
		fatal("parse %s: %v", fileID, err)
	}
	validateSchemaDocument(fileID, doc)
	g.files[fileID] = doc
	return doc
}

// def resolves a $ref like "#/$defs/Name" or "other.json#/$defs/Name".
func (g *gen) def(ref, ctxFile string) schema {
	fileID, rest := ctxFile, ref
	if i := strings.Index(ref, "#"); i >= 0 {
		if ref[:i] != "" {
			fileID = ref[:i]
		}
		rest = ref[i+1:]
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	node := schema(g.load(fileID))
	for _, p := range parts {
		next, ok := node[p].(map[string]any)
		if !ok {
			fatal("bad ref %q in %s", ref, ctxFile)
		}
		node = next
	}
	return node
}

func defName(ref string) string {
	i := strings.LastIndex(ref, "/")
	return ref[i+1:]
}

func (g *gen) defRef(fileID, name string) schema {
	doc := g.load(fileID)
	defs, _ := doc["$defs"].(map[string]any)
	d, _ := defs[name].(map[string]any)
	if d == nil {
		fatal("missing $defs/%s in %s", name, fileID)
	}
	return d
}

func (g *gen) isJSONValue(ref, ctxFile string) bool {
	return opaque(g.def(ref, ctxFile))
}

func nullable(node schema) bool {
	branches, _ := node["anyOf"].([]any)
	for _, branch := range branches {
		if m, ok := branch.(map[string]any); ok && m["type"] == "null" {
			return true
		}
	}
	return false
}

// opaque reports whether a schema node describes "any JSON" (no type
// constraints). Such nodes map to json.RawMessage / JsonValue.
func opaque(node schema) bool {
	for _, k := range []string{"type", "properties", "items", "enum", "const", "anyOf", "$ref"} {
		if _, ok := node[k]; ok {
			return false
		}
	}
	return true
}

var schemaKeywords = map[string]bool{
	"$schema": true, "$id": true, "$defs": true, "$ref": true,
	"title": true, "description": true, "type": true, "properties": true,
	"required": true, "items": true, "enum": true, "const": true,
	"anyOf": true, "oneOf": true, "additionalProperties": true, "format": true,
}

// validateSchemaDocument deliberately accepts only the JSON-Schema vocabulary
// implemented by both generators. This turns misspelled/unsupported semantic
// keywords into generation failures instead of silently widening the contract.
func validateSchemaDocument(fileID string, doc schema) {
	var walk func(any, string)
	walk = func(value any, path string) {
		var node map[string]any
		switch typed := value.(type) {
		case schema:
			node = map[string]any(typed)
		case map[string]any:
			node = typed
		default:
			fatal("%s%s: schema node must be an object", fileID, path)
		}
		for key := range node {
			if !schemaKeywords[key] {
				fatal("%s%s: unsupported schema keyword %q", fileID, path, key)
			}
		}
		if typ, ok := node["type"]; ok {
			s, ok := typ.(string)
			if !ok || !map[string]bool{"null": true, "boolean": true, "string": true, "integer": true, "number": true, "array": true, "object": true}[s] {
				fatal("%s%s: invalid schema type %v", fileID, path, typ)
			}
		}
		if format, ok := node["format"]; ok {
			if format != "rfc3339nano" || node["type"] != "string" {
				fatal("%s%s: unsupported format %v", fileID, path, format)
			}
		}
		if props, ok := node["properties"]; ok {
			pm, ok := props.(map[string]any)
			if !ok {
				fatal("%s%s/properties: must be an object", fileID, path)
			}
			for name, child := range pm {
				walk(child, path+"/properties/"+name)
			}
		}
		if defs, ok := node["$defs"]; ok {
			dm, ok := defs.(map[string]any)
			if !ok {
				fatal("%s%s/$defs: must be an object", fileID, path)
			}
			for name, child := range dm {
				walk(child, path+"/$defs/"+name)
			}
		}
		for _, keyword := range []string{"anyOf", "oneOf"} {
			if branches, ok := node[keyword]; ok {
				list, ok := branches.([]any)
				if !ok || len(list) == 0 {
					fatal("%s%s/%s: must be a non-empty array", fileID, path, keyword)
				}
				for i, child := range list {
					walk(child, fmt.Sprintf("%s/%s/%d", path, keyword, i))
				}
			}
		}
		if items, ok := node["items"]; ok {
			walk(items, path+"/items")
		}
		if ap, ok := node["additionalProperties"]; ok {
			if _, boolean := ap.(bool); !boolean {
				walk(ap, path+"/additionalProperties")
			}
		}
		if req, ok := node["required"]; ok {
			list, ok := req.([]any)
			if !ok {
				fatal("%s%s/required: must be an array", fileID, path)
			}
			props, _ := node["properties"].(map[string]any)
			for _, item := range list {
				name, ok := item.(string)
				if !ok || props[name] == nil {
					fatal("%s%s/required: invalid property %v", fileID, path, item)
				}
			}
		}
		if enum, ok := node["enum"]; ok {
			list, ok := enum.([]any)
			if !ok || len(list) == 0 {
				fatal("%s%s/enum: must be a non-empty array", fileID, path)
			}
			for _, item := range list {
				if _, ok := item.(string); !ok {
					fatal("%s%s/enum: only string values are supported", fileID, path)
				}
			}
		}
		if c, ok := node["const"]; ok {
			if _, ok := c.(string); !ok {
				fatal("%s%s/const: only string values are supported", fileID, path)
			}
		}
		if ref, ok := node["$ref"]; ok {
			if s, ok := ref.(string); !ok || s == "" {
				fatal("%s%s/$ref: must be a non-empty string", fileID, path)
			}
		}
	}
	walk(doc, "")
}

// unionDefs returns the def names referenced by a top-level oneOf, in order.
func (g *gen) unionDefs(fileID string) ([]string, []string) {
	doc := g.load(fileID)
	oneOf, _ := doc["oneOf"].([]any)
	var names, consts []string
	for _, item := range oneOf {
		m, _ := item.(map[string]any)
		ref, _ := m["$ref"].(string)
		name := defName(ref)
		names = append(names, name)
		d := g.def(ref, fileID)
		props, _ := d["properties"].(map[string]any)
		tp, _ := props["type"].(map[string]any)
		c, _ := tp["const"].(string)
		consts = append(consts, c)
	}
	return names, consts
}

// ------------------------------------------------------------------ Go naming

var goInitialisms = map[string]bool{
	"id": true, "api": true, "ui": true, "url": true, "pi": true, "json": true,
}

// goIdent converts a camelCase or snake_case string to an exported Go name,
// expanding common initialisms (sessionId -> SessionID).
func goIdent(s string) string {
	parts := splitWords(s)
	var b strings.Builder
	for _, p := range parts {
		if goInitialisms[strings.ToLower(p)] {
			b.WriteString(strings.ToUpper(p))
			continue
		}
		b.WriteString(strings.ToUpper(p[:1]) + p[1:])
	}
	return b.String()
}

// splitWords splits camelCase / snake_case / dotted strings into words.
func splitWords(s string) []string {
	var parts []string
	var cur strings.Builder
	runes := []rune(s)
	for i, r := range runes {
		switch {
		case r == '_' || r == '.' || r == '-':
			parts = append(parts, cur.String())
			cur.Reset()
		case r >= 'A' && r <= 'Z':
			prevLower := i > 0 && (runes[i-1] >= 'a' && runes[i-1] <= 'z' || runes[i-1] >= '0' && runes[i-1] <= '9')
			if cur.Len() > 0 && prevLower {
				parts = append(parts, cur.String())
				cur.Reset()
			}
			cur.WriteRune(r)
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		parts = append(parts, cur.String())
	}
	return parts
}

// ---------------------------------------------------------------- Go type map

func (g *gen) goType(node schema, ctxFile, suggest string) string {
	if ref, ok := node["$ref"].(string); ok {
		if g.isJSONValue(ref, ctxFile) {
			return "json.RawMessage"
		}
		return goIdent(defName(ref))
	}
	if anyOf, ok := node["anyOf"].([]any); ok {
		var nonNull []any
		for _, branch := range anyOf {
			bm, _ := branch.(map[string]any)
			if t, _ := bm["type"].(string); t == "null" {
				continue
			}
			nonNull = append(nonNull, branch)
		}
		if len(nonNull) == 1 {
			return g.goType(nonNull[0].(map[string]any), ctxFile, suggest)
		}
		return "json.RawMessage"
	}
	if _, ok := node["enum"]; ok {
		return "string"
	}
	if _, ok := node["const"]; ok {
		return "string"
	}
	typ, _ := node["type"].(string)
	switch typ {
	case "string":
		return "string"
	case "integer":
		return "int64"
	case "number":
		return "float64"
	case "boolean":
		return "bool"
	case "array":
		items, _ := node["items"].(map[string]any)
		elem := g.goType(items, ctxFile, suggest+"Item")
		return "[]" + elem
	case "object":
		g.emitStruct(node, ctxFile, suggest, "")
		return suggest
	default:
		// Empty schema (JsonValue) or anything unrecognized: opaque JSON.
		return "json.RawMessage"
	}
}

func (g *gen) emitStruct(node schema, ctxFile, name, doc string) {
	if g.structIdx[name] {
		return
	}
	g.structIdx[name] = true
	sd := &structDef{Name: name, Doc: doc}
	props, _ := node["properties"].(map[string]any)
	req := map[string]bool{}
	if reqAny, ok := node["required"].([]any); ok {
		for _, r := range reqAny {
			if s, ok := r.(string); ok {
				req[s] = true
			}
		}
	}
	keys := make([]string, 0, len(props))
	for k := range props {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		pn, _ := props[key].(map[string]any)
		fd := fieldDef{JSONName: key, GoName: goIdent(key)}
		if d, ok := pn["description"].(string); ok {
			fd.Doc = d
		}
		fd.Type = g.goType(pn, ctxFile, name+goIdent(key))
		fd.Pointer = (!req[key] || nullable(pn)) && fd.Type != "json.RawMessage" && !strings.HasPrefix(fd.Type, "[]")
		fd.OmitEmpty = !req[key]
		if !req[key] && nullable(pn) {
			fd.PreserveMode = "nullable"
		}
		if !req[key] && strings.HasPrefix(fd.Type, "[]") {
			fd.PreserveMode = "array"
		}
		sd.Fields = append(sd.Fields, fd)
	}
	g.structs = append(g.structs, sd)
}

// ------------------------------------------------------------------- generate

func (g *gen) generate(outPath string) {
	var b strings.Builder
	b.WriteString("// Code generated by contract/gen_go.go from contract/schemas; DO NOT EDIT.\n")
	b.WriteString("//\n")
	b.WriteString("// Single-source WS contract for v2: wire names keep v1 continuity,\n")
	b.WriteString("// v2 session FrameKind -> wire name mapping is FrameKindToWireName.\n")
	b.WriteString("// Regenerate both mirrors with: go generate ./contract (requires Node.js).\n\n")
	b.WriteString("package wscontract\n\n")
	b.WriteString("import (\n\t\"encoding/json\"\n\t\"fmt\"\n\t\"math\"\n\t\"time\"\n)\n\n")

	// Shared type + frame structs (frames first so the file reads top-down).
	serverNames, serverConsts := g.unionDefs("server-frames.json")
	clientNames, clientConsts := g.unionDefs("client-frames.json")
	for _, fileID := range []string{"shared-types.json", "hello.json", "server-frames.json", "client-frames.json"} {
		doc := g.load(fileID)
		defs, _ := doc["$defs"].(map[string]any)
		names := make([]string, 0, len(defs))
		for n := range defs {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			d, _ := defs[n].(map[string]any)
			docStr, _ := d["description"].(string)
			if t, _ := d["type"].(string); t == "object" && !opaque(d) {
				g.emitStruct(d, fileID, goIdent(n), docStr)
			}
		}
	}

	for _, sd := range g.structs {
		if sd.Doc != "" {
			b.WriteString("// " + sd.Name + " — " + sd.Doc + "\n")
		}
		b.WriteString("type " + sd.Name + " struct {\n")
		for _, f := range sd.Fields {
			if f.Doc != "" {
				b.WriteString("\t// " + f.Doc + "\n")
			}
			typ := f.Type
			if f.Pointer {
				typ = "*" + typ
			}
			tag := `json:"` + f.JSONName
			if f.OmitEmpty {
				tag += ",omitempty"
			}
			tag += `"`
			b.WriteString("\t" + f.GoName + " " + typ + " `" + tag + "`\n")
		}
		b.WriteString("\t// ExtraFields preserves unknown properties for forward-compatible round trips.\n")
		b.WriteString("\tExtraFields map[string]json.RawMessage `json:\"-\"`\n")
		b.WriteString("}\n\n")
	}

	g.emitObjectJSONMethods(&b)
	g.emitValidationRuntime(&b)

	// Union marker interfaces.
	b.WriteString("// ServerFrame is implemented by every server->client frame struct.\n")
	b.WriteString("type ServerFrame interface{ serverFrame() }\n\n")
	b.WriteString("// ClientFrame is implemented by every client->server frame struct.\n")
	b.WriteString("type ClientFrame interface{ clientFrame() }\n\n")

	for _, n := range serverNames {
		b.WriteString("func (" + goIdent(n) + ") serverFrame() {}\n")
	}
	b.WriteString("func (u UnknownFrame) serverFrame() {}\n\n")
	for _, n := range clientNames {
		b.WriteString("func (" + goIdent(n) + ") clientFrame() {}\n")
	}
	b.WriteString("func (u UnknownFrame) clientFrame() {}\n\n")

	// Enum constants for every enum def in the standalone enum files.
	for _, fileID := range []string{"error-codes.json", "notice-kinds.json", "shared-types.json"} {
		doc := g.load(fileID)
		defs, _ := doc["$defs"].(map[string]any)
		names := make([]string, 0, len(defs))
		for n := range defs {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			d, _ := defs[n].(map[string]any)
			enumAny, isEnum := d["enum"].([]any)
			if !isEnum {
				continue
			}
			gn := goIdent(n)
			b.WriteString("// " + gn + " values, from " + fileID + ".\n")
			b.WriteString("type " + gn + " = string\n\n")
			b.WriteString("const (\n")
			for _, v := range enumAny {
				s, _ := v.(string)
				b.WriteString("\t" + gn + goIdent(s) + " " + gn + " = \"" + s + "\"\n")
			}
			b.WriteString(")\n\n")
		}
	}

	// Unknown-frame passthrough (forward compatibility, R1).
	b.WriteString(`// UnknownFrame captures any frame whose type is not in the closed union,
// so a newer peer can send frames this build does not know (R1: drop, never fail).
type UnknownFrame struct {
	Type   string                     ` + "`" + `json:"type"` + "`" + `
	Fields map[string]json.RawMessage ` + "`" + `json:"-"` + "`" + `
}

func (u *UnknownFrame) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if t, ok := fields["type"]; ok {
		if err := json.Unmarshal(t, &u.Type); err != nil {
			return err
		}
	}
	delete(fields, "type")
	u.Fields = fields
	return nil
}

func (u UnknownFrame) MarshalJSON() ([]byte, error) {
	fields := make(map[string]json.RawMessage, len(u.Fields)+1)
	for k, v := range u.Fields {
		fields[k] = v
	}
	t, err := json.Marshal(u.Type)
	if err != nil {
		return nil, err
	}
	fields["type"] = t
	return json.Marshal(fields)
}

`)
	// Parse registries.
	g.emitParse(&b, "Server", "server-frames.json", serverNames, serverConsts)
	g.emitParse(&b, "Client", "client-frames.json", clientNames, clientConsts)

	// Wire-name mapping table (v2 FrameKind -> wire type), from wire-names.json.
	wn := g.defRef("wire-names.json", "WireNames")
	props, _ := wn["properties"].(map[string]any)
	for _, side := range []string{"server", "client"} {
		sideNode, _ := props[side].(map[string]any)
		sProps, _ := sideNode["properties"].(map[string]any)
		keys := make([]string, 0, len(sProps))
		for k := range sProps {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		varName := "FrameKindToWireName"
		comment := "// FrameKindToWireName maps a v2 session FrameKind to the wire type emitted on the\n// socket (v1 continuity; owned by the bridge)."
		if side == "client" {
			varName = "ClientWireNames"
			comment = "// ClientWireNames lists the client->server command names (identity mapping).\n// ping and hello are connection-level and need no session."
		}
		b.WriteString(comment + "\n")
		b.WriteString("var " + varName + " = map[string]string{\n")
		for _, k := range keys {
			pn, _ := sProps[k].(map[string]any)
			c, _ := pn["const"].(string)
			b.WriteString("\t\"" + k + "\": \"" + c + "\",\n")
		}
		b.WriteString("}\n\n")
	}

	src, err := format.Source([]byte(b.String()))
	if err != nil {
		fatal("gofmt generated source: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(outPath), 0o755); err != nil {
		fatal("mkdir: %v", err)
	}
	if err := os.WriteFile(outPath, []byte(src), 0o644); err != nil {
		fatal("write: %v", err)
	}
	fmt.Printf("gen_go: wrote %s (%d structs)\n", outPath, len(g.structs))
}

func (g *gen) defRefForUnion(fileID, name string) schema {
	defs, _ := g.load(fileID)["$defs"].(map[string]any)
	if d, _ := defs[name].(map[string]any); d != nil {
		return d
	}
	// The hello members live in hello.json.
	return g.defRef("hello.json", name)
}

func quoteList(values []string) string {
	parts := make([]string, len(values))
	for i, value := range values {
		parts[i] = fmt.Sprintf("%q", value)
	}
	return "[]string{" + strings.Join(parts, ",") + "}"
}

func (g *gen) emitObjectJSONMethods(b *strings.Builder) {
	b.WriteString(`// Known frame and nested object decoders retain unknown properties. This is an
// intentional forward-compatibility exception to schema additionalProperties:false.
func captureExtraFields(data []byte, known, preserveNullable, preserveArrays []string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil { return nil, err }
	knownSet := make(map[string]bool, len(known))
	for _, key := range known { knownSet[key] = true }
	preserveNullSet := make(map[string]bool, len(preserveNullable))
	for _, key := range preserveNullable { preserveNullSet[key] = true }
	preserveArraySet := make(map[string]bool, len(preserveArrays))
	for _, key := range preserveArrays { preserveArraySet[key] = true }
	for key, raw := range fields {
		if !knownSet[key] { continue }
		text := string(raw)
		if preserveNullSet[key] && text == "null" { continue }
		if preserveArraySet[key] && text == "[]" { continue }
		delete(fields, key)
	}
	if len(fields) == 0 { return nil, nil }
	return fields, nil
}

func marshalWithExtra(known any, extra map[string]json.RawMessage) ([]byte, error) {
	data, err := json.Marshal(known)
	if err != nil || len(extra) == 0 { return data, err }
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil { return nil, err }
	for key, raw := range extra { if _, exists := fields[key]; !exists { fields[key] = raw } }
	return json.Marshal(fields)
}

`)
	for _, sd := range g.structs {
		known, nulls, arrays := []string{}, []string{}, []string{}
		for _, field := range sd.Fields {
			known = append(known, field.JSONName)
			switch field.PreserveMode {
			case "nullable":
				nulls = append(nulls, field.JSONName)
			case "array":
				arrays = append(arrays, field.JSONName)
			}
		}
		fmt.Fprintf(b, "func (v *%s) UnmarshalJSON(data []byte) error {\n\ttype plain %s\n\tif err := json.Unmarshal(data, (*plain)(v)); err != nil { return err }\n\textra, err := captureExtraFields(data, %s, %s, %s)\n\tif err != nil { return err }\n\tv.ExtraFields = extra\n\treturn nil\n}\n\n", sd.Name, sd.Name, quoteList(known), quoteList(nulls), quoteList(arrays))
		fmt.Fprintf(b, "func (v %s) MarshalJSON() ([]byte, error) {\n\ttype plain %s\n\treturn marshalWithExtra(plain(v), v.ExtraFields)\n}\n\n", sd.Name, sd.Name)
	}
}

func (g *gen) validationLiteral(node schema, ctxFile string) string {
	if ref, ok := node["$ref"].(string); ok {
		return g.validationLiteral(g.def(ref, ctxFile), ctxFileForRef(ref, ctxFile))
	}
	parts := []string{}
	if typ, ok := node["type"].(string); ok {
		parts = append(parts, "Type:"+fmt.Sprintf("%q", typ))
	}
	if format, ok := node["format"].(string); ok {
		parts = append(parts, "Format:"+fmt.Sprintf("%q", format))
	}
	if c, ok := node["const"].(string); ok {
		parts = append(parts, "Const:"+fmt.Sprintf("%q", c))
	}
	if values, ok := node["enum"].([]any); ok {
		ss := make([]string, len(values))
		for i, value := range values {
			ss[i] = value.(string)
		}
		parts = append(parts, "Enum:"+quoteList(ss))
	}
	if branches, ok := node["anyOf"].([]any); ok {
		items := make([]string, len(branches))
		for i, branch := range branches {
			items[i] = g.validationLiteral(branch.(map[string]any), ctxFile)
		}
		parts = append(parts, "AnyOf:[]validationSchema{"+strings.Join(items, ",")+"}")
	}
	if props, ok := node["properties"].(map[string]any); ok {
		keys := make([]string, 0, len(props))
		for key := range props {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		items := make([]string, len(keys))
		for i, key := range keys {
			items[i] = fmt.Sprintf("%q:%s", key, g.validationLiteral(props[key].(map[string]any), ctxFile))
		}
		parts = append(parts, "Properties:map[string]validationSchema{"+strings.Join(items, ",")+"}")
	}
	if req, ok := node["required"].([]any); ok {
		ss := make([]string, len(req))
		for i, value := range req {
			ss[i] = value.(string)
		}
		parts = append(parts, "Required:"+quoteList(ss))
	}
	if items, ok := node["items"].(map[string]any); ok {
		parts = append(parts, "Items:&"+g.validationLiteral(items, ctxFile))
	}
	return "validationSchema{" + strings.Join(parts, ",") + "}"
}

func ctxFileForRef(ref, current string) string {
	if i := strings.Index(ref, "#"); i > 0 {
		return ref[:i]
	}
	return current
}

func (g *gen) emitValidationRuntime(b *strings.Builder) {
	b.WriteString(`type validationSchema struct {
	Type string
	Format string
	Const string
	Enum []string
	AnyOf []validationSchema
	Properties map[string]validationSchema
	Required []string
	Items *validationSchema
}

func validateFrameJSON(data []byte, spec validationSchema) error {
	var value any
	if err := json.Unmarshal(data, &value); err != nil { return err }
	return validateValue(value, spec, "frame")
}

func validateValue(value any, spec validationSchema, path string) error {
	if len(spec.AnyOf) > 0 {
		for _, branch := range spec.AnyOf { if validateValue(value, branch, path) == nil { return nil } }
		return fmt.Errorf("%s does not match any allowed schema", path)
	}
	if spec.Const != "" { if value != spec.Const { return fmt.Errorf("%s must equal %q", path, spec.Const) } }
	if len(spec.Enum) > 0 {
		text, ok := value.(string); if !ok { return fmt.Errorf("%s must be a string enum", path) }
		found := false; for _, allowed := range spec.Enum { if text == allowed { found = true; break } }
		if !found { return fmt.Errorf("%s has invalid enum value %q", path, text) }
	}
	switch spec.Type {
	case "": return nil
	case "null": if value != nil { return fmt.Errorf("%s must be null", path) }
	case "string":
		text, ok := value.(string); if !ok { return fmt.Errorf("%s must be a string", path) }
		if spec.Format == "rfc3339nano" { if _, err := time.Parse(time.RFC3339Nano, text); err != nil { return fmt.Errorf("%s must be RFC3339Nano: %w", path, err) } }
	case "boolean": if _, ok := value.(bool); !ok { return fmt.Errorf("%s must be a boolean", path) }
	case "number": if _, ok := value.(float64); !ok { return fmt.Errorf("%s must be a number", path) }
	case "integer": number, ok := value.(float64); if !ok || math.Trunc(number) != number { return fmt.Errorf("%s must be an integer", path) }
	case "array":
		values, ok := value.([]any); if !ok { return fmt.Errorf("%s must be an array", path) }
		if spec.Items != nil { for i, item := range values { if err := validateValue(item, *spec.Items, fmt.Sprintf("%s[%d]", path, i)); err != nil { return err } } }
	case "object":
		object, ok := value.(map[string]any); if !ok { return fmt.Errorf("%s must be an object", path) }
		for _, key := range spec.Required { if _, exists := object[key]; !exists { return fmt.Errorf("%s.%s is required", path, key) } }
		for key, child := range spec.Properties { if item, exists := object[key]; exists { if err := validateValue(item, child, path+"."+key); err != nil { return err } } }
	}
	return nil
}

`)
}

func (g *gen) emitParse(b *strings.Builder, dir, fileID string, names, consts []string) {
	low := strings.ToLower(dir[:1]) + dir[1:] // "serverFrame" / "clientFrame"
	b.WriteString("// New" + dir + "Frame returns a fresh decoded target for a known wire type,\n// or nil when the type is unknown (callers fall back to UnknownFrame).\n")
	b.WriteString("func New" + dir + "Frame(wireType string) " + dir + "Frame {\n")
	b.WriteString("\tswitch wireType {\n")
	for i, n := range names {
		b.WriteString("\tcase \"" + consts[i] + "\":\n\t\treturn new(" + goIdent(n) + ")\n")
	}
	b.WriteString("\t}\n\treturn nil\n}\n\n")

	b.WriteString("// Parse" + dir + "Frame decodes one " + low + " from the wire. Known types decode into the\n")
	b.WriteString("// generated struct; unknown types decode into UnknownFrame (forward compat, R1);\n")
	b.WriteString("// malformed JSON returns an error.\n")
	b.WriteString("func Parse" + dir + "Frame(data []byte) (" + dir + "Frame, error) {\n")
	b.WriteString("\tvar probe struct {\n\t\tType string `json:\"type\"`\n\t}\n")
	b.WriteString("\tif err := json.Unmarshal(data, &probe); err != nil {\n\t\treturn nil, err\n\t}\n")
	b.WriteString("\tif probe.Type == \"\" { return nil, fmt.Errorf(\"frame type is required\") }\n")
	b.WriteString("\tif target := New" + dir + "Frame(probe.Type); target != nil {\n")
	b.WriteString("\t\tswitch probe.Type {\n")
	for i, n := range names {
		b.WriteString("\t\tcase \"" + consts[i] + "\":\n\t\t\tif err := validateFrameJSON(data, " + g.validationLiteral(g.defRefForUnion(fileID, n), fileID) + "); err != nil { return nil, err }\n")
	}
	b.WriteString("\t\t}\n")
	b.WriteString("\t\tif err := json.Unmarshal(data, target); err != nil {\n\t\t\treturn nil, err\n\t\t}\n")
	b.WriteString("\t\treturn target, nil\n\t}\n")
	b.WriteString("\tvar u UnknownFrame\n\tif err := json.Unmarshal(data, &u); err != nil {\n\t\treturn nil, err\n\t}\n")
	b.WriteString("\treturn u, nil\n}\n\n")

	b.WriteString("// " + dir + "FrameTypes lists every known wire type in the closed union.\n")
	b.WriteString("func " + dir + "FrameTypes() []string {\n\treturn []string{\n")
	for _, c := range consts {
		b.WriteString("\t\t\"" + c + "\",\n")
	}
	b.WriteString("\t}\n}\n\n")
}
