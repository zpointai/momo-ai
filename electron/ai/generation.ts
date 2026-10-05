import type { Usage } from '../../src/shared/assistant';

/** Provider-neutral seam for the existing bounded processor. No provider registration. */
export type GenerationMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string; // Ephemeral continuation state; never a displayed result.
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};
export interface GenerationRequest {
  model: string;
  messages: GenerationMessage[];
  thinking: 'disabled' | 'enabled';
  reasoningEffort?: 'low' | 'high';
  maxOutputTokens: number;
  structuredOutput: 'json_object' | 'prompt-json';
  tools?: { type: string; function: { name: string; description: string; parameters: object } }[];
  signal: AbortSignal;
  terminalUsage(model: string, usage: Usage | null): Promise<void>;
}
export interface GenerationTurn {
  model: string;
  usage: Usage | null;
  finish: string;
  message: GenerationMessage;
}
export interface GenerationAdapter { generate(request: GenerationRequest): Promise<GenerationTurn> }
