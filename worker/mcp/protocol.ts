// A small Model Context Protocol server: JSON-RPC over the Streamable HTTP
// transport, stateless, tools only. Every POST is answered with plain JSON (the
// transport allows that instead of an event stream), so there are no sessions
// to keep and nothing for the Worker to hold between requests.
//
// Kept dependency-free on purpose: the official SDK pulls in Node-only pieces
// (and a JSON-schema compiler that Workers can't run).

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  additionalProperties?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, ctx: C) => Promise<unknown>;
}

/** A problem to tell Claude about (bad input, missing record), returned as a tool error, not a protocol error. */
export class ToolError extends Error {}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

type Id = string | number;
interface RpcRequest {
  jsonrpc: '2.0';
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });
const rpcError = (id: Id | null, code: number, message: string) => ({ jsonrpc: '2.0' as const, id, error: { code, message } });

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

// ---------- input validation (the subset of JSON Schema the tools use) ----------

function check(schema: JsonSchema, v: unknown, path: string): void {
  if (v === undefined || v === null) return;
  const where = path || 'arguments';
  switch (schema.type) {
    case 'string':
      if (typeof v !== 'string') throw new ToolError(`${where} must be a string.`);
      if (schema.minLength != null && v.length < schema.minLength) throw new ToolError(`${where} is too short.`);
      if (schema.maxLength != null && v.length > schema.maxLength) throw new ToolError(`${where} is too long (max ${schema.maxLength} characters).`);
      if (schema.pattern && !new RegExp(schema.pattern).test(v)) throw new ToolError(`${where} has the wrong format${schema.description ? ` (${schema.description})` : ''}.`);
      break;
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolError(`${where} must be a number.`);
      if (schema.type === 'integer' && !Number.isInteger(v)) throw new ToolError(`${where} must be a whole number.`);
      if (schema.minimum != null && v < schema.minimum) throw new ToolError(`${where} must be at least ${schema.minimum}.`);
      if (schema.maximum != null && v > schema.maximum) throw new ToolError(`${where} must be at most ${schema.maximum}.`);
      break;
    case 'boolean':
      if (typeof v !== 'boolean') throw new ToolError(`${where} must be true or false.`);
      break;
    case 'array':
      if (!Array.isArray(v)) throw new ToolError(`${where} must be a list.`);
      if (schema.maxItems != null && v.length > schema.maxItems) throw new ToolError(`${where} has too many items (max ${schema.maxItems}).`);
      if (schema.items) v.forEach((x, i) => check(schema.items!, x, `${where}[${i}]`));
      break;
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`${where} must be an object.`);
      const o = v as Record<string, unknown>;
      for (const k of schema.required ?? []) if (o[k] === undefined || o[k] === null) throw new ToolError(`${path ? `${path}.` : ''}${k} is required.`);
      for (const [k, x] of Object.entries(o)) {
        const sub = schema.properties?.[k];
        if (sub) check(sub, x, path ? `${path}.${k}` : k);
        else if (schema.additionalProperties === false) throw new ToolError(`Unknown argument "${path ? `${path}.` : ''}${k}".`);
      }
      break;
    }
  }
  if (schema.enum && !schema.enum.includes(v as string | number)) throw new ToolError(`${where} must be one of: ${schema.enum.join(', ')}.`);
}

export function validateArgs(schema: JsonSchema, args: unknown): Record<string, unknown> {
  const a = args ?? {};
  check({ ...schema, type: 'object' }, a, '');
  return a as Record<string, unknown>;
}

// ---------- dispatch ----------

async function handleOne<C>(msg: RpcRequest, tools: Tool<C>[], ctx: () => Promise<C>, info: ServerInfo) {
  const id = msg.id as Id;
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : LATEST_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: info.title, version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, {
        tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: { ...t.inputSchema, type: 'object' }, annotations: { title: t.title, ...t.annotations } })),
      });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      try {
        const args = validateArgs(tool.inputSchema, msg.params?.arguments);
        const out = await tool.run(args, await ctx());
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        if (e instanceof ToolError) return rpcResult(id, { content: [{ type: 'text', text: e.message }], isError: true });
        console.error(`MCP tool ${tool.name}`, e);
        return rpcResult(id, { content: [{ type: 'text', text: 'RideBox hit an internal error running this tool. Try again, or check the Worker logs.' }], isError: true });
      }
    }
    // not offered (no capabilities advertised), but answer politely if asked
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

/**
 * Handles one HTTP request to the MCP endpoint. `ctx` is built lazily (only
 * tool calls need the rider's data) and at most once per request.
 */
export async function handleMcp<C>(req: Request, tools: Tool<C>[], makeCtx: () => Promise<C>, info: ServerInfo): Promise<Response> {
  if (req.method !== 'POST') {
    // no server-initiated stream and no sessions to end
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), 400);
  }
  let ctxp: Promise<C> | null = null;
  const ctx = () => (ctxp ??= makeCtx());
  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  if (!msgs.length) return jsonResponse(rpcError(null, -32600, 'Invalid request'), 400);
  const out = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') {
      out.push(rpcError(null, -32600, 'Invalid request'));
      continue;
    }
    // notifications (no id) and responses to us need no answer
    if (m.id === undefined || m.id === null || typeof m.method !== 'string') continue;
    out.push(await handleOne(m, tools, ctx, info));
  }
  if (!out.length) return new Response(null, { status: 202 });
  return jsonResponse(batch ? out : out[0]);
}
