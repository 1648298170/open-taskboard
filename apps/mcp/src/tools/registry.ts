// Tool registry: the extension seam of the MCP server. A tool is a name bound
// to { description, inputSchema, handler }; inputSchema is GENERATED from a
// zod schema via z.toJSONSchema (zod v4 native) — never hand-written. Adding a
// tool means appending one entry to a tools/* table; transport and connection
// policy never change.
import { z } from '@taskboard/core/schemas';

/** Generate the JSON Schema for a zod schema (zod v4 native, draft-2020-12). */
const toJsonSchema = <S extends z.ZodType>(schema: S) => z.toJSONSchema(schema);

/** JSON Schema document produced by zod v4's z.toJSONSchema (draft-2020-12). */
export type JSONSchemaObject = ReturnType<typeof toJsonSchema>;

export interface Tool {
  readonly description: string;
  readonly inputSchema: JSONSchemaObject;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export type ToolRegistry = ReadonlyMap<string, Tool>;

/**
 * Bind a zod schema to a handler. The JSON Schema is generated at module load;
 * incoming arguments are zod-parsed before reaching the handler, so handlers
 * always see validated, correctly-typed output.
 */
export function defineTool<S extends z.ZodType>(
  schema: S,
  description: string,
  handler: (args: z.output<S>) => unknown,
): Tool {
  return {
    description,
    inputSchema: toJsonSchema(schema),
    handler: async raw => handler(schema.parse(raw)),
  };
}

export type ToolTable = readonly (readonly [string, Tool])[];

export function createRegistry(...tables: ToolTable[]): ToolRegistry {
  return new Map<string, Tool>(tables.flat());
}

/** tools/list result payload built from the registry (insertion order). */
export function toolsListResult(registry: ToolRegistry): {
  tools: { name: string; description: string; inputSchema: JSONSchemaObject }[];
} {
  const tools = [...registry.entries()].map(([name, tool]) => ({
    name, description: tool.description, inputSchema: tool.inputSchema,
  }));
  return { tools };
}
