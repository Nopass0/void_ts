import type {
  CollectionSchema,
  SchemaDatasource,
  SchemaField,
  SchemaFieldType,
  SchemaGenerator,
  SchemaIndex,
  SchemaModel,
  SchemaProject,
  SchemaRelation,
} from "./types";

const SCALAR_TYPES = new Map<string, SchemaFieldType>([
  ["String", "string"],
  ["Int", "number"],
  ["BigInt", "number"],
  ["Float", "number"],
  ["Decimal", "number"],
  ["Boolean", "boolean"],
  ["DateTime", "datetime"],
  ["Json", "object"],
  ["Bytes", "string"],
]);

function defaultDatasource(): SchemaDatasource {
  return {
    name: "db",
    provider: "voiddb",
    url: `env("VOID_URL")`,
  };
}

function defaultGenerator(): SchemaGenerator {
  return {
    name: "client",
    provider: "voiddb-client-js",
    output: "./generated",
  };
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === "/" && line[i + 1] === "/") {
      return line.slice(0, i);
    }
  }
  return line;
}

function lineError(index: number, error: Error): Error {
  return new Error(`line ${index + 1}: ${error.message}`);
}

function parseBlockStart(line: string, kind: string): string {
  const trimmed = line.slice(kind.length).trim();
  if (!trimmed.endsWith("{")) {
    throw new Error(`${kind} block must end with {`);
  }
  const name = trimmed.slice(0, -1).trim();
  if (!name) {
    throw new Error(`${kind} name is required`);
  }
  return name;
}

function parseAssignment(line: string): { key: string; value: string } {
  const index = line.indexOf("=");
  if (index === -1) {
    throw new Error(`invalid assignment ${JSON.stringify(line)}`);
  }
  return {
    key: line.slice(0, index).trim(),
    value: line.slice(index + 1).trim(),
  };
}

function cutToken(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(\S+)\s*(.*)$/);
  if (!match) {
    return null;
  }
  return [match[1], match[2].trim()];
}

function parseTypeToken(token: string): { baseType: string; optional: boolean; list: boolean } {
  let next = token.trim();
  let list = false;
  let optional = false;
  if (next.endsWith("[]")) {
    next = next.slice(0, -2);
    list = true;
  }
  if (next.endsWith("?")) {
    next = next.slice(0, -1);
    optional = true;
  }
  return { baseType: next, optional, list };
}

function isScalarType(typeName: string): boolean {
  return SCALAR_TYPES.has(typeName);
}

function mapPrismaType(typeName: string, list: boolean): SchemaFieldType {
  if (list) {
    return "array";
  }
  return SCALAR_TYPES.get(typeName) ?? "relation";
}

function parseCallArg(value: string): string {
  const start = value.indexOf("(");
  const end = value.lastIndexOf(")");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return value.slice(start + 1, end).trim();
}

function parseCallStringArg(value: string): string {
  return parseCallArg(value).replace(/^"|"$/g, "");
}

function splitCsvRespectingBrackets(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let depthParen = 0;
  let depthBracket = 0;
  let inString = false;

  for (const char of text) {
    if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === "(") depthParen += 1;
      if (char === ")" && depthParen > 0) depthParen -= 1;
      if (char === "[") depthBracket += 1;
      if (char === "]" && depthBracket > 0) depthBracket -= 1;
      if (char === "," && depthParen === 0 && depthBracket === 0) {
        if (current.trim()) {
          items.push(current.trim());
        }
        current = "";
        continue;
      }
    }
    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function splitAttributes(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === "(") depth += 1;
      if (char === ")" && depth > 0) depth -= 1;
      if (char === "@" && depth === 0 && index > 0) {
        if (current.trim()) {
          out.push(current.trim());
        }
        current = "";
      }
    }
    current += char;
  }

  if (current.trim()) {
    out.push(current.trim());
  }
  return out;
}

function parseListLiteral(value: string): string[] {
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!trimmed) {
    return [];
  }
  return splitCsvRespectingBrackets(trimmed)
    .map((item) => item.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function runtimeDefaultExpr(expr: string): string {
  const trimmed = expr.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function storageName(field: SchemaField): string {
  if (field.mapped_name) {
    return field.mapped_name;
  }
  if (field.is_id) {
    return "_id";
  }
  return field.name;
}

function parseIndexAttribute(line: string, unique: boolean, primary: boolean): SchemaIndex {
  const inside = parseCallArg(line);
  if (!inside) {
    throw new Error("index fields are required");
  }

  const parts = splitCsvRespectingBrackets(inside);
  if (parts.length === 0) {
    throw new Error("index fields are required");
  }

  const fieldsRaw = parts[0].trim().replace(/^\[/, "").replace(/\]$/, "");
  const fields = splitCsvRespectingBrackets(fieldsRaw).map((part) => part.trim());
  const index: SchemaIndex = { fields, unique, primary };

  for (const part of parts.slice(1)) {
    const normalized = part.replace(/:/g, "=");
    try {
      const { key, value } = parseAssignment(normalized);
      if (key.trim() === "name") {
        index.name = value.replace(/^"|"$/g, "");
      }
    } catch {
      continue;
    }
  }

  return index;
}

function parseRelation(attribute: string, modelName: string): SchemaRelation {
  const inside = parseCallArg(attribute);
  const relation: SchemaRelation = { model: modelName };
  if (!inside) {
    return relation;
  }

  for (const part of splitCsvRespectingBrackets(inside)) {
    const trimmed = part.trim();
    if (trimmed.startsWith('"')) {
      relation.name = trimmed.replace(/^"|"$/g, "");
      continue;
    }

    try {
      const { key, value } = parseAssignment(trimmed.replace(/:/g, "="));
      switch (key.trim()) {
        case "name":
          relation.name = value.replace(/^"|"$/g, "");
          break;
        case "fields":
          relation.fields = parseListLiteral(value);
          break;
        case "references":
          relation.references = parseListLiteral(value);
          break;
        case "onDelete":
          relation.on_delete = value.replace(/^"|"$/g, "");
          break;
        case "onUpdate":
          relation.on_update = value.replace(/^"|"$/g, "");
          break;
      }
    } catch {
      continue;
    }
  }

  return relation;
}

function parseFieldLine(line: string): SchemaField {
  const head = cutToken(line);
  if (!head) {
    throw new Error(`invalid field line ${JSON.stringify(line)}`);
  }
  const [name, rest] = head;
  const typeAndAttrs = cutToken(rest);
  if (!typeAndAttrs) {
    throw new Error(`invalid field line ${JSON.stringify(line)}`);
  }
  const [typeToken, attrText] = typeAndAttrs;
  const { baseType, optional, list } = parseTypeToken(typeToken);

  const field: SchemaField = {
    name,
    required: !optional,
    list,
    prisma_type: baseType,
    type: mapPrismaType(baseType, list),
    virtual: !isScalarType(baseType),
  };

  for (const attribute of splitAttributes(attrText)) {
    if (attribute === "@id") {
      field.is_id = true;
      field.required = true;
      field.type = "string";
      field.prisma_type ||= "String";
      continue;
    }
    if (attribute === "@unique") {
      field.unique = true;
      continue;
    }
    if (attribute === "@updatedAt") {
      field.auto_updated_at = true;
      field.type = "datetime";
      field.prisma_type ||= "DateTime";
      continue;
    }
    if (attribute.startsWith("@default(")) {
      const expr = parseCallArg(attribute);
      field.default_expr = expr;
      field.default = runtimeDefaultExpr(expr);
      continue;
    }
    if (attribute.startsWith("@map(")) {
      field.mapped_name = parseCallStringArg(attribute);
      continue;
    }
    if (attribute.startsWith("@relation(")) {
      field.relation = parseRelation(attribute, baseType);
      field.type = "relation";
      field.virtual = true;
    }
  }

  if (field.is_id && !field.mapped_name && field.name !== "_id") {
    field.mapped_name = "_id";
  }
  if (field.auto_updated_at && !field.default_expr) {
    field.default_expr = "now()";
    field.default = "now()";
  }

  return field;
}

function parseModelAttribute(model: SchemaModel, line: string): void {
  if (line.startsWith("@@database(")) {
    model.schema.database = parseCallStringArg(line);
    return;
  }
  if (line.startsWith("@@map(")) {
    model.schema.collection = parseCallStringArg(line);
    return;
  }
  if (line.startsWith("@@index(")) {
    model.schema.indexes = [...(model.schema.indexes ?? []), parseIndexAttribute(line, false, false)];
    return;
  }
  if (line.startsWith("@@unique(")) {
    model.schema.indexes = [...(model.schema.indexes ?? []), parseIndexAttribute(line, true, false)];
    return;
  }
  if (line.startsWith("@@id(")) {
    model.schema.indexes = [...(model.schema.indexes ?? []), parseIndexAttribute(line, true, true)];
    return;
  }
  throw new Error(`unsupported model attribute ${JSON.stringify(line)}`);
}

function prismaTypeForField(field: SchemaField): string {
  if (field.prisma_type) {
    return field.prisma_type;
  }
  switch (field.type) {
    case "string":
      return "String";
    case "number":
      return "Float";
    case "boolean":
      return "Boolean";
    case "datetime":
      return "DateTime";
    case "array":
    case "object":
      return "Json";
    case "relation":
      return field.relation?.model || "Json";
    default:
      return "String";
  }
}

function renderFieldLine(field: SchemaField): string {
  let localName = field.name;
  let mappedName = field.mapped_name;

  if (field.is_id && storageName(field) === "_id" && localName === "_id") {
    localName = "id";
    mappedName = "_id";
  }

  let typeName = prismaTypeForField(field);
  if (field.list && !typeName.endsWith("[]")) {
    typeName += "[]";
  }
  if (!field.required && !field.list) {
    typeName += "?";
  }

  const attrs: string[] = [];
  if (field.is_id) attrs.push("@id");
  if (field.unique) attrs.push("@unique");
  if (field.default_expr) attrs.push(`@default(${field.default_expr})`);
  if (field.auto_updated_at) attrs.push("@updatedAt");
  if (field.relation) {
    const relationParts: string[] = [];
    if (field.relation.name) relationParts.push(`name: "${field.relation.name}"`);
    if (field.relation.fields?.length) relationParts.push(`fields: [${field.relation.fields.join(", ")}]`);
    if (field.relation.references?.length) relationParts.push(`references: [${field.relation.references.join(", ")}]`);
    if (field.relation.on_delete) relationParts.push(`onDelete: ${field.relation.on_delete}`);
    if (field.relation.on_update) relationParts.push(`onUpdate: ${field.relation.on_update}`);
    attrs.push(`@relation(${relationParts.join(", ")})`);
  }
  if (mappedName && mappedName !== localName) {
    attrs.push(`@map("${mappedName}")`);
  }

  return `  ${localName} ${typeName}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
}

function renderIndexLine(index: SchemaIndex): string {
  const head = index.primary ? "@@id" : index.unique ? "@@unique" : "@@index";
  const parts = [`[${index.fields.join(", ")}]`];
  if (index.name) {
    parts.push(`name: "${index.name}"`);
  }
  return `  ${head}(${parts.join(", ")})`;
}

export function parseSchemaFile(source: string): SchemaProject {
  const project: SchemaProject = {
    datasource: undefined,
    generator: undefined,
    models: [],
  };

  let currentKind: "datasource" | "generator" | "model" | null = null;
  let currentName = "";
  let currentModel: SchemaModel | null = null;

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (!line) {
      continue;
    }

    if (!currentKind) {
      try {
        if (line.startsWith("datasource ")) {
          currentKind = "datasource";
          currentName = parseBlockStart(line, "datasource");
          project.datasource = { name: currentName, provider: "", url: "" };
          continue;
        }
        if (line.startsWith("generator ")) {
          currentKind = "generator";
          currentName = parseBlockStart(line, "generator");
          project.generator = { name: currentName, provider: "" };
          continue;
        }
        if (line.startsWith("model ")) {
          currentKind = "model";
          currentName = parseBlockStart(line, "model");
          currentModel = {
            name: currentName,
            schema: {
              model: currentName,
              fields: [],
            },
          };
          continue;
        }
        throw new Error(`unexpected token ${JSON.stringify(line)}`);
      } catch (error) {
        throw lineError(index, error as Error);
      }
    }

    if (line === "}") {
      if (currentKind === "model" && currentModel) {
        currentModel.schema.database ||= "default";
        currentModel.schema.collection ||= currentModel.name;
        project.models.push(currentModel);
        currentModel = null;
      }
      currentKind = null;
      currentName = "";
      continue;
    }

    try {
      if (currentKind === "datasource") {
        const { key, value } = parseAssignment(line);
        if (!project.datasource) {
          project.datasource = defaultDatasource();
        }
        if (key === "provider") project.datasource.provider = value.replace(/^"|"$/g, "");
        if (key === "url") project.datasource.url = value;
        continue;
      }

      if (currentKind === "generator") {
        const { key, value } = parseAssignment(line);
        if (!project.generator) {
          project.generator = defaultGenerator();
        }
        if (key === "provider") project.generator.provider = value.replace(/^"|"$/g, "");
        if (key === "output") project.generator.output = value.replace(/^"|"$/g, "");
        continue;
      }

      if (currentKind === "model" && currentModel) {
        if (line.startsWith("@@")) {
          parseModelAttribute(currentModel, line);
        } else {
          currentModel.schema.fields.push(parseFieldLine(line));
        }
      }
    } catch (error) {
      throw lineError(index, error as Error);
    }
  }

  if (currentKind) {
    throw new Error(`unterminated ${currentKind} block ${JSON.stringify(currentName)}`);
  }

  project.datasource ||= defaultDatasource();
  project.generator ||= defaultGenerator();

  return project;
}

export function renderSchemaFile(project: SchemaProject): string {
  const datasource = project.datasource ?? defaultDatasource();
  const generator = project.generator ?? defaultGenerator();
  const models = [...(project.models ?? [])].sort((left, right) => {
    const leftKey = `${left.schema.database ?? "default"}/${left.schema.collection ?? left.name}`;
    const rightKey = `${right.schema.database ?? "default"}/${right.schema.collection ?? right.name}`;
    return leftKey.localeCompare(rightKey);
  });

  const lines: string[] = [];
  lines.push(`datasource ${datasource.name} {`);
  lines.push(`  provider = "${datasource.provider}"`);
  lines.push(`  url      = ${datasource.url}`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`generator ${generator.name} {`);
  lines.push(`  provider = "${generator.provider}"`);
  if (generator.output) {
    lines.push(`  output   = "${generator.output}"`);
  }
  lines.push(`}`);

  for (const model of models) {
    const schema = model.schema;
    lines.push(``);
    lines.push(`model ${model.name || schema.model || schema.collection || "Model"} {`);
    for (const field of schema.fields ?? []) {
      lines.push(renderFieldLine(field));
    }
    for (const index of schema.indexes ?? []) {
      lines.push(renderIndexLine(index));
    }
    if (schema.database) {
      lines.push(`  @@database("${schema.database}")`);
    }
    if (schema.collection) {
      lines.push(`  @@map("${schema.collection}")`);
    }
    lines.push(`}`);
  }

  lines.push(``);
  return lines.join("\n");
}
