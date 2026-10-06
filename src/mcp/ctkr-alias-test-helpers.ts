import { expect } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerCtkrTools } from "./ctkr-tools.ts";

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
export function registeredCtkrTools() {
  const tools = new Map<string, {
    description: string;
    inputSchema: z.ZodRawShape;
    handler: Handler;
  }>();
  const server = {
    registerTool(name: string, config: { description: string; inputSchema: z.ZodRawShape }, handler: Handler) {
      expect(tools.has(name)).toBe(false);
      tools.set(name, { ...config, handler });
    },
  } as unknown as McpServer;
  registerCtkrTools(server);
  return tools;
}

export async function aliasResult(preferred: string, legacy: string, args: Record<string, unknown>) {
  const tools = registeredCtkrTools();
  const invoke = async (name: string) => {
    const tool = tools.get(name)!;
    const parsed = z.object(tool.inputSchema).parse({ ...args, acknowledge_unestablished_fitness: true });
    const answer = JSON.parse((await tool.handler(parsed)).content[0]!.text);
    expect(answer.ok).toBe(true);
    return answer;
  };
  const result = await invoke(preferred);
  expect(await invoke(legacy)).toEqual(result);
  return result.result;
}
