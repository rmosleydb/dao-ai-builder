import { useState, useEffect, useRef } from 'react';
import { Settings, Save, GitBranch, Users, ArrowRightLeft, Plus, Trash2, Info, Bot, X, Tag, Wrench, Sparkles, Loader2, Variable, Layers } from 'lucide-react';
import { useConfigStore } from '@/stores/configStore';
import { useCatalogs, useSchemas } from '@/hooks/useDatabricks';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Textarea from '../ui/Textarea';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import MultiSelect from '../ui/MultiSelect';
import { LogLevel, VariableValue, TraceLocationModel, MonitoringModel } from '@/types/dao-ai-types';
import { clsx } from 'clsx';
import { normalizeRefName } from '@/utils/name-utils';

type SchemaSource = 'configured' | 'select';

/**
 * Get the display string from a VariableValue.
 * Handles strings, numbers, booleans, and variable objects.
 */
function getVariableDisplayValue(value: VariableValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    // Primitive variable
    if ('value' in obj) return String(obj.value);
    // Environment variable with default
    if ('env' in obj && obj.default_value !== undefined) return String(obj.default_value);
    // Return env var name for display
    if ('env' in obj) return `$${obj.env}`;
    // Secret
    if ('scope' in obj && 'secret' in obj) return `{{secrets/${obj.scope}/${obj.secret}}}`;
  }
  return '';
}

// AI Supervisor Prompt generation API
async function generateSupervisorPromptWithAI(params: {
  context?: string;
  agents?: { name: string; description?: string; handoff_prompt?: string }[];
  existing_prompt?: string;
}): Promise<string> {
  const response = await fetch('/api/ai/generate-supervisor-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate supervisor prompt');
  }
  
  const data = await response.json();
  return data.prompt;
}

const LOG_LEVELS = [
  { value: 'TRACE', label: 'TRACE' },
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARNING', label: 'WARNING' },
  { value: 'ERROR', label: 'ERROR' },
];

const WORKLOAD_SIZES = [
  { value: 'Small', label: 'Small' },
  { value: 'Medium', label: 'Medium' },
  { value: 'Large', label: 'Large' },
];

type OrchestrationPattern = 'supervisor' | 'swarm' | 'none';
type HandoffType = 'any' | 'none' | 'specific';

interface HandoffTarget {
  agent: string;
  isDeterministic: boolean;
}

interface HandoffConfig {
  agentName: string;
  type: HandoffType;
  targets: HandoffTarget[];
}

// Environment variable entry - value can be from a variable reference or manual entry
type EnvVarSource = 'variable' | 'manual';
interface EnvVarEntry {
  name: string;
  source: EnvVarSource;
  value: string; // For manual entry
  variableRef: string; // For variable reference
}

// Helper to convert a string to snake_case
function toSnakeCase(str: string): string {
  return str
    .trim()
    .replace(/[\s-]+/g, '_')           // Replace spaces and hyphens with underscores
    .replace(/([a-z])([A-Z])/g, '$1_$2') // Add underscore before capitals in camelCase
    .replace(/[^a-zA-Z0-9_]/g, '')      // Remove non-alphanumeric except underscores
    .toLowerCase()
    .replace(/_+/g, '_')               // Collapse multiple underscores
    .replace(/^_|_$/g, '');            // Remove leading/trailing underscores
}

export default function AppConfigSection() {
  const { config, updateApp, setHasUnsavedAppChanges } = useConfigStore();
  const app = config.app;
  const schemas = config.schemas || {};
  const agents = config.agents || {};
  const llms = config.resources?.llms || {};
  const tools = config.tools || {};
  const memory = config.memory;
  const warehouses = config.resources?.warehouses || {};

  // App settings form
  const [formData, setFormData] = useState(() => {
    // Find the schema key that matches the registered_model's schema
    let modelSchemaKey = '';
    let directCatalog = '';
    let directSchema = '';
    
    if (app?.registered_model?.schema) {
      const regSchema = app.registered_model.schema;
      const regCatalogDisplay = getVariableDisplayValue(regSchema.catalog_name);
      const regSchemaDisplay = getVariableDisplayValue(regSchema.schema_name);
      const matchedSchemaEntry = Object.entries(schemas).find(([, s]) => 
        getVariableDisplayValue(s.catalog_name) === regCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === regSchemaDisplay
      );
      if (matchedSchemaEntry) {
        modelSchemaKey = matchedSchemaEntry[0];
      } else {
        // Schema exists but doesn't match any configured schema
        directCatalog = regCatalogDisplay;
        directSchema = regSchemaDisplay;
      }
    }
    
    // Get service principal ref if it exists
    let spRef = '';
    if (app?.service_principal) {
      if (typeof app.service_principal === 'string') {
        spRef = app.service_principal.startsWith('*') ? app.service_principal.slice(1) : app.service_principal;
      }
    }
    
    return {
      name: app?.name || '',
      description: app?.description || '',
      logLevel: app?.log_level || 'INFO',
      endpointName: app?.endpoint_name || '',
      modelName: app?.registered_model?.name || '',
      modelSchema: modelSchemaKey,
      directCatalog,
      directSchema,
      workloadSize: app?.workload_size || 'Small',
      scaleToZero: app?.scale_to_zero ?? true,
      deploymentTarget: app?.deployment_target || 'model_serving',
      pythonVersion: app?.python_version || '',
      servicePrincipalRef: spRef,
    };
  });
  
  // Schema source - default to 'configured' if there are configured schemas, otherwise 'select'
  const [schemaSource, setSchemaSource] = useState<SchemaSource>(() => {
    const hasConfiguredSchemas = Object.keys(schemas).length > 0;
    // If we have a matching configured schema, use 'configured'
    if (app?.registered_model?.schema) {
      const regSchema = app.registered_model.schema;
      const regCatalogDisplay = getVariableDisplayValue(regSchema.catalog_name);
      const regSchemaDisplay = getVariableDisplayValue(regSchema.schema_name);
      const matchedSchemaEntry = Object.entries(schemas).find(([, s]) => 
        getVariableDisplayValue(s.catalog_name) === regCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === regSchemaDisplay
      );
      if (matchedSchemaEntry) {
        return 'configured';
      }
      // Schema exists but doesn't match - use 'select'
      return 'select';
    }
    return hasConfiguredSchemas ? 'configured' : 'select';
  });
  
  // Catalogs and schemas for direct selection
  const { data: catalogsData } = useCatalogs();
  const { data: schemasListData } = useSchemas(formData.directCatalog || null);
  const catalogs = catalogsData || [];
  const schemasList = schemasListData || [];
  
  // Track if endpoint/model names were auto-derived (to know when to update them)
  const [derivedEndpointName, setDerivedEndpointName] = useState('');
  const [derivedModelName, setDerivedModelName] = useState('');

  // Tags state - values can be strings, booleans, or numbers from YAML
  const [tags, setTags] = useState<Record<string, string | boolean | number>>(
    (app?.tags as Record<string, string | boolean | number>) || {}
  );
  const [newTagKey, setNewTagKey] = useState('');
  const [newTagValue, setNewTagValue] = useState('');

  // Permissions state
  interface PermissionEntry {
    principals: string[];
    entitlements: string[];
  }
  const ENTITLEMENT_OPTIONS = [
    { value: 'CAN_MANAGE', label: 'Can Manage' },
    { value: 'CAN_QUERY', label: 'Can Query' },
    { value: 'CAN_VIEW', label: 'Can View' },
    { value: 'CAN_REVIEW', label: 'Can Review' },
    { value: 'NO_PERMISSIONS', label: 'No Permissions' },
  ];
  const [permissions, setPermissions] = useState<PermissionEntry[]>(
    app?.permissions?.map(p => ({
      principals: p.principals || [],
      entitlements: p.entitlements || [],
    })) || []
  );
  const [newPrincipal, setNewPrincipal] = useState('');

  // Environment variables state
  const [envVars, setEnvVars] = useState<EnvVarEntry[]>(() => {
    const existingEnvVars = app?.environment_vars || {};
    return Object.entries(existingEnvVars).map(([name, value]) => {
      // Check if value is a variable reference (starts with *)
      if (typeof value === 'string' && value.startsWith('*')) {
        return {
          name,
          source: 'variable' as EnvVarSource,
          value: '',
          variableRef: value.slice(1), // Remove the * prefix
        };
      }
      return {
        name,
        source: 'manual' as EnvVarSource,
        value: String(value),
        variableRef: '',
      };
    });
  });

  // Selected agents for the app - default to ALL agents if none are explicitly configured
  const [selectedAgents, setSelectedAgents] = useState<string[]>(() => {
    // Initialize from existing app.agents if they exist
    if (app?.agents && Array.isArray(app.agents) && app.agents.length > 0) {
      return app.agents.map(a => {
        // Find the key in config.agents that matches this agent's name
        const matchedKey = Object.entries(agents).find(([, agent]) => agent.name === a.name)?.[0];
        return matchedKey || '';
      }).filter(Boolean);
    }
    // Default to all agents when no explicit selection exists
    return Object.keys(agents);
  });

  // Orchestration state
  const [pattern, setPattern] = useState<OrchestrationPattern>(
    config.app?.orchestration?.supervisor ? 'supervisor' :
    config.app?.orchestration?.swarm ? 'swarm' : 'none'
  );
  const [supervisorPrompt, setSupervisorPrompt] = useState<string>(() => {
    const p = config.app?.orchestration?.supervisor?.prompt;
    return typeof p === 'string' ? p : '';
  });
  
  // AI generation state for supervisor prompt
  const [isGeneratingSupervisorPrompt, setIsGeneratingSupervisorPrompt] = useState(false);
  const [showSupervisorAiInput, setShowSupervisorAiInput] = useState(false);
  const [supervisorAiContext, setSupervisorAiContext] = useState('');
  
  const [selectedLLM, setSelectedLLM] = useState(() => {
    // Only supervisor uses a model - swarm no longer has a model field
    const existingModel = config.app?.orchestration?.supervisor?.model?.name;
    if (existingModel) {
      const found = Object.entries(llms).find(([, llm]) => llm.name === existingModel);
      return found ? found[0] : '';
    }
    return '';
  });
  const [defaultAgent, setDefaultAgent] = useState(() => {
    const existing = config.app?.orchestration?.swarm?.default_agent;
    if (typeof existing === 'string') return existing;
    if (existing && 'name' in existing) return existing.name;
    return '';
  });
  const [handoffs, setHandoffs] = useState<HandoffConfig[]>(() => {
    const existingHandoffs = config.app?.orchestration?.swarm?.handoffs;
    if (!existingHandoffs) return [];
    
    return Object.entries(existingHandoffs).map(([agentName, targets]) => {
      if (targets === null || targets === undefined) {
        return { agentName, type: 'any' as HandoffType, targets: [] };
      }
      if (Array.isArray(targets) && targets.length === 0) {
        return { agentName, type: 'none' as HandoffType, targets: [] };
      }
      const handoffTargets: HandoffTarget[] = (targets as (string | { name?: string; agent?: string | { name: string }; is_deterministic?: boolean })[]).map(t => {
        if (typeof t === 'string') {
          return { agent: t, isDeterministic: false };
        }
        // HandoffRouteModel: has 'agent' field
        if ('agent' in t && t.agent !== undefined) {
          const agentName = typeof t.agent === 'string' ? t.agent : t.agent?.name || '';
          return { agent: agentName, isDeterministic: t.is_deterministic === true };
        }
        // AgentModel: has 'name' field
        if ('name' in t && t.name !== undefined) {
          return { agent: t.name, isDeterministic: false };
        }
        return { agent: '', isDeterministic: false };
      }).filter(t => t.agent !== '');
      return { agentName, type: 'specific' as HandoffType, targets: handoffTargets };
    });
  });

  // Supervisor tools state - stores tool keys
  const [supervisorTools, setSupervisorTools] = useState<string[]>(() => {
    const existingTools = config.app?.orchestration?.supervisor?.tools;
    if (!existingTools || !Array.isArray(existingTools)) return [];
    
    // Find the tool keys that match the tool names
    return existingTools.map(t => {
      const toolName = typeof t === 'string' ? t : t?.name;
      const matchedKey = Object.entries(tools).find(([, tool]) => tool.name === toolName)?.[0];
      return matchedKey || '';
    }).filter(Boolean);
  });

  // Supervisor middleware state - stores middleware keys
  const [supervisorMiddleware, setSupervisorMiddleware] = useState<string[]>(() => {
    const existingMiddleware = config.app?.orchestration?.supervisor?.middleware;
    if (!existingMiddleware || !Array.isArray(existingMiddleware)) return [];
    
    const middleware = config.middleware || {};
    // Find the middleware keys that match the middleware names
    return existingMiddleware.map(m => {
      const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
      if (!middlewareName) return '';
      const matchedKey = Object.entries(middleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
      return matchedKey || '';
    }).filter(Boolean);
  });

  // Swarm middleware state - stores middleware keys
  const [swarmMiddleware, setSwarmMiddleware] = useState<string[]>(() => {
    const existingMiddleware = config.app?.orchestration?.swarm?.middleware;
    if (!existingMiddleware || !Array.isArray(existingMiddleware)) return [];
    
    const middleware = config.middleware || {};
    // Find the middleware keys that match the middleware names
    return existingMiddleware.map(m => {
      const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
      if (!middlewareName) return '';
      const matchedKey = Object.entries(middleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
      return matchedKey || '';
    }).filter(Boolean);
  });
  
  // Memory reference for orchestration
  const [orchestrationMemoryRef, setOrchestrationMemoryRef] = useState<string>(() => {
    // Check if orchestration has a memory reference
    const orchMemory = config.app?.orchestration?.memory as unknown;
    if (orchMemory) {
      // If it's a string reference like '*memory', extract the ref name
      if (typeof orchMemory === 'string' && orchMemory.startsWith('*')) {
        return orchMemory.slice(1);
      }
      // If memory config exists and has a refName, use it
      if (config.memory?.refName) {
        return config.memory.refName;
      }
    }
    return '';
  });

  // Chat History state
  const [enableChatHistory, setEnableChatHistory] = useState(!!app?.chat_history);
  const [chatHistoryLLM, setChatHistoryLLM] = useState(() => {
    const existingModel = app?.chat_history?.model?.name;
    if (existingModel) {
      const found = Object.entries(llms).find(([, llm]) => llm.name === existingModel);
      return found ? found[0] : '';
    }
    return '';
  });
  const [chatHistoryMaxTokens, setChatHistoryMaxTokens] = useState(app?.chat_history?.max_tokens || 2048);
  const [chatHistoryUsesTokens, setChatHistoryUsesTokens] = useState(() => {
    // Determine initial toggle state based on existing config
    if (app?.chat_history?.max_tokens_before_summary) return true;
    if (app?.chat_history?.max_messages_before_summary) return false;
    return true; // Default to tokens
  });
  const [chatHistoryMaxTokensBeforeSummary, setChatHistoryMaxTokensBeforeSummary] = useState(app?.chat_history?.max_tokens_before_summary || 20480);
  const [chatHistoryMaxMessagesBeforeSummary, setChatHistoryMaxMessagesBeforeSummary] = useState(app?.chat_history?.max_messages_before_summary || 10);

  // Trace Location state
  const [enableTraceLocation, setEnableTraceLocation] = useState(!!app?.trace_location);
  const [traceLocationSchemaKey, setTraceLocationSchemaKey] = useState<string>(() => {
    if (app?.trace_location?.schema) {
      const tl = app.trace_location.schema;
      const tlCat = getVariableDisplayValue(tl.catalog_name);
      const tlSch = getVariableDisplayValue(tl.schema_name);
      const matched = Object.entries(schemas).find(([, s]) =>
        getVariableDisplayValue(s.catalog_name) === tlCat &&
        getVariableDisplayValue(s.schema_name) === tlSch
      );
      return matched ? matched[0] : '';
    }
    return '';
  });
  type TraceWarehouseSource = 'configured' | 'manual';
  const [traceWarehouseSource, setTraceWarehouseSource] = useState<TraceWarehouseSource>(() => {
    if (app?.trace_location?.warehouse) {
      if (typeof app.trace_location.warehouse === 'string') return 'manual';
      const whName = app.trace_location.warehouse.name;
      if (whName && Object.values(warehouses).some(w => w.name === whName)) return 'configured';
    }
    return Object.keys(warehouses).length > 0 ? 'configured' : 'manual';
  });
  const [traceWarehouseKey, setTraceWarehouseKey] = useState<string>(() => {
    if (app?.trace_location?.warehouse && typeof app.trace_location.warehouse !== 'string') {
      const whName = app.trace_location.warehouse.name;
      const matched = Object.entries(warehouses).find(([, w]) => w.name === whName);
      return matched ? matched[0] : '';
    }
    return '';
  });
  const [traceWarehouseId, setTraceWarehouseId] = useState<string>(() => {
    if (app?.trace_location?.warehouse && typeof app.trace_location.warehouse === 'string') {
      return app.trace_location.warehouse;
    }
    return '';
  });

  // Monitoring state
  const [enableMonitoring, setEnableMonitoring] = useState(!!app?.monitoring);
  const [monitoringSampleRate, setMonitoringSampleRate] = useState(app?.monitoring?.sample_rate ?? 1.0);
  const [monitoringGuidelinesSampleRate, setMonitoringGuidelinesSampleRate] = useState(app?.monitoring?.guidelines_sample_rate ?? 0.5);
  const BUILT_IN_SCORERS = ['safety', 'completeness', 'relevance_to_query', 'tool_call_efficiency'];
  const [monitoringScorers, setMonitoringScorers] = useState<string[]>(() => {
    if (app?.monitoring?.scorers) {
      return app.monitoring.scorers
        .filter((s): s is string => typeof s === 'string');
    }
    return [];
  });
  const [newScorerValue, setNewScorerValue] = useState('');
  const [monitoringGuidelines, setMonitoringGuidelines] = useState<{ name: string; guidelines: string[] }[]>(
    () => app?.monitoring?.guidelines || []
  );
  const [newGuidelineName, setNewGuidelineName] = useState('');
  const [newGuidelineText, setNewGuidelineText] = useState('');

  // Track whether initial sync from config has completed.
  // After the first sync, local handoff/orchestration state is managed by the user
  // and should not be overwritten by config re-renders.
  const initialSyncDone = useRef(false);

  // Determine if there are unsaved changes
  const hasChanges = (() => {
    // Check basic form fields
    if (formData.name !== (app?.name || '')) return true;
    if (formData.description !== (app?.description || '')) return true;
    if (formData.logLevel !== (app?.log_level || 'INFO')) return true;
    if (formData.endpointName !== (app?.endpoint_name || '')) return true;
    if (formData.modelName !== (app?.registered_model?.name || '')) return true;
    if (formData.workloadSize !== (app?.workload_size || 'Small')) return true;
    if (formData.scaleToZero !== (app?.scale_to_zero ?? true)) return true;
    if (formData.deploymentTarget !== (app?.deployment_target || 'model_serving')) return true;
    if (formData.pythonVersion !== (app?.python_version || '')) return true;
    
    // Check model schema
    let savedModelSchemaKey = '';
    if (app?.registered_model?.schema) {
      const regSchema = app.registered_model.schema;
      const regCatalogDisplay = getVariableDisplayValue(regSchema.catalog_name);
      const regSchemaDisplay = getVariableDisplayValue(regSchema.schema_name);
      const matchedSchemaEntry = Object.entries(schemas).find(([, s]) => 
        getVariableDisplayValue(s.catalog_name) === regCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === regSchemaDisplay
      );
      savedModelSchemaKey = matchedSchemaEntry ? matchedSchemaEntry[0] : '';
    }
    if (formData.modelSchema !== savedModelSchemaKey) return true;
    
    // Check selected agents
    // Note: When app?.agents is empty/undefined, sync logic defaults to all agents,
    // so comparison should use that same default
    let savedAgentKeys: string[];
    if (app?.agents && Array.isArray(app.agents) && app.agents.length > 0) {
      savedAgentKeys = app.agents.map(a => {
        const matchedKey = Object.entries(agents).find(([, agent]) => agent.name === a.name)?.[0];
        return matchedKey || '';
      }).filter(Boolean).sort();
    } else {
      // Default to all agents when no explicit selection exists (matches sync logic)
      savedAgentKeys = Object.keys(agents).sort();
    }
    const currentAgentKeys = [...selectedAgents].sort();
    if (JSON.stringify(savedAgentKeys) !== JSON.stringify(currentAgentKeys)) return true;
    
    // Check orchestration pattern
    // Note: Sync logic forces 'none' if insufficient agents for supervisor/swarm
    let savedPattern: OrchestrationPattern = 
      app?.orchestration?.supervisor ? 'supervisor' :
      app?.orchestration?.swarm ? 'swarm' : 'none';
    
    // Match sync logic: override to 'none' if insufficient agents
    if ((savedPattern === 'supervisor' || savedPattern === 'swarm') && currentAgentKeys.length <= 1) {
      savedPattern = 'none';
    }
    if (pattern !== savedPattern) return true;
    
    // Check orchestration details
    if (pattern === 'supervisor') {
      const savedLLMName = app?.orchestration?.supervisor?.model?.name;
      const currentLLMName = selectedLLM ? llms[selectedLLM]?.name : '';
      if (savedLLMName !== currentLLMName) return true;
      if (supervisorPrompt !== (app?.orchestration?.supervisor?.prompt || '')) return true;
      
      // Check supervisor tools
      const savedSupervisorTools = (app?.orchestration?.supervisor?.tools || []).map(t => {
        const toolName = typeof t === 'string' ? t : t?.name;
        const matchedKey = Object.entries(tools).find(([, tool]) => tool.name === toolName)?.[0];
        return matchedKey || '';
      }).filter(Boolean).sort();
      const currentSupervisorTools = [...supervisorTools].sort();
      if (JSON.stringify(savedSupervisorTools) !== JSON.stringify(currentSupervisorTools)) return true;
      
      // Check supervisor middleware
      const configMiddleware = config.middleware || {};
      const savedSupervisorMiddleware = (app?.orchestration?.supervisor?.middleware || []).map(m => {
        const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
        if (!middlewareName) return '';
        const matchedKey = Object.entries(configMiddleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
        return matchedKey || '';
      }).filter(Boolean).sort();
      const currentSupervisorMiddleware = [...supervisorMiddleware].sort();
      if (JSON.stringify(savedSupervisorMiddleware) !== JSON.stringify(currentSupervisorMiddleware)) return true;
    } else if (pattern === 'swarm') {
      // Swarm no longer has a model field - just check default_agent and handoffs
      const savedDefaultAgent = app?.orchestration?.swarm?.default_agent;
      const savedDefaultAgentName = typeof savedDefaultAgent === 'string' ? savedDefaultAgent : savedDefaultAgent?.name || '';
      if (defaultAgent !== savedDefaultAgentName) return true;
      
      // Check handoffs (simplified comparison)
      const savedHandoffs = app?.orchestration?.swarm?.handoffs || {};
      const currentHandoffsDict: Record<string, (string | { agent: string; is_deterministic: boolean })[] | null> = {};
      handoffs.forEach(h => {
        if (h.type === 'any') currentHandoffsDict[h.agentName] = null;
        else if (h.type === 'none') currentHandoffsDict[h.agentName] = [];
        else currentHandoffsDict[h.agentName] = h.targets.map(t =>
          t.isDeterministic ? { agent: t.agent, is_deterministic: true } : t.agent
        );
      });
      if (JSON.stringify(savedHandoffs) !== JSON.stringify(currentHandoffsDict)) return true;
      
      // Check swarm middleware
      const swarmConfigMiddleware = config.middleware || {};
      const savedSwarmMiddleware = (app?.orchestration?.swarm?.middleware || []).map(m => {
        const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
        if (!middlewareName) return '';
        const matchedKey = Object.entries(swarmConfigMiddleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
        return matchedKey || '';
      }).filter(Boolean).sort();
      const currentSwarmMiddleware = [...swarmMiddleware].sort();
      if (JSON.stringify(savedSwarmMiddleware) !== JSON.stringify(currentSwarmMiddleware)) return true;
    }
    
    // Check orchestration memory reference
    const savedOrchMemory = app?.orchestration?.memory as unknown;
    let savedOrchMemoryRef = '';
    if (typeof savedOrchMemory === 'string' && savedOrchMemory.startsWith('*')) {
      savedOrchMemoryRef = savedOrchMemory.slice(1);
    } else if (config.memory?.refName && savedOrchMemory) {
      savedOrchMemoryRef = config.memory.refName;
    }
    if (orchestrationMemoryRef !== savedOrchMemoryRef) return true;
    
    // Check tags
    const savedTags = (app?.tags as Record<string, string | boolean | number>) || {};
    if (JSON.stringify(savedTags) !== JSON.stringify(tags)) return true;
    
    // Check permissions
    const savedPermissions = app?.permissions || [];
    if (JSON.stringify(savedPermissions) !== JSON.stringify(permissions)) return true;
    
    // Check environment variables
    const savedEnvVars = app?.environment_vars || {};
    const currentEnvVarsDict: Record<string, string> = {};
    envVars.forEach(ev => {
      if (ev.name) {
        currentEnvVarsDict[ev.name] = ev.source === 'variable' && ev.variableRef 
          ? `*${ev.variableRef}` 
          : ev.value;
      }
    });
    if (JSON.stringify(savedEnvVars) !== JSON.stringify(currentEnvVarsDict)) return true;
    
    // Check service principal
    let savedSpRef = '';
    if (app?.service_principal) {
      if (typeof app.service_principal === 'string') {
        savedSpRef = app.service_principal.startsWith('*') ? app.service_principal.slice(1) : app.service_principal;
      }
    }
    if (formData.servicePrincipalRef !== savedSpRef) return true;
    
    // Check chat history
    const savedChatHistoryEnabled = !!app?.chat_history;
    if (enableChatHistory !== savedChatHistoryEnabled) return true;
    
    if (enableChatHistory) {
      // Check chat history LLM
      const savedChatHistoryLLMName = app?.chat_history?.model?.name;
      const currentChatHistoryLLMName = chatHistoryLLM ? llms[chatHistoryLLM]?.name : '';
      if (savedChatHistoryLLMName !== currentChatHistoryLLMName) return true;
      
      // Check max tokens
      if (chatHistoryMaxTokens !== (app?.chat_history?.max_tokens || 2048)) return true;
      
      // Check summarization settings
      const savedUsesTokens = !!app?.chat_history?.max_tokens_before_summary;
      if (chatHistoryUsesTokens !== savedUsesTokens) return true;
      
      if (chatHistoryUsesTokens) {
        if (chatHistoryMaxTokensBeforeSummary !== (app?.chat_history?.max_tokens_before_summary || 20480)) return true;
      } else {
        if (chatHistoryMaxMessagesBeforeSummary !== (app?.chat_history?.max_messages_before_summary || 10)) return true;
      }
    }
    
    return false;
  })();

  // Validation - check if all required fields are present
  const validationErrors: string[] = [];
  
  // Required: App name
  if (!formData.name.trim()) {
    validationErrors.push('Application name is required');
  }
  
  // Required: Model name (for registered_model)
  if (!formData.modelName.trim()) {
    validationErrors.push('Model name is required');
  }
  
  // Required: At least one agent must be selected
  if (selectedAgents.length === 0) {
    validationErrors.push('At least one agent must be selected');
  }
  
  // For Supervisor pattern, an LLM must be selected (swarm doesn't use a model)
  if (pattern === 'supervisor' && !selectedLLM) {
    validationErrors.push('Supervisor orchestration requires an LLM');
  }
  
  const isValid = validationErrors.length === 0;
  const canSave = hasChanges && isValid;
  
  // Sync hasChanges with global store for Header to use
  useEffect(() => {
    setHasUnsavedAppChanges(hasChanges);
  }, [hasChanges, setHasUnsavedAppChanges]);

  const llmOptions = [
    { value: '', label: 'Select an LLM...' },
    ...Object.entries(llms).map(([key, llm]) => ({
      value: key,
      label: `${key} (${llm.name})`,
    })),
  ];

  const agentNames = Object.keys(agents);
  
  // For swarm orchestration, only show agents that are selected for the app
  const availableAgentsForSwarm = selectedAgents.filter(key => agents[key]);
  
  const agentOptions = [
    { value: '', label: selectedAgents.length === 0 ? 'Select agents for app first...' : 'Select an agent...' },
    ...availableAgentsForSwarm.map((key) => ({
      value: key,
      label: agents[key].name,
    })),
  ];

  const middleware = config.middleware || {};
  const middlewareOptions = Object.entries(middleware).map(([key]) => ({
    value: key,
    label: key,
  }));

  const handoffTypeOptions = [
    { value: 'any', label: 'Any Agent (can hand off to all)' },
    { value: 'specific', label: 'Specific Agents (select targets)' },
    { value: 'none', label: 'No Handoffs (terminal agent)' },
  ];

  // Only show agents selected for the app that don't have handoff rules yet
  const unusedAgentsForHandoffs = availableAgentsForSwarm.filter(
    name => !handoffs.some(h => h.agentName === name)
  );

  // Sync form data when config changes
  useEffect(() => {
    // Find the schema key that matches the registered_model's schema
    let modelSchemaKey = '';
    let directCatalog = '';
    let directSchema = '';
    let detectedSchemaSource: SchemaSource = Object.keys(schemas).length > 0 ? 'configured' : 'select';
    
    if (app?.registered_model?.schema) {
      const regSchema = app.registered_model.schema;
      const regCatalogDisplay = getVariableDisplayValue(regSchema.catalog_name);
      const regSchemaDisplay = getVariableDisplayValue(regSchema.schema_name);
      const matchedSchemaEntry = Object.entries(schemas).find(([, s]) => 
        getVariableDisplayValue(s.catalog_name) === regCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === regSchemaDisplay
      );
      if (matchedSchemaEntry) {
        modelSchemaKey = matchedSchemaEntry[0];
        detectedSchemaSource = 'configured';
      } else {
        // Schema exists but doesn't match any configured schema
        directCatalog = regCatalogDisplay;
        directSchema = regSchemaDisplay;
        detectedSchemaSource = 'select';
      }
    }
    
    // Get service principal ref if it exists
    let spRef = '';
    if (app?.service_principal) {
      if (typeof app.service_principal === 'string') {
        spRef = app.service_principal.startsWith('*') ? app.service_principal.slice(1) : app.service_principal;
      }
    }
    
    setFormData({
      name: app?.name || '',
      description: app?.description || '',
      logLevel: app?.log_level || 'INFO',
      endpointName: app?.endpoint_name || '',
      modelName: app?.registered_model?.name || '',
      modelSchema: modelSchemaKey,
      directCatalog,
      directSchema,
      workloadSize: app?.workload_size || 'Small',
      scaleToZero: app?.scale_to_zero ?? true,
      deploymentTarget: app?.deployment_target || 'model_serving',
      pythonVersion: app?.python_version || '',
      servicePrincipalRef: spRef,
    });
    
    setSchemaSource(detectedSchemaSource);
    
    // Sync selected agents - default to all if none are explicitly configured
    let agentKeys: string[] = [];
    if (app?.agents && Array.isArray(app.agents) && app.agents.length > 0) {
      agentKeys = app.agents.map(a => {
        const matchedKey = Object.entries(agents).find(([, agent]) => agent.name === a.name)?.[0];
        return matchedKey || '';
      }).filter(Boolean);
      setSelectedAgents(agentKeys);
    } else {
      // Default to all agents when no explicit selection exists
      agentKeys = Object.keys(agents);
      setSelectedAgents(agentKeys);
    }
    
    // Only sync orchestration state on initial mount or explicit config reload.
    // After the first sync, local orchestration/handoff state is managed by the user
    // and should not be overwritten by cascading config re-renders.
    if (!initialSyncDone.current) {
      initialSyncDone.current = true;

      // Sync orchestration pattern and settings
      // Note: Supervisor and Swarm require multiple agents, so force to 'none' if only one agent
      let newPattern: OrchestrationPattern = 
        app?.orchestration?.supervisor ? 'supervisor' :
        app?.orchestration?.swarm ? 'swarm' : 'none';
      
      // Override to 'none' if insufficient agents for the pattern
      if ((newPattern === 'supervisor' || newPattern === 'swarm') && agentKeys.length <= 1) {
        newPattern = 'none';
      }
      
      setPattern(newPattern);
      
      // Sync orchestration model (only supervisor uses a model)
      const existingModel = app?.orchestration?.supervisor?.model?.name;
      if (existingModel) {
        const found = Object.entries(llms).find(([, llm]) => llm.name === existingModel);
        setSelectedLLM(found ? found[0] : '');
      } else {
        setSelectedLLM('');
      }
      
      // Sync supervisor prompt
      const syncedPrompt = app?.orchestration?.supervisor?.prompt;
      setSupervisorPrompt(typeof syncedPrompt === 'string' ? syncedPrompt : '');
      
      // Sync supervisor tools
      const existingSupervisorTools = app?.orchestration?.supervisor?.tools;
      if (existingSupervisorTools && Array.isArray(existingSupervisorTools)) {
        const toolKeys = existingSupervisorTools.map(t => {
          const toolName = typeof t === 'string' ? t : t?.name;
          const matchedKey = Object.entries(tools).find(([, tool]) => tool.name === toolName)?.[0];
          return matchedKey || '';
        }).filter(Boolean);
        setSupervisorTools(toolKeys);
      } else {
        setSupervisorTools([]);
      }
      
      // Sync supervisor middleware
      const existingSupervisorMiddleware = app?.orchestration?.supervisor?.middleware;
      if (existingSupervisorMiddleware && Array.isArray(existingSupervisorMiddleware)) {
        const middlewareKeys = existingSupervisorMiddleware.map(m => {
          const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
          if (!middlewareName) return '';
          const matchedKey = Object.entries(middleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
          return matchedKey || '';
        }).filter(Boolean);
        setSupervisorMiddleware(middlewareKeys);
      } else {
        setSupervisorMiddleware([]);
      }
      
      // Sync swarm default agent
      const existingDefault = app?.orchestration?.swarm?.default_agent;
      if (typeof existingDefault === 'string') {
        setDefaultAgent(existingDefault);
      } else if (existingDefault && 'name' in existingDefault) {
        setDefaultAgent(existingDefault.name);
      } else {
        setDefaultAgent('');
      }
      
      // Sync handoffs
      const existingHandoffs = app?.orchestration?.swarm?.handoffs;
      if (existingHandoffs) {
        const newHandoffs: HandoffConfig[] = Object.entries(existingHandoffs).map(([agentName, targets]) => {
          if (targets === null || targets === undefined) {
            return { agentName, type: 'any' as HandoffType, targets: [] as HandoffTarget[] };
          }
          if (Array.isArray(targets) && targets.length === 0) {
            return { agentName, type: 'none' as HandoffType, targets: [] as HandoffTarget[] };
          }
          const handoffTargets: HandoffTarget[] = (targets as (string | { name?: string; agent?: string | { name: string }; is_deterministic?: boolean })[]).map(t => {
            if (typeof t === 'string') {
              return { agent: t, isDeterministic: false };
            }
            if ('agent' in t && t.agent !== undefined) {
              const agentName = typeof t.agent === 'string' ? t.agent : t.agent?.name || '';
              return { agent: agentName, isDeterministic: t.is_deterministic === true };
            }
            if ('name' in t && t.name !== undefined) {
              return { agent: t.name, isDeterministic: false };
            }
            return { agent: '', isDeterministic: false };
          }).filter(t => t.agent !== '');
          return { agentName, type: 'specific' as HandoffType, targets: handoffTargets };
        });
        setHandoffs(newHandoffs);
      } else {
        setHandoffs([]);
      }
      
      // Sync swarm middleware
      const existingSwarmMiddleware = app?.orchestration?.swarm?.middleware;
      if (existingSwarmMiddleware && Array.isArray(existingSwarmMiddleware)) {
        const middlewareKeys = existingSwarmMiddleware.map(m => {
          const middlewareName = typeof m === 'string' ? m : (m as any)?.name;
          if (!middlewareName) return '';
          const matchedKey = Object.entries(middleware).find(([, mw]) => (mw as any)?.name === middlewareName)?.[0];
          return matchedKey || '';
        }).filter(Boolean);
        setSwarmMiddleware(middlewareKeys);
      } else {
        setSwarmMiddleware([]);
      }
      
      // Sync orchestration memory reference
      const orchMemory = app?.orchestration?.memory as unknown;
      if (orchMemory) {
        if (typeof orchMemory === 'string' && orchMemory.startsWith('*')) {
          setOrchestrationMemoryRef(orchMemory.slice(1));
        } else if (config.memory?.refName) {
          setOrchestrationMemoryRef(config.memory.refName);
        } else {
          setOrchestrationMemoryRef('memory');
        }
      } else {
        setOrchestrationMemoryRef('');
      }
    }
    
    // Sync tags
    setTags((app?.tags as Record<string, string | boolean | number>) || {});
    
    // Sync permissions
    setPermissions(
      app?.permissions?.map(p => ({
        principals: p.principals || [],
        entitlements: p.entitlements || [],
      })) || []
    );
    
    // Sync environment variables
    const existingEnvVars = app?.environment_vars || {};
    setEnvVars(
      Object.entries(existingEnvVars).map(([name, value]) => {
        if (typeof value === 'string' && value.startsWith('*')) {
          return {
            name,
            source: 'variable' as EnvVarSource,
            value: '',
            variableRef: value.slice(1),
          };
        }
        return {
          name,
          source: 'manual' as EnvVarSource,
          value: String(value),
          variableRef: '',
        };
      })
    );
    
    // Sync chat history configuration
    setEnableChatHistory(!!app?.chat_history);
    
    const chatHistoryModel = app?.chat_history?.model?.name;
    if (chatHistoryModel) {
      const foundLLM = Object.entries(llms).find(([, llm]) => llm.name === chatHistoryModel);
      setChatHistoryLLM(foundLLM ? foundLLM[0] : '');
    } else {
      setChatHistoryLLM('');
    }
    
    setChatHistoryMaxTokens(app?.chat_history?.max_tokens || 2048);
    
    // Determine if using tokens or messages threshold
    if (app?.chat_history?.max_tokens_before_summary) {
      setChatHistoryUsesTokens(true);
      setChatHistoryMaxTokensBeforeSummary(app.chat_history.max_tokens_before_summary);
    } else if (app?.chat_history?.max_messages_before_summary) {
      setChatHistoryUsesTokens(false);
      setChatHistoryMaxMessagesBeforeSummary(app.chat_history.max_messages_before_summary);
    } else {
      // No chat history configured, reset to defaults
      setChatHistoryUsesTokens(true);
      setChatHistoryMaxTokensBeforeSummary(20480);
      setChatHistoryMaxMessagesBeforeSummary(10);
    }
  }, [app, agents, llms, tools]);

  // Auto-adjust orchestration pattern based on number of selected agents
  // Single agent = always "No Orchestration" (supervisor/swarm disabled)
  // Multiple agents = enable supervisor/swarm options
  useEffect(() => {
    if (selectedAgents.length <= 1) {
      // Single agent or no agents - force to "No Orchestration"
      // Supervisor and Swarm don't make sense with only one agent
      if (pattern !== 'none') {
        setPattern('none');
      }
    }
    // Note: When agents increase to >1, we don't auto-select a pattern
    // User must explicitly choose Supervisor or Swarm
  }, [selectedAgents.length, pattern]);

  const addHandoff = () => {
    if (unusedAgentsForHandoffs.length > 0) {
      setHandoffs([...handoffs, { 
        agentName: unusedAgentsForHandoffs[0], 
        type: 'any', 
        targets: [] as HandoffTarget[]
      }]);
    }
  };

  const removeHandoff = (index: number) => {
    setHandoffs(prev => prev.filter((_, i) => i !== index));
  };

  const updateHandoff = (index: number, updates: Partial<HandoffConfig>) => {
    setHandoffs(prev => prev.map((h, i) => i === index ? { ...h, ...updates } : h));
  };

  const toggleTarget = (handoffIndex: number, targetAgent: string) => {
    setHandoffs(prev => prev.map((h, i) => {
      if (i !== handoffIndex) return h;
      const exists = h.targets.some(t => t.agent === targetAgent);
      const isDet = h.targets.some(t => t.isDeterministic);

      if (exists) {
        // Removing a target
        return { ...h, targets: h.targets.filter(t => t.agent !== targetAgent) };
      }

      // Adding a target: if this rule is deterministic, replace the existing target
      if (isDet) {
        return { ...h, targets: [{ agent: targetAgent, isDeterministic: true }] };
      }
      return { ...h, targets: [...h.targets, { agent: targetAgent, isDeterministic: false }] };
    }));
  };

  const toggleDeterministic = (handoffIndex: number) => {
    setHandoffs(prev => prev.map((h, i) => {
      if (i !== handoffIndex) return h;
      const isCurrentlyDeterministic = h.targets.some(t => t.isDeterministic);

      if (isCurrentlyDeterministic) {
        // Turning off deterministic: keep all targets but mark them as agentic
        return {
          ...h,
          targets: h.targets.map(t => ({ ...t, isDeterministic: false })),
        };
      }

      // Turning on deterministic: keep only the first target and mark it deterministic
      const firstTarget = h.targets[0];
      if (!firstTarget) return h;
      return {
        ...h,
        targets: [{ agent: firstTarget.agent, isDeterministic: true }],
      };
    }));
  };

  // Handler for generating supervisor prompt with AI
  const handleGenerateSupervisorPrompt = async (improveExisting = false) => {
    setIsGeneratingSupervisorPrompt(true);
    try {
      // Gather agent metadata for context
      const agentData = Object.values(agents).map(agent => ({
        name: agent.name,
        description: agent.description,
        handoff_prompt: agent.handoff_prompt,
      }));
      
      const prompt = await generateSupervisorPromptWithAI({
        context: supervisorAiContext || undefined,
        agents: agentData.length > 0 ? agentData : undefined,
        existing_prompt: improveExisting ? supervisorPrompt : undefined,
      });
      
      setSupervisorPrompt(prompt);
      setShowSupervisorAiInput(false);
      setSupervisorAiContext('');
    } catch (error) {
      console.error('Failed to generate supervisor prompt:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate supervisor prompt');
    } finally {
      setIsGeneratingSupervisorPrompt(false);
    }
  };

  const handleSave = () => {
    // Determine the schema based on source
    let selectedSchema;
    if (schemaSource === 'configured' && formData.modelSchema) {
      selectedSchema = schemas[formData.modelSchema];
    } else if (schemaSource === 'select' && formData.directCatalog && formData.directSchema) {
      selectedSchema = {
        catalog_name: formData.directCatalog,
        schema_name: formData.directSchema,
      };
    }

    // Build orchestration config
    let orchestration: any = undefined;
    if (pattern === 'supervisor' && selectedLLM && llms[selectedLLM]) {
      // Build supervisor tools array from selected tool keys
      const supervisorToolsArray = supervisorTools
        .map(key => tools[key])
        .filter(Boolean);
      
      // Build supervisor middleware array from selected middleware keys
      const supervisorMiddlewareArray = supervisorMiddleware
        .map(key => middleware[key])
        .filter(Boolean);
      
      orchestration = {
        supervisor: {
          model: llms[selectedLLM],
          ...(supervisorToolsArray.length > 0 && { tools: supervisorToolsArray }),
          ...(supervisorPrompt && { prompt: supervisorPrompt }),
          ...(supervisorMiddlewareArray.length > 0 && { middleware: supervisorMiddlewareArray }),
        },
        // Add memory reference if configured
        ...(orchestrationMemoryRef && { memory: `*${orchestrationMemoryRef}` }),
      };
    } else if (pattern === 'swarm') {
      // Swarm no longer uses a model - each agent uses its own model
      const handoffsDict: Record<string, (string | { agent: string; is_deterministic: boolean })[] | null> = {};
      handoffs.forEach(h => {
        if (h.type === 'any') {
          handoffsDict[h.agentName] = null;
        } else if (h.type === 'none') {
          handoffsDict[h.agentName] = [];
        } else {
          // Emit HandoffRouteModel objects for deterministic targets, plain strings otherwise
          handoffsDict[h.agentName] = h.targets.map(t =>
            t.isDeterministic
              ? { agent: t.agent, is_deterministic: true }
              : t.agent
          );
        }
      });

      // Build swarm middleware array from selected middleware keys
      const swarmMiddlewareArray = swarmMiddleware
        .map(key => middleware[key])
        .filter(Boolean);

      orchestration = {
        swarm: {
          ...(defaultAgent && agents[defaultAgent] && { default_agent: defaultAgent }),
          ...(Object.keys(handoffsDict).length > 0 && { handoffs: handoffsDict }),
          ...(swarmMiddlewareArray.length > 0 && { middleware: swarmMiddlewareArray }),
        },
        // Add memory reference if configured
        ...(orchestrationMemoryRef && { memory: `*${orchestrationMemoryRef}` }),
      };
    } else if (pattern === 'none') {
      // No orchestration pattern selected - auto-create swarm of one for single agent workflows
      // This ensures Chat/Visualize/Deploy are enabled with a valid configuration
      const existingOrchestration = config.app?.orchestration;
      
      // Get the first selected agent name for default_agent
      const firstAgentKey = selectedAgents[0];
      const firstAgentName = firstAgentKey && agents[firstAgentKey] ? agents[firstAgentKey].name : undefined;
      
      if (orchestrationMemoryRef) {
        // Memory is configured - preserve existing orchestration or create minimal swarm
        if (existingOrchestration?.supervisor) {
          orchestration = {
            supervisor: existingOrchestration.supervisor,
            memory: `*${orchestrationMemoryRef}`,
          };
        } else if (existingOrchestration?.swarm) {
          orchestration = {
            swarm: existingOrchestration.swarm,
            memory: `*${orchestrationMemoryRef}`,
          };
        } else {
          // Swarm no longer uses model - just set default_agent
          orchestration = {
            swarm: firstAgentName ? { default_agent: firstAgentName } : {},
            memory: `*${orchestrationMemoryRef}`,
          };
        }
      } else if (selectedAgents.length > 0 && firstAgentName) {
        // No memory, but agents exist - create minimal swarm of one
        // This ensures the app has valid orchestration for chat/deploy
        orchestration = {
          swarm: { default_agent: firstAgentName },
        };
      }
    }

    // Build agents array from selected agent keys
    const appAgents = selectedAgents
      .map(key => agents[key])
      .filter(Boolean);

    // Build environment_vars dict
    const environmentVars: Record<string, string> = {};
    envVars.forEach(ev => {
      if (ev.name) {
        if (ev.source === 'variable' && ev.variableRef) {
          environmentVars[ev.name] = `*${ev.variableRef}`;
        } else if (ev.source === 'manual' && ev.value) {
          environmentVars[ev.name] = ev.value;
        }
      }
    });

    // Build chat_history config
    let chatHistory: any = undefined;
    if (enableChatHistory && chatHistoryLLM && llms[chatHistoryLLM]) {
      chatHistory = {
        model: llms[chatHistoryLLM],
        max_tokens: chatHistoryMaxTokens,
      };
      
      // Add threshold based on toggle selection (mutually exclusive)
      if (chatHistoryUsesTokens) {
        chatHistory.max_tokens_before_summary = chatHistoryMaxTokensBeforeSummary;
      } else {
        chatHistory.max_messages_before_summary = chatHistoryMaxMessagesBeforeSummary;
      }
    }

    // Build trace_location config
    let traceLocation: TraceLocationModel | undefined = undefined;
    if (enableTraceLocation && traceLocationSchemaKey && schemas[traceLocationSchemaKey]) {
      let warehouseValue: any;
      if (traceWarehouseSource === 'configured' && traceWarehouseKey) {
        warehouseValue = warehouses[traceWarehouseKey];
      } else if (traceWarehouseSource === 'manual' && traceWarehouseId) {
        warehouseValue = traceWarehouseId;
      }
      if (warehouseValue) {
        traceLocation = {
          schema: schemas[traceLocationSchemaKey],
          warehouse: warehouseValue,
        };
      }
    }

    // Build monitoring config
    let monitoring: MonitoringModel | undefined = undefined;
    if (enableMonitoring) {
      monitoring = {
        sample_rate: monitoringSampleRate,
        ...(monitoringScorers.length > 0 && { scorers: monitoringScorers }),
        ...(monitoringGuidelinesSampleRate !== 0.5 && { guidelines_sample_rate: monitoringGuidelinesSampleRate }),
        ...(monitoringGuidelines.length > 0 && { guidelines: monitoringGuidelines }),
      };
    }

    updateApp({
      name: formData.name,
      description: formData.description || undefined,
      log_level: formData.logLevel as LogLevel,
      endpoint_name: formData.endpointName || undefined,
      service_principal: formData.servicePrincipalRef ? `*${formData.servicePrincipalRef}` : undefined,
      registered_model: {
        name: formData.modelName,
        ...(selectedSchema && { schema: selectedSchema }),
      },
      trace_location: traceLocation,
      monitoring,
      workload_size: formData.workloadSize as 'Small' | 'Medium' | 'Large',
      scale_to_zero: formData.scaleToZero,
      deployment_target: formData.deploymentTarget as 'model_serving' | 'apps',
      python_version: formData.pythonVersion || undefined,
      orchestration,
      agents: appAgents.length > 0 ? appAgents : undefined,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
      permissions: permissions.length > 0 ? permissions : undefined,
      environment_vars: Object.keys(environmentVars).length > 0 ? environmentVars : undefined,
      chat_history: chatHistory,
    });
    // Note: hasChanges will automatically become false after save since form now matches config
  };

  const toggleAgent = (agentKey: string) => {
    setSelectedAgents(prev => 
      prev.includes(agentKey)
        ? prev.filter(k => k !== agentKey)
        : [...prev, agentKey]
    );
  };

  const selectAllAgents = () => {
    setSelectedAgents(Object.keys(agents));
  };

  const clearAllAgents = () => {
    setSelectedAgents([]);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-white">Application</h2>
        <p className="text-slate-400 mt-1">
          Configure your application settings, orchestration, and deployment options
        </p>
      </div>

      {/* Main Config */}
      <Card className="space-y-4">
        <div className="flex items-center space-x-2 mb-4">
          <Settings className="w-5 h-5 text-slate-400" />
          <h3 className="font-medium text-white">Application Settings</h3>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Application Name"
            placeholder="e.g., my_retail_app"
            value={formData.name}
            onChange={(e) => {
              const newName = e.target.value;
              const snakeCaseName = toSnakeCase(newName);
              const newEndpointName = snakeCaseName ? `${snakeCaseName}_endpoint` : '';
              const newModelName = normalizeRefName(newName);
              
              // Update form data
              const updates: typeof formData = { ...formData, name: newName };
              
              // Auto-derive endpoint name if it's empty or matches the previous derived value
              if (!formData.endpointName || formData.endpointName === derivedEndpointName) {
                updates.endpointName = newEndpointName;
                setDerivedEndpointName(newEndpointName);
              }
              
              // Auto-derive model name if it's empty or matches the previous derived value
              if (!formData.modelName || formData.modelName === derivedModelName) {
                updates.modelName = newModelName;
                setDerivedModelName(newModelName);
              }
              
              setFormData(updates);
            }}
            required
          />
          <Select
            label="Log Level"
            options={LOG_LEVELS}
            value={formData.logLevel}
            onChange={(e) => setFormData({ ...formData, logLevel: e.target.value as LogLevel })}
          />
        </div>

        <Input
          label="Description"
          placeholder="Brief description of your application"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
        />

        {/* Deployment Target Toggle */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-slate-300">Deployment Target</label>
          <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
            <button
              type="button"
              onClick={() => setFormData({ ...formData, deploymentTarget: 'model_serving' })}
              className={`px-4 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                formData.deploymentTarget === 'model_serving'
                  ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                  : 'text-slate-400 border border-transparent hover:text-slate-300'
              }`}
            >
              Model Serving
            </button>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, deploymentTarget: 'apps' })}
              className={`px-4 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                formData.deploymentTarget === 'apps'
                  ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                  : 'text-slate-400 border border-transparent hover:text-slate-300'
              }`}
            >
              Databricks Apps
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Choose where your agent will be deployed
          </p>
        </div>

        {/* Model Serving specific fields */}
        {formData.deploymentTarget === 'model_serving' && (
          <Input
            label="Endpoint Name"
            placeholder="e.g., my_agent_endpoint"
            value={formData.endpointName}
            onChange={(e) => setFormData({ ...formData, endpointName: e.target.value })}
            hint="The name of the model serving endpoint"
          />
        )}

        {/* Python Version */}
        <Input
          label="Python Version (Optional)"
          placeholder="e.g., 3.11"
          value={formData.pythonVersion}
          onChange={(e) => setFormData({ ...formData, pythonVersion: e.target.value })}
          hint="Python version for the deployment environment"
        />

        {/* Service Principal Selection */}
        <Select
          label="Service Principal (Optional)"
          value={formData.servicePrincipalRef}
          onChange={(e) => setFormData({ ...formData, servicePrincipalRef: e.target.value })}
          options={[
            { value: '', label: 'None - Use default credentials' },
            ...Object.keys(config.service_principals || {}).map((sp) => ({
              value: sp,
              label: sp,
            })),
          ]}
          hint="Optional service principal for application authentication"
        />
        {Object.keys(config.service_principals || {}).length === 0 && formData.servicePrincipalRef === '' && (
          <p className="text-xs text-slate-500 -mt-2">
            Configure service principals in Resources → Service Principals to use them here.
          </p>
        )}
      </Card>

      {/* Agent Selection - Must come before Orchestration */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Bot className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Application Agents</h3>
          </div>
          <div className="flex items-center space-x-2">
            {agentNames.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={selectAllAgents}
                  disabled={selectedAgents.length === agentNames.length}
                >
                  Select All
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearAllAgents}
                  disabled={selectedAgents.length === 0}
                >
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="text-sm text-slate-400">
          Select the agents to include in this application. These agents will be available for orchestration.
        </p>

        {agentNames.length === 0 ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
            No agents configured. Add agents in the Agents section first.
          </div>
        ) : (
          <div className="space-y-2">
            {agentNames.map((key) => {
              const agent = agents[key];
              const isSelected = selectedAgents.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleAgent(key)}
                  className={clsx(
                    'w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left',
                    isSelected
                      ? 'bg-blue-500/10 border-blue-500/50 ring-1 ring-blue-500/30'
                      : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                  )}
                >
                  <div className="flex items-center space-x-3">
                    <div className={clsx(
                      'w-8 h-8 rounded-lg flex items-center justify-center',
                      isSelected ? 'bg-blue-500/20' : 'bg-slate-700'
                    )}>
                      <Bot className={clsx('w-4 h-4', isSelected ? 'text-blue-400' : 'text-slate-400')} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white">{agent.name}</p>
                      {agent.description && (
                        <p className="text-xs text-slate-500 line-clamp-1">{agent.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    {agent.tools && agent.tools.length > 0 && (
                      <Badge variant="default" className="text-[10px]">
                        {agent.tools.length} tools
                      </Badge>
                    )}
                    {isSelected ? (
                      <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    ) : (
                      <div className="w-5 h-5 rounded-full border-2 border-slate-600" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selectedAgents.length > 0 && (
          <div className="pt-3 border-t border-slate-700">
            <p className="text-xs text-slate-500 mb-2">Selected agents ({selectedAgents.length})</p>
            <div className="flex flex-wrap gap-2">
              {selectedAgents.map(key => (
                <span
                  key={key}
                  className="inline-flex items-center px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs"
                >
                  {agents[key]?.name || key}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleAgent(key); }}
                    className="ml-1.5 hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Orchestration Configuration */}
      <Card className="space-y-4">
        <div className="flex items-center space-x-2 mb-2">
          <ArrowRightLeft className="w-5 h-5 text-slate-400" />
          <h3 className="font-medium text-white">Orchestration</h3>
        </div>
        <p className="text-sm text-slate-400 mb-4">
          Configure how agents work together in your multi-agent system
        </p>

        {/* Pattern Selection */}
        <div className="grid grid-cols-3 gap-3">
          <button
            type="button"
            onClick={() => setPattern('none')}
            disabled={selectedAgents.length > 1}
            className={clsx(
              'p-4 rounded-lg border text-center transition-all',
              pattern === 'none'
                ? 'bg-blue-500/10 border-blue-500 ring-1 ring-blue-500'
                : 'bg-slate-800/50 border-slate-700 hover:border-slate-600',
              selectedAgents.length > 1 && 'opacity-50 cursor-not-allowed hover:border-slate-700'
            )}
          >
            <div className="w-10 h-10 mx-auto rounded-lg bg-slate-700 flex items-center justify-center mb-2">
              <GitBranch className="w-5 h-5 text-slate-400" />
            </div>
            <h4 className="text-sm font-medium text-white">No Orchestration</h4>
            <p className="text-xs text-slate-500 mt-0.5">Single agent mode</p>
          </button>

          <button
            type="button"
            onClick={() => setPattern('supervisor')}
            disabled={selectedAgents.length <= 1}
            className={clsx(
              'p-4 rounded-lg border text-center transition-all',
              pattern === 'supervisor'
                ? 'bg-blue-500/10 border-blue-500 ring-1 ring-blue-500'
                : 'bg-slate-800/50 border-slate-700 hover:border-slate-600',
              selectedAgents.length <= 1 && 'opacity-50 cursor-not-allowed hover:border-slate-700'
            )}
          >
            <div className={clsx(
              'w-10 h-10 mx-auto rounded-lg flex items-center justify-center mb-2',
              selectedAgents.length <= 1 ? 'bg-slate-700' : 'bg-blue-500/20'
            )}>
              <Users className={clsx('w-5 h-5', selectedAgents.length <= 1 ? 'text-slate-500' : 'text-blue-400')} />
            </div>
            <h4 className="text-sm font-medium text-white">Supervisor</h4>
            <p className="text-xs text-slate-500 mt-0.5">Central routing agent</p>
          </button>

          <button
            type="button"
            onClick={() => setPattern('swarm')}
            disabled={selectedAgents.length <= 1}
            className={clsx(
              'p-4 rounded-lg border text-center transition-all',
              pattern === 'swarm'
                ? 'bg-blue-500/10 border-blue-500 ring-1 ring-blue-500'
                : 'bg-slate-800/50 border-slate-700 hover:border-slate-600',
              selectedAgents.length <= 1 && 'opacity-50 cursor-not-allowed hover:border-slate-700'
            )}
          >
            <div className={clsx(
              'w-10 h-10 mx-auto rounded-lg flex items-center justify-center mb-2',
              selectedAgents.length <= 1 ? 'bg-slate-700' : 'bg-purple-500/20'
            )}>
              <ArrowRightLeft className={clsx('w-5 h-5', selectedAgents.length <= 1 ? 'text-slate-500' : 'text-purple-400')} />
            </div>
            <h4 className="text-sm font-medium text-white">Swarm</h4>
            <p className="text-xs text-slate-500 mt-0.5">Peer-to-peer handoffs</p>
          </button>
        </div>
        
        {/* Info message about orchestration availability */}
        {selectedAgents.length <= 1 && (
          <p className="text-xs text-slate-500 mt-2">
            Supervisor and Swarm orchestration require multiple agents to be selected.
          </p>
        )}

        {/* Pattern Configuration */}
        {pattern !== 'none' && (
          <div className="space-y-4 pt-4 border-t border-slate-700">
            {/* Only show LLM selection for supervisor pattern - swarm doesn't use a model */}
            {pattern === 'supervisor' && (
              <>
                {Object.keys(llms).length === 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                    Add an LLM in Resources first to configure supervisor orchestration.
                  </div>
                )}

                <Select
                  label="Orchestration Model"
                  options={llmOptions}
                  value={selectedLLM}
                  onChange={(e) => setSelectedLLM(e.target.value)}
                  hint="The LLM that will route requests to appropriate agents"
                />
              </>
            )}

            {pattern === 'supervisor' && (
              <>
                {/* Supervisor Prompt with AI Assistant */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300">Supervisor Prompt (Optional)</label>
                  <div className="flex items-center space-x-2">
                    {!showSupervisorAiInput && (
                      <button
                        type="button"
                        onClick={() => setShowSupervisorAiInput(true)}
                        className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg font-medium bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-300 border border-purple-500/30 hover:from-purple-500/30 hover:to-pink-500/30 transition-all"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>AI Assistant</span>
                      </button>
                    )}
                    {supervisorPrompt && !showSupervisorAiInput && (
                      <button
                        type="button"
                        onClick={() => handleGenerateSupervisorPrompt(true)}
                        className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg font-medium bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-300 border border-purple-500/30 hover:from-purple-500/30 hover:to-pink-500/30 transition-all"
                        disabled={isGeneratingSupervisorPrompt}
                      >
                        {isGeneratingSupervisorPrompt ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        <span>Improve Prompt</span>
                      </button>
                    )}
                  </div>
                  
                  {/* AI Context Input */}
                  {showSupervisorAiInput && (
                    <div className="p-3 bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-lg border border-purple-500/30 space-y-3">
                      <div className="flex items-center space-x-2">
                        <Sparkles className="w-4 h-4 text-purple-400" />
                        <span className="text-sm font-medium text-purple-300">Generate Supervisor Prompt with AI</span>
                      </div>
                      
                      <p className="text-xs text-slate-400">
                        The AI will use the configured agents' names, descriptions, and handoff prompts to generate a supervisor prompt that effectively routes requests.
                      </p>
                      
                      {/* Show configured agents */}
                      {Object.keys(agents).length > 0 && (
                        <div className="space-y-1">
                          <p className="text-xs text-slate-500">Agents that will be included:</p>
                          <div className="flex flex-wrap gap-1">
                            {Object.values(agents).map((agent, idx) => (
                              <span key={idx} className="px-2 py-0.5 bg-slate-800/50 rounded text-xs text-slate-300">
                                {agent.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      <Textarea
                        label="Additional Context (Optional)"
                        placeholder="Describe any specific routing logic, priorities, or special instructions for the supervisor..."
                        value={supervisorAiContext}
                        onChange={(e) => setSupervisorAiContext(e.target.value)}
                        rows={3}
                      />
                      
                      <div className="flex justify-end space-x-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setShowSupervisorAiInput(false);
                            setSupervisorAiContext('');
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => handleGenerateSupervisorPrompt(false)}
                          disabled={isGeneratingSupervisorPrompt || Object.keys(agents).length === 0}
                          className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                        >
                          {isGeneratingSupervisorPrompt ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                              Generating...
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-4 h-4 mr-1.5" />
                              Generate Prompt
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                  
                  <Textarea
                    placeholder="Custom instructions for the supervisor agent..."
                    value={supervisorPrompt}
                    onChange={(e) => setSupervisorPrompt(e.target.value)}
                    rows={4}
                    hint="Override the default supervisor prompt"
                  />
                </div>

                {/* Supervisor Tools Configuration */}
                <div className="space-y-3 pt-3 border-t border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                        <Wrench className="w-4 h-4 text-green-400" />
                        Supervisor Tools
                      </h4>
                      <p className="text-xs text-slate-500">
                        Assign tools that the supervisor can use directly
                      </p>
                    </div>
                  </div>

                  {Object.keys(tools).length === 0 ? (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                      No tools configured. Add tools in the Tools section first.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(tools).map(([key, tool]) => {
                          const isSelected = supervisorTools.includes(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                setSupervisorTools(prev =>
                                  isSelected
                                    ? prev.filter(k => k !== key)
                                    : [...prev, key]
                                );
                              }}
                              className={clsx(
                                'px-3 py-1.5 rounded-lg text-sm transition-colors flex items-center gap-2',
                                isSelected
                                  ? 'bg-green-500/20 text-green-300 border border-green-500/50'
                                  : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600'
                              )}
                            >
                              <Wrench className="w-3 h-3" />
                              {tool.name}
                              {isSelected && (
                                <X className="w-3 h-3 ml-1" />
                              )}
                            </button>
                          );
                        })}
                      </div>
                      
                      {supervisorTools.length > 0 && (
                        <p className="text-xs text-green-400">
                          ✓ {supervisorTools.length} tool{supervisorTools.length !== 1 ? 's' : ''} assigned to supervisor
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Supervisor Middleware Configuration */}
                <div className="space-y-3 pt-3 border-t border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                        <Layers className="w-4 h-4 text-purple-400" />
                        Supervisor Middleware
                      </h4>
                      <p className="text-xs text-slate-500">
                        Assign middleware to customize supervisor execution behavior
                      </p>
                    </div>
                  </div>

                  {Object.keys(middleware).length === 0 ? (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                      No middleware configured. Add middleware in the Middleware section first.
                    </div>
                  ) : (
                    <MultiSelect
                      label="Select Middleware"
                      options={middlewareOptions}
                      value={supervisorMiddleware}
                      onChange={(value) => setSupervisorMiddleware(value)}
                      placeholder="Select middleware..."
                      hint="Middleware to apply to the supervisor agent"
                    />
                  )}
                </div>
              </>
            )}

            {pattern === 'swarm' && (
              <>
                {selectedAgents.length === 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                    Select agents for the application above before configuring swarm orchestration.
                  </div>
                )}

                <Select
                  label="Default Agent"
                  options={agentOptions}
                  value={defaultAgent}
                  onChange={(e) => setDefaultAgent(e.target.value)}
                  hint="The agent that handles initial requests (from selected application agents)"
                  disabled={selectedAgents.length === 0}
                />

                {/* Handoffs Configuration */}
                <div className="space-y-3 pt-3 border-t border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-200">Agent Handoff Rules</h4>
                      <p className="text-xs text-slate-500">
                        Define which agents can hand off to which other agents
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={addHandoff}
                      disabled={unusedAgentsForHandoffs.length === 0 || selectedAgents.length === 0}
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Rule
                    </Button>
                  </div>

                  {selectedAgents.length === 0 && (
                    <div className="bg-slate-800/50 rounded-lg p-3 text-slate-400 text-sm">
                      Select agents for the application first to configure handoff rules.
                    </div>
                  )}

                  {handoffs.length === 0 && selectedAgents.length > 0 && (
                    <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3">
                      <div className="flex items-start space-x-2">
                        <Info className="w-4 h-4 text-blue-400 mt-0.5 flex-shrink-0" />
                        <div className="text-sm text-blue-300">
                          <p className="font-medium">No handoff rules defined</p>
                          <p className="text-blue-400/80 mt-1 text-xs">
                            Without explicit rules, agents will use their <code className="bg-blue-900/50 px-1 rounded">handoff_prompt</code> to determine routing.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {handoffs.map((handoff, index) => (
                    <div
                      key={index}
                      className="bg-slate-800/30 rounded-lg p-3 border border-slate-700/50 space-y-2"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 grid grid-cols-2 gap-3">
                          <Select
                            label="From Agent"
                            value={handoff.agentName}
                            onChange={(e) => updateHandoff(index, { agentName: e.target.value })}
                            options={[
                              { value: handoff.agentName, label: agents[handoff.agentName]?.name || handoff.agentName },
                              ...unusedAgentsForHandoffs.map(name => ({
                                value: name,
                                label: agents[name]?.name || name,
                              })),
                            ]}
                          />
                          <Select
                            label="Can Hand Off To"
                            value={handoff.type}
                            onChange={(e) => updateHandoff(index, { 
                              type: e.target.value as HandoffType,
                              targets: e.target.value === 'specific' ? handoff.targets : []
                            })}
                            options={handoffTypeOptions}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeHandoff(index)}
                          className="ml-2 mt-6"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </Button>
                      </div>

                      {handoff.type === 'specific' && (() => {
                        const isDeterministicRule = handoff.targets.some(t => t.isDeterministic);
                        return (
                          <div className="pt-1 space-y-3">
                            {/* Deterministic toggle - shown first to set context */}
                            <label className="flex items-center gap-2 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={isDeterministicRule}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  toggleDeterministic(index);
                                }}
                                className="w-3.5 h-3.5 rounded border-slate-600 bg-slate-700 text-amber-500 focus:ring-amber-500/30 focus:ring-offset-0 cursor-pointer"
                              />
                              <span className={clsx(
                                'text-xs transition-colors',
                                isDeterministicRule
                                  ? 'text-amber-400 font-medium'
                                  : 'text-slate-400 group-hover:text-slate-300'
                              )}>
                                Deterministic route
                              </span>
                            </label>

                            {isDeterministicRule && (
                              <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-2.5">
                                <p className="text-[10px] text-amber-400/80">
                                  This agent will <span className="font-semibold">always</span> route to the selected target after completing its turn. Only one target is allowed.
                                </p>
                              </div>
                            )}

                            {/* Target agent selection */}
                            <div>
                              <p className="text-xs text-slate-400 mb-2">
                                {isDeterministicRule ? 'Select the target agent:' : 'Select target agents:'}
                              </p>
                              <div className="flex flex-wrap gap-2">
                                {availableAgentsForSwarm
                                  .filter(name => name !== handoff.agentName)
                                  .map(name => {
                                    const isSelected = handoff.targets.some(t => t.agent === name);
                                    // In deterministic mode, disable unselected agents if one is already selected
                                    const isDisabled = isDeterministicRule && !isSelected && handoff.targets.length > 0;
                                    return (
                                      <button
                                        key={name}
                                        type="button"
                                        onClick={() => !isDisabled && toggleTarget(index, name)}
                                        className={clsx(
                                          'px-2.5 py-1 rounded-lg text-xs transition-colors',
                                          isSelected && isDeterministicRule
                                            ? 'bg-amber-500/30 text-amber-300 border border-amber-500/50'
                                            : isSelected
                                            ? 'bg-purple-500/30 text-purple-300 border border-purple-500/50'
                                            : isDisabled
                                            ? 'bg-slate-800 text-slate-600 border border-slate-700 cursor-not-allowed'
                                            : 'bg-slate-700 text-slate-400 border border-slate-600 hover:border-slate-500'
                                        )}
                                        disabled={isDisabled}
                                      >
                                        {agents[name]?.name || name}
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {handoff.type === 'any' && (
                        <p className="text-xs text-emerald-400">
                          ✓ This agent can hand off to any other agent
                        </p>
                      )}

                      {handoff.type === 'none' && (
                        <p className="text-xs text-amber-400">
                          ⊘ This agent cannot hand off (terminal agent)
                        </p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Swarm Middleware Configuration */}
                <div className="space-y-3 pt-3 border-t border-slate-700/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-sm font-medium text-slate-200 flex items-center gap-2">
                        <Layers className="w-4 h-4 text-purple-400" />
                        Swarm Middleware
                      </h4>
                      <p className="text-xs text-slate-500">
                        Assign middleware to apply across all agents in the swarm
                      </p>
                    </div>
                  </div>

                  {Object.keys(middleware).length === 0 ? (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                      No middleware configured. Add middleware in the Middleware section first.
                    </div>
                  ) : (
                    <MultiSelect
                      label="Select Middleware"
                      options={middlewareOptions}
                      value={swarmMiddleware}
                      onChange={(value) => setSwarmMiddleware(value)}
                      placeholder="Select middleware..."
                      hint="Middleware to apply to the swarm orchestration"
                    />
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Pattern Explanation - Compact */}
        <div className="bg-slate-800/30 rounded-lg p-3 text-xs text-slate-400 space-y-1.5">
          <div className="flex items-start space-x-2">
            <Badge variant="info" className="text-[10px] px-1.5 py-0">Supervisor</Badge>
            <span>Central agent analyzes requests and routes to appropriate specialized agents.</span>
          </div>
          <div className="flex items-start space-x-2">
            <Badge variant="info" className="text-[10px] px-1.5 py-0">Swarm</Badge>
            <span>Agents hand off conversations directly to each other based on handoff rules.</span>
          </div>
        </div>

        {/* Memory Selector - Always visible, disabled when no memory is configured */}
        <div className="space-y-2 pt-4 border-t border-slate-700">
          <Select
            label="Memory"
            options={
              memory
                ? [
                    { value: '', label: 'No memory (stateless)' },
                    ...(memory.refName ? [{ value: memory.refName, label: `*${memory.refName}` }] : [{ value: 'memory', label: '*memory' }]),
                  ]
                : [{ value: '', label: 'No memory configured' }]
            }
            value={orchestrationMemoryRef}
            onChange={(e) => setOrchestrationMemoryRef(e.target.value)}
            hint={memory ? "Assign configured memory to enable conversation persistence" : "Configure memory in the Memory section first"}
            disabled={!memory}
          />
          {!memory && (
            <p className="text-xs text-amber-400">
              ⚠️ Add a memory configuration in the <strong>Memory</strong> section to enable conversation persistence.
            </p>
          )}
          {orchestrationMemoryRef && selectedAgents.length === 1 && pattern === 'none' && (
            <p className="text-xs text-cyan-400">
              💡 With a single agent and memory, swarm orchestration will be used automatically.
            </p>
          )}
        </div>
      </Card>

      {/* Model Registration */}
      <Card className="space-y-4">
        <h3 className="font-medium text-white">Model Registration</h3>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Registered Model Name"
            placeholder="e.g., my_agent_model"
            value={formData.modelName}
            onChange={(e) => setFormData({ ...formData, modelName: normalizeRefName(e.target.value) })}
            required
          />
          
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-slate-300">Model Schema</label>
              
              {/* Schema Source Toggle - aligned with label */}
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setSchemaSource('configured')}
                  disabled={Object.keys(schemas).length === 0}
                  className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'configured'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300 disabled:opacity-50 disabled:cursor-not-allowed'
                  }`}
                >
                  Configured
                </button>
                <button
                  type="button"
                  onClick={() => setSchemaSource('select')}
                  className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'select'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
            
            {schemaSource === 'configured' ? (
              <Select
                options={[
                  { value: '', label: 'Select a configured schema...' },
                  ...Object.keys(schemas).map((key) => ({ value: key, label: key })),
                ]}
                value={formData.modelSchema}
                onChange={(e) => setFormData({ ...formData, modelSchema: e.target.value })}
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Select
                  options={[
                    { value: '', label: 'Select Catalog...' },
                    ...catalogs.map((cat) => ({ value: cat.name, label: cat.name })),
                  ]}
                  value={formData.directCatalog}
                  onChange={(e) => setFormData({ ...formData, directCatalog: e.target.value, directSchema: '' })}
                />
                <Select
                  options={[
                    { value: '', label: 'Select Schema...' },
                    ...schemasList.map((s) => ({ value: s.name, label: s.name })),
                  ]}
                  value={formData.directSchema}
                  onChange={(e) => setFormData({ ...formData, directSchema: e.target.value })}
                  disabled={!formData.directCatalog}
                />
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* Deployment Options - Only for Model Serving */}
      {formData.deploymentTarget === 'model_serving' && (
        <Card className="space-y-4">
          <h3 className="font-medium text-white">Model Serving Options</h3>

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Workload Size"
              options={WORKLOAD_SIZES}
              value={formData.workloadSize}
              onChange={(e) => setFormData({ ...formData, workloadSize: e.target.value as 'Small' | 'Medium' | 'Large' })}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-slate-300">Scale to Zero</label>
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 mt-1">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, scaleToZero: true })}
                  className={`px-4 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    formData.scaleToZero
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Enabled
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, scaleToZero: false })}
                  className={`px-4 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    !formData.scaleToZero
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Disabled
                </button>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Chat History Configuration */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Bot className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Chat History Summarization</h3>
          </div>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableChatHistory}
              onChange={(e) => setEnableChatHistory(e.target.checked)}
              className="rounded border-slate-600 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
            />
            <span className="text-xs text-slate-400">Enable</span>
          </label>
        </div>
        <p className="text-sm text-slate-400">
          Configure automatic chat history summarization to manage long conversations and reduce token usage
        </p>

        {enableChatHistory && (
          <div className="space-y-4 p-4 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Summary Model"
                value={chatHistoryLLM}
                onChange={(e) => setChatHistoryLLM(e.target.value)}
                options={[
                  { value: '', label: 'Select an LLM...' },
                  ...Object.entries(llms).map(([key, llm]) => ({
                    value: key,
                    label: llm.name || key,
                  })),
                ]}
                hint="LLM for chat history summarization"
                required
              />

              <Input
                label="Max Summary Tokens"
                type="number"
                value={chatHistoryMaxTokens}
                onChange={(e) => setChatHistoryMaxTokens(parseInt(e.target.value) || 2048)}
                hint="Max tokens for the summary"
                min={1}
              />
            </div>

            {Object.keys(llms).length === 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                No LLMs configured. Add an LLM in Resources section first.
              </div>
            )}

            <div className="space-y-3">
              <label className="block text-sm font-medium text-slate-300">Trigger Threshold</label>
              <div className="flex items-center space-x-6 mb-3">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={chatHistoryUsesTokens}
                    onChange={() => setChatHistoryUsesTokens(true)}
                    className="text-purple-500 focus:ring-purple-500 focus:ring-offset-slate-900"
                  />
                  <span className="text-sm text-slate-300">By Tokens</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="radio"
                    checked={!chatHistoryUsesTokens}
                    onChange={() => setChatHistoryUsesTokens(false)}
                    className="text-purple-500 focus:ring-purple-500 focus:ring-offset-slate-900"
                  />
                  <span className="text-sm text-slate-300">By Messages</span>
                </label>
              </div>
              
              {chatHistoryUsesTokens ? (
                <Input
                  label="Max Tokens Before Summary"
                  type="number"
                  value={chatHistoryMaxTokensBeforeSummary}
                  onChange={(e) => setChatHistoryMaxTokensBeforeSummary(parseInt(e.target.value) || 20480)}
                  hint="Trigger when history exceeds this token count"
                  min={1}
                />
              ) : (
                <Input
                  label="Max Messages Before Summary"
                  type="number"
                  value={chatHistoryMaxMessagesBeforeSummary}
                  onChange={(e) => setChatHistoryMaxMessagesBeforeSummary(parseInt(e.target.value) || 10)}
                  hint="Trigger when history exceeds this message count"
                  min={1}
                />
              )}
            </div>

            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-sm text-blue-300">
              <div className="flex items-start space-x-2">
                <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">How it works:</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-blue-200/80">
                    <li>When the threshold is exceeded, older messages are summarized using the selected LLM</li>
                    <li>Recent messages (up to <strong>{chatHistoryMaxTokens}</strong> tokens) are preserved for context</li>
                    <li>The summary replaces older messages, reducing overall token usage</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Trace Location */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Layers className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Trace Location</h3>
          </div>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableTraceLocation}
              onChange={(e) => setEnableTraceLocation(e.target.checked)}
              className="rounded border-slate-600 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
            />
            <span className="text-xs text-slate-400">Enable</span>
          </label>
        </div>
        <p className="text-sm text-slate-400">
          Store MLflow traces in Unity Catalog Delta tables for production observability
        </p>

        {enableTraceLocation && (
          <div className="space-y-4 p-4 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <Select
              label="Schema"
              value={traceLocationSchemaKey}
              onChange={(e) => setTraceLocationSchemaKey(e.target.value)}
              options={[
                { value: '', label: 'Select a configured schema...' },
                ...Object.entries(schemas).map(([key, s]) => ({
                  value: key,
                  label: `${key} (${getVariableDisplayValue(s.catalog_name)}.${getVariableDisplayValue(s.schema_name)})`,
                })),
              ]}
              hint="Unity Catalog schema where OTEL trace tables are stored"
              required
            />

            {Object.keys(schemas).length === 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-amber-400 text-sm">
                No schemas configured. Add a schema in the Schemas section first.
              </div>
            )}

            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Warehouse</label>
              <div className="flex items-center space-x-2 mb-2">
                <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                  <button
                    type="button"
                    onClick={() => setTraceWarehouseSource('configured')}
                    className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                      traceWarehouseSource === 'configured'
                        ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                        : 'text-slate-400 border border-transparent hover:text-slate-300'
                    }`}
                  >
                    Configured
                  </button>
                  <button
                    type="button"
                    onClick={() => setTraceWarehouseSource('manual')}
                    className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                      traceWarehouseSource === 'manual'
                        ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                        : 'text-slate-400 border border-transparent hover:text-slate-300'
                    }`}
                  >
                    Manual
                  </button>
                </div>
              </div>
              {traceWarehouseSource === 'configured' ? (
                <Select
                  value={traceWarehouseKey}
                  onChange={(e) => setTraceWarehouseKey(e.target.value)}
                  options={[
                    { value: '', label: 'Select a configured warehouse...' },
                    ...Object.entries(warehouses).map(([key, wh]) => ({
                      value: key,
                      label: `${key}${wh.name ? ` (${wh.name})` : ''}`,
                    })),
                  ]}
                  hint="Reference a warehouse from Resources"
                />
              ) : (
                <Input
                  value={traceWarehouseId}
                  onChange={(e) => setTraceWarehouseId(e.target.value)}
                  placeholder="Enter warehouse ID..."
                  hint="SQL warehouse ID for creating views and querying traces"
                />
              )}
            </div>
          </div>
        )}
      </Card>

      {/* Monitoring */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Settings className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Monitoring</h3>
          </div>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enableMonitoring}
              onChange={(e) => setEnableMonitoring(e.target.checked)}
              className="rounded border-slate-600 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
            />
            <span className="text-xs text-slate-400">Enable</span>
          </label>
        </div>
        <p className="text-sm text-slate-400">
          Configure production monitoring with MLflow scorers and evaluation guidelines
        </p>

        {enableMonitoring && (
          <div className="space-y-4 p-4 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Sample Rate"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={monitoringSampleRate}
                onChange={(e) => setMonitoringSampleRate(parseFloat(e.target.value) || 1.0)}
                hint="Sampling rate for built-in scorers (0.0 - 1.0)"
              />
              <Input
                label="Guidelines Sample Rate"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={monitoringGuidelinesSampleRate}
                onChange={(e) => setMonitoringGuidelinesSampleRate(parseFloat(e.target.value) || 0.5)}
                hint="Sampling rate for guideline scorers (0.0 - 1.0)"
              />
            </div>

            {/* Scorers */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Scorers</label>
              <p className="text-xs text-slate-500">Select built-in scorers or add custom scorer names</p>
              <div className="flex flex-wrap gap-2">
                {BUILT_IN_SCORERS.map(scorer => (
                  <button
                    key={scorer}
                    type="button"
                    onClick={() => {
                      if (monitoringScorers.includes(scorer)) {
                        setMonitoringScorers(monitoringScorers.filter(s => s !== scorer));
                      } else {
                        setMonitoringScorers([...monitoringScorers, scorer]);
                      }
                    }}
                    className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                      monitoringScorers.includes(scorer)
                        ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/50'
                        : 'bg-slate-700 text-slate-400 border border-slate-600 hover:border-slate-500'
                    }`}
                  >
                    {scorer}
                  </button>
                ))}
              </div>
              {monitoringScorers.filter(s => !BUILT_IN_SCORERS.includes(s)).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {monitoringScorers.filter(s => !BUILT_IN_SCORERS.includes(s)).map(scorer => (
                    <span key={scorer} className="inline-flex items-center px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs">
                      {scorer}
                      <button
                        type="button"
                        onClick={() => setMonitoringScorers(monitoringScorers.filter(s => s !== scorer))}
                        className="ml-1.5 hover:text-red-300"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center space-x-2">
                <Input
                  value={newScorerValue}
                  onChange={(e) => setNewScorerValue(e.target.value)}
                  placeholder="Add custom scorer..."
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (newScorerValue && !monitoringScorers.includes(newScorerValue)) {
                      setMonitoringScorers([...monitoringScorers, newScorerValue]);
                      setNewScorerValue('');
                    }
                  }}
                  disabled={!newScorerValue}
                >
                  Add
                </Button>
              </div>
            </div>

            {/* Guidelines */}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Guidelines</label>
              <p className="text-xs text-slate-500">Named sets of evaluation guidelines for quality monitoring</p>
              
              {monitoringGuidelines.map((guideline, gIdx) => (
                <div key={gIdx} className="p-3 bg-slate-800/50 rounded-lg border border-slate-700 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-blue-400">{guideline.name}</span>
                    <button
                      type="button"
                      onClick={() => setMonitoringGuidelines(monitoringGuidelines.filter((_, i) => i !== gIdx))}
                      className="text-slate-400 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <ul className="space-y-1">
                    {guideline.guidelines.map((text, tIdx) => (
                      <li key={tIdx} className="flex items-start space-x-2 text-xs text-slate-400">
                        <span className="text-slate-600 mt-0.5">-</span>
                        <span className="flex-1">{text}</span>
                        <button
                          type="button"
                          onClick={() => {
                            const updated = [...monitoringGuidelines];
                            updated[gIdx] = {
                              ...updated[gIdx],
                              guidelines: updated[gIdx].guidelines.filter((_, i) => i !== tIdx),
                            };
                            setMonitoringGuidelines(updated);
                          }}
                          className="text-slate-600 hover:text-red-400 flex-shrink-0"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center space-x-2">
                    <Input
                      value={newGuidelineText}
                      onChange={(e) => setNewGuidelineText(e.target.value)}
                      placeholder="Add a guideline..."
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (newGuidelineText) {
                          const updated = [...monitoringGuidelines];
                          updated[gIdx] = {
                            ...updated[gIdx],
                            guidelines: [...updated[gIdx].guidelines, newGuidelineText],
                          };
                          setMonitoringGuidelines(updated);
                          setNewGuidelineText('');
                        }
                      }}
                      disabled={!newGuidelineText}
                    >
                      Add
                    </Button>
                  </div>
                </div>
              ))}

              <div className="flex items-end space-x-2">
                <div className="flex-1">
                  <Input
                    label="New Guideline Set Name"
                    value={newGuidelineName}
                    onChange={(e) => setNewGuidelineName(e.target.value)}
                    placeholder="e.g., response_quality"
                  />
                </div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (newGuidelineName) {
                      setMonitoringGuidelines([...monitoringGuidelines, { name: newGuidelineName, guidelines: [] }]);
                      setNewGuidelineName('');
                    }
                  }}
                  disabled={!newGuidelineName}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add Set
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Environment Variables */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Variable className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Environment Variables</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEnvVars([...envVars, { name: '', source: 'variable', value: '', variableRef: '' }])}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Variable
          </Button>
        </div>
        <p className="text-sm text-slate-400">
          Configure environment variables for your application. Values can reference configured variables or be set manually.
        </p>

        {envVars.length === 0 ? (
          <div className="bg-slate-800/50 rounded-lg p-3 text-slate-400 text-sm">
            No environment variables configured. Add variables to set runtime configuration.
          </div>
        ) : (
          <div className="space-y-3">
            {envVars.map((envVar, index) => (
              <div key={index} className="p-3 bg-slate-800/30 rounded-lg border border-slate-700 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 grid grid-cols-2 gap-3">
                    {/* Variable Name */}
                    <Input
                      label="Name"
                      placeholder="e.g., API_KEY"
                      value={envVar.name}
                      onChange={(e) => {
                        const newEnvVars = [...envVars];
                        newEnvVars[index].name = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                        setEnvVars(newEnvVars);
                      }}
                    />
                    
                    {/* Value Source Toggle + Value */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-slate-300">Value</label>
                        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              const newEnvVars = [...envVars];
                              newEnvVars[index].source = 'variable';
                              newEnvVars[index].value = '';
                              setEnvVars(newEnvVars);
                            }}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                              envVar.source === 'variable'
                                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                : 'text-slate-400 border border-transparent hover:text-slate-300'
                            }`}
                          >
                            Variable
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const newEnvVars = [...envVars];
                              newEnvVars[index].source = 'manual';
                              newEnvVars[index].variableRef = '';
                              setEnvVars(newEnvVars);
                            }}
                            className={`px-2 py-0.5 text-[10px] rounded-md font-medium transition-all duration-150 ${
                              envVar.source === 'manual'
                                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                : 'text-slate-400 border border-transparent hover:text-slate-300'
                            }`}
                          >
                            Manual
                          </button>
                        </div>
                      </div>
                      
                      {envVar.source === 'variable' ? (
                        <Select
                          value={envVar.variableRef}
                          onChange={(e) => {
                            const newEnvVars = [...envVars];
                            newEnvVars[index].variableRef = e.target.value;
                            setEnvVars(newEnvVars);
                          }}
                          options={[
                            { value: '', label: 'Select a variable...' },
                            ...Object.keys(config.variables || {}).map((v) => ({ value: v, label: v })),
                          ]}
                        />
                      ) : (
                        <Input
                          value={envVar.value}
                          onChange={(e) => {
                            const newEnvVars = [...envVars];
                            newEnvVars[index].value = e.target.value;
                            setEnvVars(newEnvVars);
                          }}
                          placeholder="Enter value..."
                        />
                      )}
                    </div>
                  </div>
                  
                  <button
                    type="button"
                    onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}
                    className="ml-3 mt-6 text-slate-400 hover:text-red-400"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                
                {/* Preview */}
                {envVar.name && (
                  <div className="text-xs text-slate-500">
                    YAML: <code className="bg-slate-900/50 px-1 rounded text-slate-400">
                      {envVar.name}: {envVar.source === 'variable' && envVar.variableRef 
                        ? `*${envVar.variableRef}` 
                        : envVar.value || '""'}
                    </code>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {Object.keys(config.variables || {}).length === 0 && (
          <p className="text-xs text-slate-500">
            Configure variables in the Variables section to reference them here.
          </p>
        )}
      </Card>

      {/* Tags */}
      <Card className="space-y-4">
        <div className="flex items-center space-x-2">
          <Tag className="w-5 h-5 text-slate-400" />
          <h3 className="font-medium text-white">Tags</h3>
        </div>
        <p className="text-sm text-slate-400">
          Add metadata tags to your application for organization and filtering
        </p>

        {/* Existing Tags */}
        {Object.keys(tags).length > 0 && (
          <div className="space-y-2">
            {Object.entries(tags).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between p-2 bg-slate-800/50 rounded-lg border border-slate-700">
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-medium text-blue-400">{key}</span>
                  <span className="text-slate-500">=</span>
                  <span className="text-sm text-slate-300">{String(value)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const newTags = { ...tags };
                    delete newTags[key];
                    setTags(newTags);
                  }}
                  className="text-slate-400 hover:text-red-400"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add New Tag */}
        <div className="flex items-end space-x-2">
          <div className="flex-1">
            <Input
              label="Key"
              placeholder="e.g., environment"
              value={newTagKey}
              onChange={(e) => setNewTagKey(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <Input
              label="Value"
              placeholder="e.g., production"
              value={newTagValue}
              onChange={(e) => setNewTagValue(e.target.value)}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              if (newTagKey && newTagValue) {
                setTags({ ...tags, [newTagKey]: newTagValue });
                setNewTagKey('');
                setNewTagValue('');
              }
            }}
            disabled={!newTagKey || !newTagValue}
          >
            <Plus className="w-4 h-4" />
            Add
          </Button>
        </div>
      </Card>

      {/* Permissions */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Users className="w-5 h-5 text-slate-400" />
            <h3 className="font-medium text-white">Permissions</h3>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPermissions([...permissions, { principals: [], entitlements: [] }])}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Permission
          </Button>
        </div>
        <p className="text-sm text-slate-400">
          Configure who can access this application and with what permissions
        </p>

        {permissions.length === 0 ? (
          <div className="bg-slate-800/50 rounded-lg p-3 text-slate-400 text-sm">
            No permissions configured. Add permissions to control access to this application.
          </div>
        ) : (
          <div className="space-y-3">
            {permissions.map((perm, index) => (
              <div key={index} className="p-3 bg-slate-800/30 rounded-lg border border-slate-700 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-300">Permission Rule {index + 1}</span>
                  <button
                    type="button"
                    onClick={() => setPermissions(permissions.filter((_, i) => i !== index))}
                    className="text-slate-400 hover:text-red-400"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Principals */}
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-400">Principals (users, groups, service principals)</label>
                  <div className="flex flex-wrap gap-2 min-h-[32px]">
                    {perm.principals.map((principal, pIdx) => (
                      <span
                        key={pIdx}
                        className="inline-flex items-center px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs"
                      >
                        {principal}
                        <button
                          type="button"
                          onClick={() => {
                            const newPerms = [...permissions];
                            newPerms[index].principals = perm.principals.filter((_, i) => i !== pIdx);
                            setPermissions(newPerms);
                          }}
                          className="ml-1.5 hover:text-white"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex space-x-2">
                    <Input
                      placeholder="e.g., user@example.com or group_name"
                      value={newPrincipal}
                      onChange={(e) => setNewPrincipal(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (newPrincipal) {
                          const newPerms = [...permissions];
                          newPerms[index].principals = [...perm.principals, newPrincipal];
                          setPermissions(newPerms);
                          setNewPrincipal('');
                        }
                      }}
                      disabled={!newPrincipal}
                    >
                      Add
                    </Button>
                  </div>
                </div>

                {/* Entitlements */}
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-400">Entitlements</label>
                  <div className="flex flex-wrap gap-2">
                    {ENTITLEMENT_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          const newPerms = [...permissions];
                          if (perm.entitlements.includes(opt.value)) {
                            newPerms[index].entitlements = perm.entitlements.filter(e => e !== opt.value);
                          } else {
                            newPerms[index].entitlements = [...perm.entitlements, opt.value];
                          }
                          setPermissions(newPerms);
                        }}
                        className={clsx(
                          'px-2.5 py-1 rounded-lg text-xs transition-colors',
                          perm.entitlements.includes(opt.value)
                            ? 'bg-green-500/30 text-green-300 border border-green-500/50'
                            : 'bg-slate-700 text-slate-400 border border-slate-600 hover:border-slate-500'
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Summary */}
      <Card variant="highlight">
        <h3 className="font-medium text-white mb-3">Configuration Summary</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-slate-400">Application:</span>
            <span className="text-white ml-2">{formData.name || 'Not set'}</span>
          </div>
          <div>
            <span className="text-slate-400">Agents:</span>
            <Badge variant={selectedAgents.length > 0 ? 'success' : 'warning'} className="ml-2">
              {selectedAgents.length} selected
            </Badge>
          </div>
          <div>
            <span className="text-slate-400">Orchestration:</span>
            <Badge variant={pattern !== 'none' ? 'info' : 'default'} className="ml-2">
              {pattern === 'supervisor' ? 'Supervisor' : pattern === 'swarm' ? 'Swarm' : 'None'}
            </Badge>
          </div>
          <div>
            <span className="text-slate-400">Endpoint:</span>
            <span className="text-white ml-2">{formData.endpointName || 'Not set'}</span>
          </div>
        </div>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end items-center space-x-3">
        {!hasChanges && isValid && (
          <span className="text-sm text-slate-500">No unsaved changes</span>
        )}
        {!isValid && hasChanges && (
          <div className="text-sm text-amber-400 flex items-center gap-2">
            <span>Missing required fields:</span>
            <span>{validationErrors.join(', ')}</span>
          </div>
        )}
        <Button onClick={handleSave} size="lg" disabled={!canSave}>
          <Save className="w-4 h-4" />
          Save Configuration
        </Button>
      </div>
    </div>
  );
}
