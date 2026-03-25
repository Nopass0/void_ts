import type {
  CollectionSchema,
  SchemaField,
  SchemaModel,
  SchemaProject,
  TypegenOptions,
} from "./types";

function isIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function fieldStorageName(field: SchemaField): string {
  if (field.mapped_name) return field.mapped_name;
  if (field.is_id) return "_id";
  return field.name;
}

function renderPropertyName(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

function relationTarget(field: SchemaField, byModelName: Map<string, SchemaModel>): string {
  const target = field.relation?.model ? byModelName.get(field.relation.model) : undefined;
  if (!target) return "Record<string, JsonValue>";
  return target.name;
}

function scalarType(field: SchemaField, byModelName: Map<string, SchemaModel>): string {
  if (field.prisma_type === "Json") {
    return "JsonValue";
  }
  switch (field.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "datetime":
      return "string";
    case "array":
      return "JsonValue[]";
    case "object":
      return "Record<string, JsonValue>";
    case "relation":
      return relationTarget(field, byModelName);
    default:
      return "JsonValue";
  }
}

function fieldType(field: SchemaField, byModelName: Map<string, SchemaModel>): string {
  const base = scalarType(field, byModelName);
  if (field.type === "relation") {
    if (field.list) return `${base}[]`;
    return field.required ? base : `${base} | null`;
  }
  if (field.list && !base.endsWith("[]")) {
    return `${base}[]`;
  }
  return base;
}

function renderModel(model: SchemaModel, byModelName: Map<string, SchemaModel>): string {
  const lines: string[] = [];
  lines.push(`export interface ${model.name} {`);
  lines.push(`  _id: string;`);

  const fields = model.schema.fields ?? [];
  for (const field of fields) {
    if (fieldStorageName(field) === "_id") {
      continue;
    }
    const optional = field.required ? "" : "?";
    lines.push(`  ${renderPropertyName(field.name)}${optional}: ${fieldType(field, byModelName)};`);
  }

  lines.push(`}`);
  lines.push(`export type ${model.name}CreateInput = Omit<${model.name}, "_id">;`);
  lines.push(`export type ${model.name}UpdateInput = Partial<${model.name}CreateInput>;`);
  return lines.join("\n");
}

function renderDatabaseMap(project: SchemaProject): string {
  const lines: string[] = [];
  const pathEntries = [...(project.models ?? [])].map((model) => ({
    database: model.schema.database ?? "default",
    collection: model.schema.collection ?? model.name,
    model: model.name,
  }));
  pathEntries.sort((left, right) =>
    `${left.database}/${left.collection}`.localeCompare(`${right.database}/${right.collection}`)
  );

  lines.push(`export interface VoidDbGeneratedCollectionsByPath {`);
  for (const entry of pathEntries) {
    lines.push(`  ${JSON.stringify(`${entry.database}/${entry.collection}`)}: ${entry.model};`);
  }
  lines.push(`}`);
  lines.push(``);

  const grouped = new Map<string, Array<{ collection: string; model: string }>>();
  const groupedByCollection = new Map<string, Set<string>>();
  for (const entry of pathEntries) {
    const bucket = grouped.get(entry.database) ?? [];
    bucket.push({ collection: entry.collection, model: entry.model });
    grouped.set(entry.database, bucket);

    const collectionModels = groupedByCollection.get(entry.collection) ?? new Set();
    collectionModels.add(entry.model);
    groupedByCollection.set(entry.collection, collectionModels);
  }

  lines.push(`export interface VoidDbGeneratedCollections extends VoidDbGeneratedCollectionsByPath {`);
  for (const collection of Array.from(groupedByCollection.keys()).sort()) {
    const models = Array.from(groupedByCollection.get(collection) ?? []).sort();
    lines.push(`  ${JSON.stringify(collection)}: ${models.join(" | ")};`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`export interface VoidDbGeneratedDatabases {`);
  for (const [database, collections] of grouped) {
    lines.push(`  ${JSON.stringify(database)}: {`);
    for (const entry of collections.sort((left, right) => left.collection.localeCompare(right.collection))) {
      lines.push(`    ${JSON.stringify(entry.collection)}: ${entry.model};`);
    }
    lines.push(`  };`);
  }
  lines.push(`}`);
  lines.push(``);
  lines.push(`export type VoidDbCollectionName = keyof VoidDbGeneratedCollections;`);
  lines.push(`export type VoidDbCollectionPath = keyof VoidDbGeneratedCollectionsByPath;`);
  lines.push(`export type VoidDbDatabaseName = keyof VoidDbGeneratedDatabases;`);
  lines.push(`export type VoidDbCollectionModel<T extends VoidDbCollectionName> = VoidDbGeneratedCollections[T];`);
  lines.push(`export type VoidDbCollectionPathModel<T extends VoidDbCollectionPath> = VoidDbGeneratedCollectionsByPath[T];`);
  lines.push(`export type VoidDbDatabaseCollections<T extends VoidDbDatabaseName> = VoidDbGeneratedDatabases[T];`);
  return lines.join("\n");
}

export function generateTypeDefinitions(
  project: SchemaProject,
  options: TypegenOptions = {}
): string {
  const header = [
    `/* eslint-disable */`,
    `// Generated by @voiddb/orm${options.moduleName ? ` for ${options.moduleName}` : ""}.`,
    `// Do not edit by hand.`,
    ``,
    `export type JsonValue =`,
    `  | null`,
    `  | string`,
    `  | number`,
    `  | boolean`,
    `  | JsonValue[]`,
    `  | { [key: string]: JsonValue };`,
    ``,
  ];

  const byModelName = new Map<string, SchemaModel>();
  for (const model of project.models ?? []) {
    byModelName.set(model.name, model);
  }

  const body: string[] = [];
  for (const model of project.models ?? []) {
    body.push(renderModel(model, byModelName));
    body.push("");
  }
  body.push(renderDatabaseMap(project));
  body.push("");
  body.push(`export type VoidDbModelName = ${project.models.length > 0 ? project.models.map((model) => JSON.stringify(model.name)).join(" | ") : "never"};`);

  return [...header, ...body].join("\n");
}

export function modelSchemaLookup(project: SchemaProject): Map<string, CollectionSchema> {
  const out = new Map<string, CollectionSchema>();
  for (const model of project.models ?? []) {
    out.set(model.name, model.schema);
  }
  return out;
}
