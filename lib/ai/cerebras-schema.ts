import { z, type ZodType } from "zod";

const MAX_SCHEMA_CHARACTERS = 5_000;
const unsupportedSchemaKeys = new Set([
  "$schema",
  "default",
  "description",
  "examples",
  "format",
  "maxItems",
  "maxLength",
  "minItems",
  "minLength",
  "pattern",
  "title",
]);

function strictSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictSchemaNode);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      output.properties = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          strictSchemaNode(propertySchema),
        ]),
      );
    } else if (!unsupportedSchemaKeys.has(key)) {
      output[key] = strictSchemaNode(child);
    }
  }
  if (output.type === "object") output.additionalProperties = false;
  return output;
}

export function cerebrasJsonSchema<T>(validator: ZodType<T>) {
  const schema = strictSchemaNode(z.toJSONSchema(validator)) as Record<string, unknown>;
  const size = JSON.stringify(schema).length;
  if (size > MAX_SCHEMA_CHARACTERS) {
    throw new Error("Cerebras schema exceeds the 5,000-character strict-output limit.");
  }
  return schema;
}

export function extractJsonObject(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end >= start ? raw.slice(start, end + 1) : raw.trim();
}
