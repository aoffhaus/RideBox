// The Claude connector's MCP endpoint (/mcp). The OAuth provider (worker/index.ts)
// has already checked the bearer token by the time a request gets here; ctx.props
// holds what the sign-in page stored: the rider's email.

import { allowedEmails, type AuthEnv } from '../auth';
import { loadRiderData, type RiderData } from './data';
import { handleMcp } from './protocol';
import { INSTRUCTIONS, TOOLS, type ToolCtx } from './tools';

export interface McpEnv extends AuthEnv {
  DB: D1Database;
  /** IANA zone used until the app has saved the rider's own (e.g. "America/Los_Angeles") */
  RIDER_TIMEZONE?: string;
}

const INFO = { name: 'ridebox', title: 'RideBox', version: '1.0.0', instructions: INSTRUCTIONS };

export const mcpApiHandler = {
  async fetch(req: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    // a token stays valid until it expires; re-check the allow list so removing an email cuts access at once
    const email = String((ctx as ExecutionContext & { props?: { email?: string } }).props?.email ?? '').toLowerCase();
    if (!email || !allowedEmails(env).includes(email)) {
      return new Response(JSON.stringify({ error: 'This account is not allowed.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }
    return handleMcp<ToolCtx>(
      req,
      TOOLS,
      async () => {
        let data: Promise<RiderData> | null = null;
        return { db: env.DB, data: () => (data ??= loadRiderData(env.DB, env.RIDER_TIMEZONE)) };
      },
      INFO,
    );
  },
};
