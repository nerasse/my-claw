import { z, type ZodType } from "zod";

// The SDK's tool() only accepts Zod shapes, while the registry tools carry plain JSON
// Schema. This converts exactly the subset our tools use (audited: object/string/
// number/boolean/array/enum/required/description); anything unknown degrades to
// z.unknown() instead of failing, so a new schema feature can never break tool wiring.

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
}

function propertyToZod(prop: JsonSchemaProperty): ZodType {
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v) => typeof v === "string")) {
    const values = prop.enum as string[];
    return z.enum(values as [string, ...string[]]);
  }
  let type: ZodType;
  switch (prop.type) {
    case "string":
      type = z.string();
      break;
    case "number":
    case "integer":
      type = z.number();
      break;
    case "boolean":
      type = z.boolean();
      break;
    case "array":
      type = z.array(prop.items ? propertyToZod(prop.items) : z.unknown());
      break;
    case "object":
      type = prop.properties ? z.object(objectShape(prop)) : z.record(z.string(), z.unknown());
      break;
    default:
      type = z.unknown();
  }
  return prop.description ? type.describe(prop.description) : type;
}

function objectShape(schema: JsonSchemaProperty): Record<string, ZodType> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const base = propertyToZod(prop);
    shape[name] = required.has(name) ? base : base.optional();
  }
  return shape;
}

/** Convert a registry tool's JSON Schema `parameters` into the Zod raw shape tool() expects. */
export function jsonSchemaToZodShape(parameters: Record<string, unknown>): Record<string, ZodType> {
  return objectShape(parameters as JsonSchemaProperty);
}
