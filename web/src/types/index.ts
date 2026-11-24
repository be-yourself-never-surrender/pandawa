export type NavTab =
  | "overview"
  | "monitor"
  | "workspaces"
  | "canvas"
  | "channels"
  | "terminal"
  | "brains"
  | "providers"
  | "skills"
  | "automation"
  | "settings";

export interface ProviderHealth {
  status: "ready" | "no_key" | "error" | "disabled" | "unchecked";
  latencyMs?: number;
  error?: string;
  checkedAt?: string;
}

export interface ProviderItem {
  id: string;
  name: string;
  kind: "openai" | "openai_responses" | "anthropic" | "gemini";
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  encryptedAtRest?: boolean;
  defaultModel: string;
  models: string[];
  headers: Record<string, string>;
  enabled: boolean;
  health?: ProviderHealth;
}

export interface BrainItem {
  id: string;
  slug: string;
  name: string;
  layer: "main" | "team" | "personal";
  description: string;
  folder_path: string;
  color: string;
  sync_policy: string;
}

export interface AgentItem {
  id: string;
  slug: string;
  name: string;
  title: string;
  role_description: string;
  avatar: string;
  color: string;
  provider_id: string | null;
  model: string;
  purpose: string;
  temperature: number;
  max_tokens: number;
  max_iterations?: number;
  system_prompt: string;
  toolPacks: string[];
  enabled: boolean;
}

export interface TeamItem {
  id: string;
  workspaceDir?: string;
  slug: string;
  name: string;
  description: string;
  team_brain_id: string | null;
  collaboration_mode: "execute" | "deliberate" | "parallel" | "sequential" | "consensus";
  max_rounds: number;
  lead_agent_id?: string | null;
  reviewer_agent_id?: string | null;
  sender_agent_id?: string | null;
  lead_agent_name?: string;
  reviewer_agent_name?: string;
  sender_agent_name?: string;
  enabled: boolean;
  members: Array<{
    id: string;
    name: string;
    avatar: string;
    title: string;
    purpose: string;
    model: string;
    color: string;
  }>;
}

export interface BrainTreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  updatedAt?: string;
  children?: BrainTreeNode[];
}

export interface TopologyNode {
  id: string;
  type: "main_brain" | "team_brain" | "agent" | "provider" | "knowledge" | "toolpack" | "channel";
  refId: string;
  label: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  relation: string;
  permission: string;
  label: string;
  animated: boolean;
  data?: Record<string, unknown>;
}

export interface SessionItem {
  id: string;
  title: string;
  target_type: "team" | "agent";
  target_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MessageItem {
  id: string;
  session_id: string;
  role: string;
  agent_id: string;
  agent_name: string;
  model_used: string;
  content: string;
  reasoning: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface BlackboardEntry {
  id: string;
  team_id: string;
  session_id: string;
  author_agent_id: string;
  author_name: string;
  entry_type: string;
  title: string;
  content: string;
  created_at: string;
}
