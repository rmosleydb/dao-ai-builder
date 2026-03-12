import { useState, ChangeEvent } from 'react';
import { Plus, Trash2, Wrench, RefreshCw, Database, MessageSquare, Search, Clock, Bot, Link2, UserCheck, ChevronDown, ChevronUp, Pencil, Mail, Table2, Timer, Calculator, Code, BarChart3 } from 'lucide-react';
import { useConfigStore } from '@/stores/configStore';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Textarea from '../ui/Textarea';
import Card from '../ui/Card';
import Modal from '../ui/Modal';
import Badge from '../ui/Badge';
import { ToolFunctionModel, McpFunctionModel, HumanInTheLoopModel, UnityCatalogFunctionModel } from '@/types/dao-ai-types';
import { CatalogSelect, SchemaSelect, GenieSpaceSelect, VectorSearchEndpointSelect, UCConnectionSelect, DatabricksAppSelect } from '../ui/DatabricksSelect';
import { useFunctions, useVectorSearchIndexes, useConnectionStatus, useGenieSpaces } from '@/hooks/useDatabricks';
import { normalizeRefNameWhileTyping } from '@/utils/name-utils';
import { safeDelete } from '@/utils/safe-delete';
import { useYamlScrollStore } from '@/stores/yamlScrollStore';
import { getYamlReferences } from '@/utils/yaml-references';

// Resource source toggle type
type ResourceSource = 'configured' | 'select';

// Credential source toggle type (for sensitive fields like passwords)
type CredentialSource = 'manual' | 'variable';

/**
 * Extract the displayable string value from a VariableValue.
 * Handles primitive strings, variable references, and env/secret objects.
 */
function getVariableDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Environment variable: { env: "VAR_NAME", default_value?: "xxx" }
    if ('env' in obj && typeof obj.env === 'string') {
      const defaultVal = obj.default_value;
      if (defaultVal !== undefined && defaultVal !== null) {
        return String(defaultVal);
      }
      return `$${obj.env}`;
    }
    // Secret variable: { scope: "xxx", secret: "yyy" }
    if ('scope' in obj && 'secret' in obj) {
      return `{{secrets/${obj.scope}/${obj.secret}}}`;
    }
    // Primitive variable: { type: "primitive", value: "xxx" }
    if ('type' in obj && obj.type === 'primitive' && 'value' in obj) {
      return String(obj.value);
    }
    // If it has a default_value, use that
    if ('default_value' in obj && obj.default_value !== undefined) {
      return String(obj.default_value);
    }
  }
  return '';
}

// Credential input component with variable selection for sensitive fields
interface CredentialInputProps {
  label: string;
  source: CredentialSource;
  onSourceChange: (source: CredentialSource) => void;
  manualValue: string;
  onManualChange: (value: string) => void;
  variableValue: string;
  onVariableChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  required?: boolean;
  variables: Record<string, any>;
}

function CredentialInput({
  label,
  source,
  onSourceChange,
  manualValue,
  onManualChange,
  variableValue,
  onVariableChange,
  placeholder,
  type = 'text',
  hint,
  required = false,
  variables,
}: CredentialInputProps) {
  const variableNames = Object.keys(variables);
  
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-slate-300">
          {label}
          {required && <span className="text-red-400 ml-1">*</span>}
        </label>
        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
          <button
            type="button"
            onClick={() => onSourceChange('variable')}
            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'variable'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Variable
          </button>
          <button
            type="button"
            onClick={() => onSourceChange('manual')}
            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'manual'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Manual
          </button>
        </div>
      </div>
      
      {source === 'variable' ? (
        <Select
          value={variableValue}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onVariableChange(e.target.value)}
          options={[
            { value: '', label: 'Select a variable...' },
            ...variableNames.map((name) => ({
              value: name,
              label: name,
            })),
          ]}
          hint={variableNames.length === 0 ? 'Define variables in the Variables section first' : hint}
          required={required}
        />
      ) : (
        <Input
          value={manualValue}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onManualChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          hint={hint}
          required={required}
        />
      )}
    </div>
  );
}

// Helper component for resource selection with toggle between configured and direct selection
interface ResourceSelectorProps {
  label: string;
  resourceType: string;
  configuredOptions: { value: string; label: string }[];
  configuredValue: string;
  onConfiguredChange: (value: string) => void;
  source: ResourceSource;
  onSourceChange: (source: ResourceSource) => void;
  children: React.ReactNode; // The direct selection component
  hint?: string;
}

function ResourceSelector({ 
  label, 
  resourceType, 
  configuredOptions, 
  configuredValue, 
  onConfiguredChange, 
  source, 
  onSourceChange, 
  children,
  hint 
}: ResourceSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-slate-300">{label}</label>
        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
          <button
            type="button"
            onClick={() => onSourceChange('configured')}
            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'configured'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Configured
          </button>
          <button
            type="button"
            onClick={() => onSourceChange('select')}
            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'select'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Select
          </button>
        </div>
      </div>
      
      {source === 'configured' ? (
        <div className="space-y-1">
          <Select
            options={[
              { value: '', label: `Select configured ${resourceType}...` },
              ...configuredOptions
            ]}
            value={configuredValue}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => onConfiguredChange(e.target.value)}
          />
          {configuredOptions.length === 0 && (
            <p className="text-xs text-amber-400">
              No {resourceType}s configured. Add one in Resources section or switch to "Select".
            </p>
          )}
        </div>
      ) : (
        children
      )}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const TOOL_TYPES = [
  { value: 'factory', label: 'Factory Function' },
  { value: 'python', label: 'Python Function' },
  { value: 'inline', label: 'Inline Function' },
  { value: 'unity_catalog', label: 'Unity Catalog Function' },
  { value: 'mcp', label: 'MCP Server' },
];

// Factory tools available in dao_ai.tools
const FACTORY_TOOLS = [
  { 
    value: 'dao_ai.tools.create_genie_tool', 
    label: 'Genie Tool',
    description: 'Query data using natural language via Databricks Genie',
    icon: MessageSquare,
  },
  { 
    value: 'dao_ai.tools.create_vector_search_tool', 
    label: 'Vector Search Tool',
    description: 'Semantic search over documents using vector embeddings',
    icon: Search,
  },
  { 
    value: 'dao_ai.tools.create_search_tool', 
    label: 'Web Search Tool',
    description: 'Search the web using DuckDuckGo',
    icon: Search,
  },
  { 
    value: 'dao_ai.tools.create_execute_statement_tool', 
    label: 'SQL Statement Tool',
    description: 'Execute a pre-configured SQL statement against a warehouse',
    icon: Table2,
  },
  { 
    value: 'dao_ai.tools.create_send_email_tool', 
    label: 'Email Tool',
    description: 'Send emails via SMTP',
    icon: Mail,
  },
  { 
    value: 'dao_ai.tools.create_send_slack_message_tool', 
    label: 'Slack Message Tool',
    description: 'Send messages to Slack channels',
    icon: MessageSquare,
  },
  { 
    value: 'dao_ai.tools.create_agent_endpoint_tool', 
    label: 'Agent Endpoint Tool',
    description: 'Call another deployed agent endpoint',
    icon: Bot,
  },
  { 
    value: 'dao_ai.tools.create_visualization_tool', 
    label: 'Visualization Tool',
    description: 'Generate Vega-Lite chart specs from structured data',
    icon: BarChart3,
  },
  { 
    value: 'custom', 
    label: 'Custom Factory...',
    description: 'Specify a custom factory function path',
    icon: Wrench,
  },
];

// Python tools (decorated with @tool, used directly without factory args)
const PYTHON_TOOLS = [
  { 
    value: 'dao_ai.tools.current_time_tool', 
    label: 'Current Time',
    description: 'Get the current date and time',
    icon: Clock,
  },
  { 
    value: 'dao_ai.tools.time_in_timezone_tool', 
    label: 'Time in Timezone',
    description: 'Get time in a specific timezone',
    icon: Clock,
  },
  { 
    value: 'dao_ai.tools.add_time_tool', 
    label: 'Add Time',
    description: 'Add days, hours, or minutes to a datetime',
    icon: Timer,
  },
  { 
    value: 'dao_ai.tools.time_difference_tool', 
    label: 'Time Difference',
    description: 'Calculate the difference between two datetimes',
    icon: Calculator,
  },
  { 
    value: 'dao_ai.tools.is_business_hours_tool', 
    label: 'Business Hours Check',
    description: 'Check if a time falls within business hours',
    icon: Clock,
  },
  { 
    value: 'dao_ai.tools.format_time_tool', 
    label: 'Format Time',
    description: 'Format datetime strings in various formats',
    icon: Clock,
  },
  { 
    value: 'dao_ai.tools.time_until_tool', 
    label: 'Time Until',
    description: 'Calculate time remaining until a target datetime',
    icon: Timer,
  },
  { 
    value: 'custom', 
    label: 'Custom Python Function...',
    description: 'Specify a custom Python function path',
    icon: Wrench,
  },
];

// Partial argument entry for Unity Catalog tools
type PartialArgSource = 'manual' | 'variable' | 'service_principal';
interface PartialArgEntry {
  id: string;
  name: string;
  source: PartialArgSource;
  value: string; // For manual: the value, for variable/sp: the ref name
}

// MCP tool source types
const MCP_SOURCE_TYPES = [
  { value: 'url', label: 'Direct URL', description: 'Connect to any MCP server via URL' },
  { value: 'app', label: 'Databricks App', description: 'MCP server hosted in a Databricks App' },
  { value: 'genie', label: 'Genie Room', description: 'Databricks Genie MCP server' },
  { value: 'vector_search', label: 'Vector Search', description: 'Databricks Vector Search MCP server' },
  { value: 'functions', label: 'UC Functions', description: 'Unity Catalog Functions MCP server' },
  { value: 'sql', label: 'SQL (DBSQL)', description: 'Databricks SQL MCP server' },
  { value: 'connection', label: 'UC Connection', description: 'External MCP server via UC Connection' },
];

interface MCPFormData {
  sourceType: 'url' | 'app' | 'genie' | 'vector_search' | 'functions' | 'sql' | 'connection';
  // URL source
  urlSource: 'manual' | 'variable';  // Manual entry or variable reference
  url: string;  // Manual URL value
  urlVariable: string;  // Variable name for URL
  // App source (Databricks App)
  appSource: ResourceSource;  // 'configured' or 'select'
  appRefName: string;  // Reference to configured Databricks App in resources.apps
  appName: string;  // App name when selecting from available apps
  // Genie source
  genieSource: ResourceSource;
  genieRefName: string; // Reference to configured genie room
  genieSpaceId: string;
  genieName: string;
  genieDescription: string;
  // Vector Search source
  vectorStoreSource: ResourceSource;
  vectorStoreRefName: string; // Reference to configured vector store
  vectorEndpoint: string;
  vectorIndex: string;
  vectorCatalog: string;
  vectorSchema: string;
  // Functions source
  schemaSource: ResourceSource;
  schemaRefName: string; // Reference to configured schema
  functionsCatalog: string;
  functionsSchema: string;
  // Connection source
  connectionSource: ResourceSource;
  connectionRefName: string; // Reference to configured connection
  connectionName: string;
  // Warehouse (for SQL)
  warehouseSource: ResourceSource;
  warehouseRefName: string; // Reference to configured warehouse
  warehouseId: string;
  // Auth credentials (shared)
  useCredentials: boolean;
  credentialsMode: 'service_principal' | 'manual';  // Configured SP or manual credentials
  servicePrincipalRef: string;  // Reference to configured service principal
  // Client ID - variable or manual
  clientIdSource: 'variable' | 'manual';
  clientIdVar: string;
  clientIdManual: string;
  // Client Secret - variable or manual
  clientSecretSource: 'variable' | 'manual';
  clientSecretVar: string;
  clientSecretManual: string;
  // Workspace Host - variable or manual (optional)
  workspaceHostSource: 'variable' | 'manual';
  workspaceHostVar: string;
  workspaceHostManual: string;
  // Tool filtering - include/exclude tools from MCP server
  includeTools: string[];  // Tool names/patterns to include (supports glob: *, ?, [abc])
  excludeTools: string[];  // Tool names/patterns to exclude (takes precedence over include)
  // Available tools from MCP server (populated by refresh)
  availableTools: string[];
  availableToolsLoading: boolean;
  availableToolsError: string;  // Error message if refresh fails
}

const defaultMCPFormData: MCPFormData = {
  sourceType: 'url',
  urlSource: 'manual',
  url: '',
  urlVariable: '',
  appSource: 'configured',
  appRefName: '',
  appName: '',
  genieSource: 'select',
  genieRefName: '',
  genieSpaceId: '',
  genieName: '',
  genieDescription: '',
  vectorStoreSource: 'select',
  vectorStoreRefName: '',
  vectorEndpoint: '',
  vectorIndex: '',
  vectorCatalog: '',
  vectorSchema: '',
  schemaSource: 'select',
  schemaRefName: '',
  functionsCatalog: '',
  functionsSchema: '',
  connectionSource: 'select',
  connectionRefName: '',
  connectionName: '',
  warehouseSource: 'select',
  warehouseRefName: '',
  warehouseId: '',
  useCredentials: true,
  credentialsMode: 'service_principal',  // Default to configured service principal
  servicePrincipalRef: '',
  clientIdSource: 'variable',
  clientIdVar: '',
  clientIdManual: '',
  clientSecretSource: 'variable',
  clientSecretVar: '',
  clientSecretManual: '',
  workspaceHostSource: 'variable',
  workspaceHostVar: '',
  workspaceHostManual: '',
  // Tool filtering defaults
  includeTools: [],
  excludeTools: [],
  availableTools: [],
  availableToolsLoading: false,
  availableToolsError: '',
};

interface HITLFormData {
  enabled: boolean;
  reviewPrompt: string;
  allowApprove: boolean;
  allowEdit: boolean;
  allowReject: boolean;
}

const defaultHITLFormData: HITLFormData = {
  enabled: false,
  reviewPrompt: 'Please review the tool call',
  allowApprove: true,
  allowEdit: true,
  allowReject: true,
};

// Helper function to generate a tool name from a function name
function generateToolName(functionName: string): string {
  // Extract the last part of the function name (after the last dot)
  const parts = functionName.split('.');
  let baseName = parts[parts.length - 1];
  
  // Remove common prefixes like 'create_' and suffixes like '_tool'
  baseName = baseName
    .replace(/^create_/, '')
    .replace(/_tool$/, '');
  
  // Normalize: lowercase, replace spaces/special chars with underscores
  const normalized = baseName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  
  // Append _tool suffix
  return normalized ? `${normalized}_tool` : '';
}

/**
 * Generate a normalized name for MCP tools based on the resource type and identifier.
 * Used to auto-populate reference name and tool name when selecting MCP resources.
 * 
 * @param sourceType - The MCP source type (genie, vector_search, functions, etc.)
 * @param identifier - The resource identifier (name, space_id, catalog/schema, etc.)
 * @returns A normalized tool name with appropriate suffix
 */
function generateMcpToolName(sourceType: string, identifier: string): string {
  if (!identifier) return '';
  
  // Normalize the identifier: lowercase, replace non-alphanumeric with underscores
  let normalized = identifier
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  
  // Add source-specific suffix based on the MCP type
  let suffix = '';
  switch (sourceType) {
    case 'genie':
      suffix = '_genie_tool';
      break;
    case 'vector_search':
      suffix = '_vector_search_tool';
      break;
    case 'functions':
      suffix = '_uc_functions_tool';
      break;
    case 'sql':
      suffix = '_sql_tool';
      break;
    case 'app':
      suffix = '_app_tool';
      break;
    case 'connection':
      suffix = '_connection_tool';
      break;
    case 'url':
      suffix = '_mcp_tool';
      break;
    default:
      suffix = '_tool';
  }
  
  return normalized ? `${normalized}${suffix}` : '';
}

export default function ToolsSection() {
  const { config, addTool, updateTool, removeTool } = useConfigStore();
  const { data: connectionStatus } = useConnectionStatus();
  const databricksHost = connectionStatus?.host;
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    refName: '', // YAML key (reference name) - independent of tool name
    name: '',    // Tool's internal name
    type: 'factory' as 'factory' | 'python' | 'unity_catalog' | 'mcp' | 'inline',
    functionName: '',
    customFunctionName: '',
    args: '{}',
    // For inline function type (new in dao-ai 0.1.21)
    inlineCode: '',
    // For Genie tool - with resource source
    genieSource: 'configured' as ResourceSource, // Default to configured
    genieRefName: '', // Reference to configured genie room
    genieSpaceId: '',
    geniePersistConversation: true, // Default to true per factory function
    genieTruncateResults: false, // Default to false per factory function
    // Genie LRU Cache
    genieLruCacheEnabled: false,
    genieLruCacheCapacity: 1000,
    genieLruCacheTtl: 86400, // 1 day in seconds
    genieLruCacheTtlNeverExpires: false,
    genieLruCacheWarehouseSource: 'configured' as ResourceSource,
    genieLruCacheWarehouseRefName: '',
    genieLruCacheWarehouseId: '',
    // Genie Semantic Cache (PostgreSQL-backed context-aware cache)
    genieSemanticCacheEnabled: false,
    genieSemanticCacheTtl: 86400, // 1 day in seconds
    genieSemanticCacheTtlNeverExpires: false,
    genieSemanticCacheSimilarityThreshold: 0.85,
    genieSemanticCacheContextSimilarityThreshold: 0.80, // Conversation-aware: context similarity
    genieSemanticCacheQuestionWeight: 0.6, // Conversation-aware: question weight
    genieSemanticCacheContextWeight: 0.4, // Conversation-aware: context weight (computed as 1 - question_weight)
    genieSemanticCacheContextWindowSize: 4, // Conversation-aware: number of previous turns (default: 4)
    genieSemanticCacheMaxContextTokens: 2000, // Conversation-aware: max context length
    genieSemanticCacheEmbeddingModelSource: 'configured' as ResourceSource,
    genieSemanticCacheEmbeddingModelRefName: '',
    genieSemanticCacheEmbeddingModelManual: 'databricks-gte-large-en',
    genieSemanticCacheTableName: 'genie_context_aware_cache',
    genieSemanticCacheDatabaseSource: 'configured' as ResourceSource,
    genieSemanticCacheDatabaseRefName: '',
    genieSemanticCacheWarehouseSource: 'configured' as ResourceSource,
    genieSemanticCacheWarehouseRefName: '',
    genieSemanticCacheWarehouseId: '',
    // Prompt history settings (PostgreSQL-backed cache)
    genieSemanticCachePromptHistoryTable: 'genie_prompt_history',
    genieSemanticCacheMaxPromptHistoryLength: 50,
    genieSemanticCacheUseGenieApiForHistory: false,
    genieSemanticCachePromptHistoryTtlEnabled: false, // false = use cache TTL (null)
    genieSemanticCachePromptHistoryTtl: 86400,
    // IVFFlat index tuning (PostgreSQL-backed cache)
    genieSemanticCacheIvfflatListsAuto: true, // true = null (auto-computed)
    genieSemanticCacheIvfflatLists: 100,
    genieSemanticCacheIvfflatProbesAuto: true, // true = null (auto-computed)
    genieSemanticCacheIvfflatProbes: 10,
    genieSemanticCacheIvfflatCandidates: 20,
    // Genie In-Memory Semantic Cache (new in dao-ai 0.1.21 - no database required)
    genieInMemoryCacheEnabled: false,
    genieInMemoryCacheTtl: 604800, // 1 week in seconds (default)
    genieInMemoryCacheTtlNeverExpires: false,
    genieInMemoryCacheCapacity: 10000, // Default max cache entries
    genieInMemoryCacheCapacityUnlimited: false,
    genieInMemoryCacheSimilarityThreshold: 0.85,
    genieInMemoryCacheContextSimilarityThreshold: 0.80,
    genieInMemoryCacheQuestionWeight: 0.6,
    genieInMemoryCacheContextWeight: 0.4,
    genieInMemoryCacheContextWindowSize: 3,
    genieInMemoryCacheMaxContextTokens: 2000,
    genieInMemoryCacheEmbeddingModelSource: 'configured' as ResourceSource,
    genieInMemoryCacheEmbeddingModelRefName: '',
    genieInMemoryCacheEmbeddingModelManual: 'databricks-gte-large-en',
    genieInMemoryCacheWarehouseSource: 'configured' as ResourceSource,
    genieInMemoryCacheWarehouseRefName: '',
    genieInMemoryCacheWarehouseId: '',
    // For Warehouse - with resource source
    warehouseSource: 'configured' as ResourceSource, // Default to configured
    warehouseRefName: '', // Reference to configured warehouse
    warehouseId: '',
    // For Vector Search tool - source type toggle
    vectorSearchSourceType: 'retriever' as 'retriever' | 'vector_store',
    // Retriever source (full retriever with search params and reranking)
    retrieverSource: 'configured' as ResourceSource, // Default to configured
    retrieverRefName: '', // Reference to configured retriever
    vectorEndpoint: '', // For manual retriever config
    vectorIndex: '', // For manual retriever config
    // Vector Store source (direct reference with default search params)
    vectorStoreSource: 'configured' as ResourceSource,
    vectorStoreRefName: '', // Reference to configured vector store
    vsVectorEndpoint: '', // For manual vector store config
    vsVectorIndex: '', // For manual vector store config
    vsVectorCatalog: '',
    vsVectorSchema: '',
    // For Unity Catalog function - with resource source
    schemaSource: 'configured' as ResourceSource, // Default to configured
    schemaRefName: '', // Reference to configured schema
    ucCatalog: '',
    ucSchema: '',
    // For Function - with resource source
    functionSource: 'configured' as ResourceSource, // Default to configured
    functionRefName: '', // Reference to configured function
    ucFunction: '',
    // For Slack Message tool
    slackConnectionSource: 'configured' as ResourceSource,
    slackConnectionRefName: '',
    slackChannelId: '',
    slackChannelName: '',
    // For Agent Endpoint tool
    agentLlmSource: 'configured' as ResourceSource,
    agentLlmRefName: '',
    // For Vector Search tool - description is already handled via name
    vectorSearchDescription: '',
    // For Unity Catalog tool - partial args
    ucPartialArgs: [] as PartialArgEntry[],
    // For Email tool (create_send_email_tool)
    emailHost: 'smtp.gmail.com',
    emailHostSource: 'manual' as CredentialSource,
    emailHostVariable: '',
    emailPort: '587',
    emailPortSource: 'manual' as CredentialSource,
    emailPortVariable: '',
    emailUsername: '',
    emailUsernameSource: 'manual' as CredentialSource,
    emailUsernameVariable: '',
    emailPassword: '',
    emailPasswordSource: 'manual' as CredentialSource,
    emailPasswordVariable: '',
    emailSenderEmail: '',
    emailSenderEmailSource: 'manual' as CredentialSource,
    emailSenderEmailVariable: '',
    emailUseTls: true,
    emailToolName: '',
    emailToolDescription: '',
  });
  
  const [mcpForm, setMcpForm] = useState<MCPFormData>(defaultMCPFormData);
  const [hitlForm, setHitlForm] = useState<HITLFormData>(defaultHITLFormData);
  const [showHitlConfig, setShowHitlConfig] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [refNameManuallyEdited, setRefNameManuallyEdited] = useState(false);

  // Get configured resources from store
  const configuredGenieRooms = config.resources?.genie_rooms || {};
  const configuredVectorStores = config.resources?.vector_stores || {};
  const configuredRetrievers = config.retrievers || {};
  const configuredSchemas = config.schemas || {};
  const configuredFunctions = config.resources?.functions || {};
  const configuredConnections = config.resources?.connections || {};
  const configuredLlms = config.resources?.llms || {};
  const configuredWarehouses = config.resources?.warehouses || {};
  const configuredDatabases = config.resources?.databases || {};

  // Helper functions to find configured resources by matching properties
  const findConfiguredGenieRoom = (genieRoom: { space_id?: unknown; name?: string }): string | null => {
    for (const [key, room] of Object.entries(configuredGenieRooms)) {
      // Compare space_id values using their display values
      const inputSpaceId = getVariableDisplayValue(genieRoom.space_id);
      const roomSpaceId = getVariableDisplayValue(room.space_id);
      if (inputSpaceId && roomSpaceId && inputSpaceId === roomSpaceId) return key;
      if (genieRoom.name && room.name === genieRoom.name) return key;
    }
    return null;
  };

  const findConfiguredRetriever = (retriever: { vector_store?: unknown }): string | null => {
    // Try to match by vector_store reference or properties
    for (const [key, ret] of Object.entries(configuredRetrievers)) {
      // Simple match by comparing the stringified objects or specific properties
      if (JSON.stringify(ret) === JSON.stringify(retriever)) return key;
    }
    return null;
  };

  const findConfiguredConnection = (connection: { name?: string }): string | null => {
    for (const [key, conn] of Object.entries(configuredConnections)) {
      if (connection.name && conn.name === connection.name) return key;
    }
    return null;
  };

  const findConfiguredLlm = (llm: { name?: string }): string | null => {
    for (const [key, l] of Object.entries(configuredLlms)) {
      if (llm.name && l.name === llm.name) return key;
    }
    return null;
  };

  const findConfiguredWarehouse = (warehouse: { warehouse_id?: unknown }): string | null => {
    for (const [key, wh] of Object.entries(configuredWarehouses)) {
      if (!warehouse.warehouse_id) continue;
      if (typeof warehouse.warehouse_id === 'string' && typeof wh.warehouse_id === 'string') {
        if (warehouse.warehouse_id === wh.warehouse_id) return key;
      } else {
        const a = getVariableDisplayValue(warehouse.warehouse_id);
        const b = getVariableDisplayValue(wh.warehouse_id);
        if (a && a === b) return key;
      }
    }
    return null;
  };

  const findConfiguredDatabase = (database: { name?: string }): string | null => {
    for (const [key, db] of Object.entries(configuredDatabases)) {
      if (database.name && db.name === database.name) return key;
    }
    return null;
  };

  // Helper to find the original reference name for a path using YAML references
  const findOriginalReferenceForPath = (path: string): string | null => {
    const refs = getYamlReferences();
    if (!refs) return null;
    
    // Normalize path for comparison
    const normalizedPath = path.toLowerCase().replace(/-/g, '_');
    
    // Check aliasUsage to see if this path had a reference
    for (const [anchorName, usagePaths] of Object.entries(refs.aliasUsage)) {
      for (const usagePath of usagePaths) {
        const normalizedUsagePath = usagePath.toLowerCase().replace(/-/g, '_');
        // Check for exact match or suffix match
        if (normalizedPath === normalizedUsagePath || 
            normalizedPath.endsWith(normalizedUsagePath) ||
            normalizedUsagePath.endsWith(normalizedPath)) {
          return anchorName;
        }
      }
    }
    
    return null;
  };

  const findConfiguredFunction = (func: { name?: string; schema?: { catalog_name?: string; schema_name?: string } }): string | null => {
    for (const [key, f] of Object.entries(configuredFunctions)) {
      if (func.name && f.name === func.name) {
        // Also check schema match if both have schemas
        if (func.schema && f.schema) {
          const funcSchema = func.schema as { catalog_name?: string; schema_name?: string };
          const fSchema = f.schema as { catalog_name?: string; schema_name?: string };
          if (funcSchema.catalog_name === fSchema.catalog_name && funcSchema.schema_name === fSchema.schema_name) {
            return key;
          }
        } else {
          return key;
        }
      }
    }
    return null;
  };

  // Build options for configured resources
  const configuredAppOptions = Object.entries(config.resources?.apps || {}).map(([key, app]) => ({
    value: key,
    label: `${key} (${app.name})`,
  }));
  const configuredGenieOptions = Object.entries(configuredGenieRooms).map(([key, room]) => ({
    value: key,
    label: `${key} (${room.name || getVariableDisplayValue(room.space_id)})`,
  }));
  const configuredVectorStoreOptions = Object.entries(configuredVectorStores).map(([key]) => ({
    value: key,
    label: key,
  }));
  const configuredRetrieverOptions = Object.entries(configuredRetrievers).map(([key, retriever]) => ({
    value: key,
    label: `${key} (${retriever.search_parameters?.num_results || 10} results)`,
  }));
  const configuredSchemaOptions = Object.entries(configuredSchemas).map(([key, schema]) => ({
    value: key,
    label: `${key} (${getVariableDisplayValue(schema.catalog_name)}.${getVariableDisplayValue(schema.schema_name)})`,
  }));
  const configuredFunctionOptions = Object.entries(configuredFunctions).map(([key, func]) => ({
    value: key,
    label: `${key} (${func.name})`,
  }));
  const configuredConnectionOptions = Object.entries(configuredConnections).map(([key, conn]) => ({
    value: key,
    label: `${key} (${conn.name})`,
  }));
  const configuredLlmOptions = Object.entries(configuredLlms).map(([key, llm]) => ({
    value: key,
    label: `${key} (${llm.name || key})`,
  }));
  const configuredWarehouseOptions = Object.entries(configuredWarehouses).map(([key, wh]) => ({
    value: key,
    label: `${key} (${wh.name || key})`,
  }));
  const configuredDatabaseOptions = Object.entries(configuredDatabases).map(([key, db]) => ({
    value: key,
    label: `${key} (${db.name || key})`,
  }));

  const tools = config.tools || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};

  // Get available variable names for dropdowns
  const variableNames = Object.keys(variables);
  const servicePrincipalNames = Object.keys(servicePrincipals);

  // Options for variable and service principal selects
  const variableOptions = [
    { value: '', label: 'Select a variable...' },
    ...variableNames.map(v => ({ value: v, label: v })),
  ];
  const servicePrincipalOptions = [
    { value: '', label: 'Select a service principal...' },
    ...servicePrincipalNames.map(sp => ({ value: sp, label: sp })),
  ];

  // Fetch UC functions when catalog/schema selected
  const { data: ucFunctions, loading: ucFunctionsLoading, refetch: refetchFunctions } = useFunctions(
    formData.ucCatalog || null,
    formData.ucSchema || null
  );

  // Fetch vector search indexes when endpoint selected
  const { data: vectorIndexes, loading: vectorIndexesLoading, refetch: refetchIndexes } = useVectorSearchIndexes(
    formData.vectorEndpoint || null
  );

  // MCP-specific vector search indexes
  const { data: mcpVectorIndexes, loading: mcpVectorIndexesLoading, refetch: refetchMcpIndexes } = useVectorSearchIndexes(
    mcpForm.vectorEndpoint || null
  );

  // Genie spaces for auto-populating name/description
  const { data: genieSpaces } = useGenieSpaces();

  const buildHITLConfig = (): HumanInTheLoopModel | undefined => {
    if (!hitlForm.enabled) return undefined;

    const allowedDecisions: ("approve" | "edit" | "reject")[] = [];
    if (hitlForm.allowApprove) allowedDecisions.push("approve");
    if (hitlForm.allowEdit) allowedDecisions.push("edit");
    if (hitlForm.allowReject) allowedDecisions.push("reject");

    const config: HumanInTheLoopModel = {
      review_prompt: hitlForm.reviewPrompt || undefined,
      allowed_decisions: allowedDecisions.length > 0 ? allowedDecisions : undefined,
    };

    return config;
  };

  const buildMcpFunction = (): McpFunctionModel => {
    const base: McpFunctionModel = {
      type: 'mcp',
      // NOTE: 'name' is at the tool level (ToolModel), not in the function
    };

    // Add credentials if enabled
    if (mcpForm.useCredentials) {
      if (mcpForm.credentialsMode === 'service_principal' && mcpForm.servicePrincipalRef) {
        base.service_principal = `*${mcpForm.servicePrincipalRef}` as any;
      } else if (mcpForm.credentialsMode === 'manual') {
        if (mcpForm.clientIdSource === 'variable' && mcpForm.clientIdVar) {
          base.client_id = `*${mcpForm.clientIdVar}`;
        } else if (mcpForm.clientIdSource === 'manual' && mcpForm.clientIdManual) {
          base.client_id = mcpForm.clientIdManual;
        }
        if (mcpForm.clientSecretSource === 'variable' && mcpForm.clientSecretVar) {
          base.client_secret = `*${mcpForm.clientSecretVar}`;
        } else if (mcpForm.clientSecretSource === 'manual' && mcpForm.clientSecretManual) {
          base.client_secret = mcpForm.clientSecretManual;
        }
        if (mcpForm.workspaceHostSource === 'variable' && mcpForm.workspaceHostVar) {
          base.workspace_host = `*${mcpForm.workspaceHostVar}`;
        } else if (mcpForm.workspaceHostSource === 'manual' && mcpForm.workspaceHostManual) {
          base.workspace_host = mcpForm.workspaceHostManual;
        }
      }
    }

    switch (mcpForm.sourceType) {
      case 'url':
        if (mcpForm.urlSource === 'variable' && mcpForm.urlVariable) {
          base.url = `__REF__${mcpForm.urlVariable}`;
        } else {
          base.url = mcpForm.url;
        }
        break;
      case 'genie':
        // Use reference format if from configured genie room
        if (mcpForm.genieSource === 'configured' && mcpForm.genieRefName) {
          base.genie_room = `*${mcpForm.genieRefName}` as any;
        } else if (mcpForm.genieSource === 'select' && mcpForm.genieSpaceId) {
          // Create inline genie room configuration
          base.genie_room = {
            name: mcpForm.genieName || 'Genie Room',
            space_id: mcpForm.genieSpaceId,
            description: mcpForm.genieDescription || undefined,
          };
        }
        break;
      case 'vector_search':
        // Use reference format if from configured vector store
        if (mcpForm.vectorStoreSource === 'configured' && mcpForm.vectorStoreRefName) {
          base.vector_search = `*${mcpForm.vectorStoreRefName}` as any;
        } else if (mcpForm.vectorStoreSource === 'select' && mcpForm.vectorIndex) {
          // Create inline vector search configuration
          base.vector_search = {
            source_table: {
              schema: {
                catalog_name: mcpForm.vectorCatalog,
                schema_name: mcpForm.vectorSchema,
              },
            },
            embedding_source_column: 'content', // Default, can be customized
            index: {
              name: mcpForm.vectorIndex,
            },
            endpoint: {
              name: mcpForm.vectorEndpoint,
            },
          };
        }
        break;
      case 'functions':
        // Use reference format if from configured schema
        if (mcpForm.schemaSource === 'configured' && mcpForm.schemaRefName) {
          base.functions = `*${mcpForm.schemaRefName}` as any;
        } else if (mcpForm.functionsCatalog && mcpForm.functionsSchema) {
          // Create inline schema configuration
          base.functions = {
            catalog_name: mcpForm.functionsCatalog,
            schema_name: mcpForm.functionsSchema,
          };
        }
        break;
      case 'sql':
        base.sql = true;
        break;
      case 'app':
        // Use reference to a configured Databricks App or create inline app config
        if (mcpForm.appSource === 'configured' && mcpForm.appRefName) {
          base.app = `*${mcpForm.appRefName}` as any;
        } else if (mcpForm.appSource === 'select' && mcpForm.appName) {
          base.app = {
            name: mcpForm.appName,
          };
        }
        break;
      case 'connection':
        // Use reference format if from configured connection
        if (mcpForm.connectionSource === 'configured' && mcpForm.connectionRefName) {
          base.connection = `*${mcpForm.connectionRefName}` as any;
        } else if (mcpForm.connectionName) {
          base.connection = {
            name: mcpForm.connectionName,
          };
        }
        break;
    }

    // Add tool filtering if configured
    if (mcpForm.includeTools.length > 0) {
      base.include_tools = mcpForm.includeTools;
    }
    if (mcpForm.excludeTools.length > 0) {
      base.exclude_tools = mcpForm.excludeTools;
    }

    return base;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const funcName = formData.functionName === 'custom' ? formData.customFunctionName : formData.functionName;
    
    // Require both refName and name
    if (!formData.refName.trim() || !formData.name.trim()) return;

    let functionConfig: ToolFunctionModel;
    const hitlConfig = buildHITLConfig();

    if (formData.type === 'factory') {
      let parsedArgs: Record<string, unknown> = {};
      
      // Build args based on selected factory tool
      if (formData.functionName === 'dao_ai.tools.create_genie_tool') {
        // Build base args
        const genieArgs: Record<string, unknown> = {
          name: formData.name,
          description: `Tool for querying via Genie`,
          persist_conversation: formData.geniePersistConversation,
          truncate_results: formData.genieTruncateResults,
        };

        // Add genie_room reference or inline
        if (formData.genieSource === 'configured' && formData.genieRefName) {
          genieArgs.genie_room = `__REF__${formData.genieRefName}`;
        } else {
          genieArgs.genie_room = {
          space_id: formData.genieSpaceId,
          };
        }

        // Add LRU cache parameters if enabled
        if (formData.genieLruCacheEnabled) {
          const lruCacheParams: Record<string, unknown> = {
            capacity: formData.genieLruCacheCapacity,
            time_to_live_seconds: formData.genieLruCacheTtlNeverExpires ? null : formData.genieLruCacheTtl,
          };
          // Add warehouse reference or inline
          if (formData.genieLruCacheWarehouseSource === 'configured' && formData.genieLruCacheWarehouseRefName) {
            lruCacheParams.warehouse = `__REF__${formData.genieLruCacheWarehouseRefName}`;
          } else if (formData.genieLruCacheWarehouseId) {
            lruCacheParams.warehouse = {
              name: 'lru_cache_warehouse',
              warehouse_id: formData.genieLruCacheWarehouseId,
            };
          }
          genieArgs.lru_cache_parameters = lruCacheParams;
        }

        // Add semantic cache parameters if enabled
        if (formData.genieSemanticCacheEnabled) {
          const semanticCacheParams: Record<string, unknown> = {
            time_to_live_seconds: formData.genieSemanticCacheTtlNeverExpires ? null : formData.genieSemanticCacheTtl,
            similarity_threshold: formData.genieSemanticCacheSimilarityThreshold,
            context_similarity_threshold: formData.genieSemanticCacheContextSimilarityThreshold,
            question_weight: formData.genieSemanticCacheQuestionWeight,
            context_weight: formData.genieSemanticCacheContextWeight,
            context_window_size: formData.genieSemanticCacheContextWindowSize,
            max_context_tokens: formData.genieSemanticCacheMaxContextTokens,
            table_name: formData.genieSemanticCacheTableName,
          };
          // Prompt history settings
          if (formData.genieSemanticCachePromptHistoryTable !== 'genie_prompt_history') {
            semanticCacheParams.prompt_history_table = formData.genieSemanticCachePromptHistoryTable;
          }
          if (formData.genieSemanticCacheMaxPromptHistoryLength !== 50) {
            semanticCacheParams.max_prompt_history_length = formData.genieSemanticCacheMaxPromptHistoryLength;
          }
          if (formData.genieSemanticCacheUseGenieApiForHistory) {
            semanticCacheParams.use_genie_api_for_history = true;
          }
          if (formData.genieSemanticCachePromptHistoryTtlEnabled) {
            semanticCacheParams.prompt_history_ttl_seconds = formData.genieSemanticCachePromptHistoryTtl;
          }
          // IVFFlat index tuning settings (only include non-default values)
          if (!formData.genieSemanticCacheIvfflatListsAuto) {
            semanticCacheParams.ivfflat_lists = formData.genieSemanticCacheIvfflatLists;
          }
          if (!formData.genieSemanticCacheIvfflatProbesAuto) {
            semanticCacheParams.ivfflat_probes = formData.genieSemanticCacheIvfflatProbes;
          }
          if (formData.genieSemanticCacheIvfflatCandidates !== 20) {
            semanticCacheParams.ivfflat_candidates = formData.genieSemanticCacheIvfflatCandidates;
          }
          // Add embedding model - configured LLM reference or manual string
          if (formData.genieSemanticCacheEmbeddingModelSource === 'configured' && formData.genieSemanticCacheEmbeddingModelRefName) {
            semanticCacheParams.embedding_model = `__REF__${formData.genieSemanticCacheEmbeddingModelRefName}`;
          } else if (formData.genieSemanticCacheEmbeddingModelManual) {
            semanticCacheParams.embedding_model = formData.genieSemanticCacheEmbeddingModelManual;
          }
          // Add database reference
          if (formData.genieSemanticCacheDatabaseSource === 'configured' && formData.genieSemanticCacheDatabaseRefName) {
            semanticCacheParams.database = `__REF__${formData.genieSemanticCacheDatabaseRefName}`;
          }
          // Add warehouse reference or inline
          if (formData.genieSemanticCacheWarehouseSource === 'configured' && formData.genieSemanticCacheWarehouseRefName) {
            semanticCacheParams.warehouse = `__REF__${formData.genieSemanticCacheWarehouseRefName}`;
          } else if (formData.genieSemanticCacheWarehouseId) {
            semanticCacheParams.warehouse = {
              name: 'semantic_cache_warehouse',
              warehouse_id: formData.genieSemanticCacheWarehouseId,
            };
          }
          genieArgs.context_aware_cache_parameters = semanticCacheParams;
        }

        // Add in-memory semantic cache parameters if enabled (new in dao-ai 0.1.21)
        if (formData.genieInMemoryCacheEnabled) {
          const inMemoryCacheParams: Record<string, unknown> = {
            time_to_live_seconds: formData.genieInMemoryCacheTtlNeverExpires ? null : formData.genieInMemoryCacheTtl,
            similarity_threshold: formData.genieInMemoryCacheSimilarityThreshold,
            context_similarity_threshold: formData.genieInMemoryCacheContextSimilarityThreshold,
            question_weight: formData.genieInMemoryCacheQuestionWeight,
            context_weight: formData.genieInMemoryCacheContextWeight,
            context_window_size: formData.genieInMemoryCacheContextWindowSize,
            max_context_tokens: formData.genieInMemoryCacheMaxContextTokens,
            capacity: formData.genieInMemoryCacheCapacityUnlimited ? null : formData.genieInMemoryCacheCapacity,
          };
          // Add embedding model - configured LLM reference or manual string
          if (formData.genieInMemoryCacheEmbeddingModelSource === 'configured' && formData.genieInMemoryCacheEmbeddingModelRefName) {
            inMemoryCacheParams.embedding_model = `__REF__${formData.genieInMemoryCacheEmbeddingModelRefName}`;
          } else if (formData.genieInMemoryCacheEmbeddingModelManual) {
            inMemoryCacheParams.embedding_model = formData.genieInMemoryCacheEmbeddingModelManual;
          }
          // Add warehouse reference or inline (required)
          if (formData.genieInMemoryCacheWarehouseSource === 'configured' && formData.genieInMemoryCacheWarehouseRefName) {
            inMemoryCacheParams.warehouse = `__REF__${formData.genieInMemoryCacheWarehouseRefName}`;
          } else if (formData.genieInMemoryCacheWarehouseId) {
            inMemoryCacheParams.warehouse = {
              name: 'in_memory_cache_warehouse',
              warehouse_id: formData.genieInMemoryCacheWarehouseId,
            };
          }
          genieArgs.in_memory_context_aware_cache_parameters = inMemoryCacheParams;
        }

        parsedArgs = genieArgs;
      } else if (formData.functionName === 'dao_ai.tools.create_vector_search_tool') {
        // Vector search tool supports either retriever or vector_store (mutually exclusive)
        const baseArgs: Record<string, unknown> = {
          name: formData.name,
          ...(formData.vectorSearchDescription && { description: formData.vectorSearchDescription }),
        };
        
        if (formData.vectorSearchSourceType === 'retriever') {
          // Use retriever (full config with search params and reranking)
          if (formData.retrieverSource === 'configured' && formData.retrieverRefName) {
            parsedArgs = {
              ...baseArgs,
              retriever: `__REF__${formData.retrieverRefName}`,
            };
          } else {
            // Direct selection - use specific fields (index name from endpoint)
            parsedArgs = {
              ...baseArgs,
              index_name: formData.vectorIndex,
            };
          }
        } else {
          // Use vector_store directly (default search params)
          if (formData.vectorStoreSource === 'configured' && formData.vectorStoreRefName) {
            parsedArgs = {
              ...baseArgs,
              vector_store: `__REF__${formData.vectorStoreRefName}`,
            };
          } else {
            // Direct selection - use vector store properties
            parsedArgs = {
              ...baseArgs,
              vector_store: {
                index: { name: formData.vsVectorIndex },
                source_table: {
                  schema: {
                    catalog_name: formData.vsVectorCatalog,
                    schema_name: formData.vsVectorSchema,
                  },
                },
              },
            };
          }
        }
      } else if (formData.functionName === 'dao_ai.tools.create_send_slack_message_tool') {
        // Slack message tool configuration
        const slackArgs: Record<string, unknown> = {
          name: formData.name,
        };
        
        // Add connection reference
        if (formData.slackConnectionSource === 'configured' && formData.slackConnectionRefName) {
          slackArgs.connection = `__REF__${formData.slackConnectionRefName}`;
        }
        
        // Add channel configuration - prefer channel_id if provided, otherwise use channel_name
        if (formData.slackChannelId) {
          slackArgs.channel_id = formData.slackChannelId;
        } else if (formData.slackChannelName) {
          slackArgs.channel_name = formData.slackChannelName;
        }
        
        parsedArgs = slackArgs;
      } else if (formData.functionName === 'dao_ai.tools.create_agent_endpoint_tool') {
        // Agent endpoint tool configuration
        const agentArgs: Record<string, unknown> = {
          name: formData.name,
        };
        
        // Add LLM reference
        if (formData.agentLlmSource === 'configured' && formData.agentLlmRefName) {
          agentArgs.llm = `__REF__${formData.agentLlmRefName}`;
        }
        
        parsedArgs = agentArgs;
      } else if (formData.functionName === 'dao_ai.tools.create_send_email_tool') {
        // Email tool configuration with SMTP config
        const smtpConfig: Record<string, unknown> = {};
        
        // Host - manual or variable
        if (formData.emailHostSource === 'variable' && formData.emailHostVariable) {
          smtpConfig.host = `*${formData.emailHostVariable}`;
        } else {
          smtpConfig.host = formData.emailHost;
        }
        
        // Port - manual or variable
        if (formData.emailPortSource === 'variable' && formData.emailPortVariable) {
          smtpConfig.port = `*${formData.emailPortVariable}`;
        } else {
          smtpConfig.port = parseInt(formData.emailPort) || 587;
        }
        
        // Username - manual or variable
        if (formData.emailUsernameSource === 'variable' && formData.emailUsernameVariable) {
          smtpConfig.username = `*${formData.emailUsernameVariable}`;
        } else {
          smtpConfig.username = formData.emailUsername;
        }
        
        // Password - manual or variable
        if (formData.emailPasswordSource === 'variable' && formData.emailPasswordVariable) {
          smtpConfig.password = `*${formData.emailPasswordVariable}`;
        } else {
          smtpConfig.password = formData.emailPassword;
        }
        
        // Sender email (optional) - manual or variable
        if (formData.emailSenderEmail || formData.emailSenderEmailVariable) {
          if (formData.emailSenderEmailSource === 'variable' && formData.emailSenderEmailVariable) {
            smtpConfig.sender_email = `*${formData.emailSenderEmailVariable}`;
          } else if (formData.emailSenderEmail) {
            smtpConfig.sender_email = formData.emailSenderEmail;
          }
        }
        
        // Use TLS
        smtpConfig.use_tls = formData.emailUseTls;
        
        parsedArgs = {
          smtp_config: smtpConfig,
          ...(formData.emailToolName && { name: formData.emailToolName }),
          ...(formData.emailToolDescription && { description: formData.emailToolDescription }),
        };
      } else {
        try {
          parsedArgs = JSON.parse(formData.args || '{}');
        } catch {
          // Keep empty object if parse fails
        }
      }
      
      functionConfig = {
        type: 'factory',
        name: funcName || formData.functionName,
        args: parsedArgs,
        ...(hitlConfig && { human_in_the_loop: hitlConfig }),
      };
    } else if (formData.type === 'python') {
      functionConfig = {
        type: 'python',
        name: funcName,
        ...(hitlConfig && { human_in_the_loop: hitlConfig }),
      };
    } else if (formData.type === 'inline') {
      // Inline function type (new in dao-ai 0.1.21)
      functionConfig = {
        type: 'inline',
        code: formData.inlineCode,
        ...(hitlConfig && { human_in_the_loop: hitlConfig }),
      };
    } else if (formData.type === 'unity_catalog') {
      // Build partial_args if any are configured
      let partialArgs: Record<string, string> | undefined;
      if (formData.ucPartialArgs.length > 0) {
        partialArgs = {};
        for (const arg of formData.ucPartialArgs) {
          if (arg.name && arg.value) {
            if (arg.source === 'manual') {
              partialArgs[arg.name] = arg.value;
            } else {
              // For variable or service_principal, use __REF__ marker
              partialArgs[arg.name] = `__REF__${arg.value}`;
            }
          }
        }
        if (Object.keys(partialArgs).length === 0) {
          partialArgs = undefined;
        }
      }

      // dao-ai 0.1.2: Use 'resource' field instead of YAML merge (<<: *func_ref)
      if (formData.functionSource === 'configured' && formData.functionRefName) {
        // Reference to configured function in resources.functions
        functionConfig = {
          type: 'unity_catalog',
          resource: formData.functionRefName, // Will be converted to *ref in YAML
          ...(partialArgs && { partial_args: partialArgs }),
          ...(hitlConfig && { human_in_the_loop: hitlConfig }),
        };
      } else {
        // Direct selection - include inline FunctionModel resource
        functionConfig = {
          type: 'unity_catalog',
          resource: {
            schema: {
              catalog_name: formData.ucCatalog,
              schema_name: formData.ucSchema,
            },
            name: formData.ucFunction.split('.').pop() || formData.ucFunction, // Extract just the function name
          },
          ...(partialArgs && { partial_args: partialArgs }),
          ...(hitlConfig && { human_in_the_loop: hitlConfig }),
        };
      }
    } else if (formData.type === 'mcp') {
      // Validate MCP-specific requirements
      if (mcpForm.sourceType === 'connection') {
        const hasConnection = (mcpForm.connectionSource === 'configured' && mcpForm.connectionRefName) ||
                              (mcpForm.connectionSource === 'select' && mcpForm.connectionName);
        if (!hasConnection) {
          return; // Connection is required for connection type
        }
      }
      functionConfig = buildMcpFunction();
      if (hitlConfig) {
        (functionConfig as McpFunctionModel).human_in_the_loop = hitlConfig;
      }
    } else {
      functionConfig = funcName;
    }

    const toolConfig = {
      name: formData.name,
      function: functionConfig,
    };

    // Use refName as the YAML key (if provided), otherwise fall back to name
    const refName = formData.refName.trim() || formData.name;

    if (editingKey) {
      // When editing, we need to handle the case where the reference name changed
      if (editingKey !== refName) {
        // Reference name changed - remove old and add new
        removeTool(editingKey);
        addTool(refName, toolConfig);
      } else {
        // Reference name unchanged - just update
        updateTool(refName, toolConfig);
      }
    } else {
      addTool(refName, toolConfig);
    }
    
    resetForm();
    setIsModalOpen(false);
  };

  const resetForm = () => {
    setFormData({
      refName: '',
      name: '',
      type: 'factory',
      functionName: '',
      customFunctionName: '',
      args: '{}',
      // For inline function type
      inlineCode: '',
      genieSource: 'configured',
      genieRefName: '',
      genieSpaceId: '',
      geniePersistConversation: true,
      genieTruncateResults: false,
      // Genie LRU Cache
      genieLruCacheEnabled: false,
      genieLruCacheCapacity: 1000,
      genieLruCacheTtl: 86400,
      genieLruCacheTtlNeverExpires: false,
      genieLruCacheWarehouseSource: 'configured',
      genieLruCacheWarehouseRefName: '',
      genieLruCacheWarehouseId: '',
      // Genie Semantic Cache (PostgreSQL-backed context-aware cache)
      genieSemanticCacheEnabled: false,
      genieSemanticCacheTtl: 86400,
      genieSemanticCacheTtlNeverExpires: false,
      genieSemanticCacheSimilarityThreshold: 0.85,
      genieSemanticCacheContextSimilarityThreshold: 0.80,
      genieSemanticCacheQuestionWeight: 0.6,
      genieSemanticCacheContextWeight: 0.4,
      genieSemanticCacheContextWindowSize: 4,
      genieSemanticCacheMaxContextTokens: 2000,
      genieSemanticCacheEmbeddingModelSource: 'configured',
      genieSemanticCacheEmbeddingModelRefName: '',
      genieSemanticCacheEmbeddingModelManual: 'databricks-gte-large-en',
      genieSemanticCacheTableName: 'genie_context_aware_cache',
      genieSemanticCacheDatabaseSource: 'configured',
      genieSemanticCacheDatabaseRefName: '',
      genieSemanticCacheWarehouseSource: 'configured',
      genieSemanticCacheWarehouseRefName: '',
      genieSemanticCacheWarehouseId: '',
      // Prompt history settings
      genieSemanticCachePromptHistoryTable: 'genie_prompt_history',
      genieSemanticCacheMaxPromptHistoryLength: 50,
      genieSemanticCacheUseGenieApiForHistory: false,
      genieSemanticCachePromptHistoryTtlEnabled: false,
      genieSemanticCachePromptHistoryTtl: 86400,
      // IVFFlat index tuning
      genieSemanticCacheIvfflatListsAuto: true,
      genieSemanticCacheIvfflatLists: 100,
      genieSemanticCacheIvfflatProbesAuto: true,
      genieSemanticCacheIvfflatProbes: 10,
      genieSemanticCacheIvfflatCandidates: 20,
      // Genie In-Memory Context-Aware Cache
      genieInMemoryCacheEnabled: false,
      genieInMemoryCacheTtl: 604800,
      genieInMemoryCacheTtlNeverExpires: false,
      genieInMemoryCacheCapacity: 10000,
      genieInMemoryCacheCapacityUnlimited: false,
      genieInMemoryCacheSimilarityThreshold: 0.85,
      genieInMemoryCacheContextSimilarityThreshold: 0.80,
      genieInMemoryCacheQuestionWeight: 0.6,
      genieInMemoryCacheContextWeight: 0.4,
      genieInMemoryCacheContextWindowSize: 3,
      genieInMemoryCacheMaxContextTokens: 2000,
      genieInMemoryCacheEmbeddingModelSource: 'configured',
      genieInMemoryCacheEmbeddingModelRefName: '',
      genieInMemoryCacheEmbeddingModelManual: 'databricks-gte-large-en',
      genieInMemoryCacheWarehouseSource: 'configured',
      genieInMemoryCacheWarehouseRefName: '',
      genieInMemoryCacheWarehouseId: '',
      warehouseSource: 'configured',
      warehouseRefName: '',
      warehouseId: '',
      vectorSearchSourceType: 'retriever',
      retrieverSource: 'configured',
      retrieverRefName: '',
      vectorEndpoint: '',
      vectorIndex: '',
      vectorStoreSource: 'configured',
      vectorStoreRefName: '',
      vsVectorEndpoint: '',
      vsVectorIndex: '',
      vsVectorCatalog: '',
      vsVectorSchema: '',
      schemaSource: 'configured',
      schemaRefName: '',
      ucCatalog: '',
      ucSchema: '',
      functionSource: 'configured',
      functionRefName: '',
      ucFunction: '',
      slackConnectionSource: 'configured',
      slackConnectionRefName: '',
      slackChannelId: '',
      slackChannelName: '',
      agentLlmSource: 'configured',
      agentLlmRefName: '',
      vectorSearchDescription: '',
      ucPartialArgs: [],
      // Email tool fields
      emailHost: 'smtp.gmail.com',
      emailHostSource: 'manual',
      emailHostVariable: '',
      emailPort: '587',
      emailPortSource: 'manual',
      emailPortVariable: '',
      emailUsername: '',
      emailUsernameSource: 'manual',
      emailUsernameVariable: '',
      emailPassword: '',
      emailPasswordSource: 'manual',
      emailPasswordVariable: '',
      emailSenderEmail: '',
      emailSenderEmailSource: 'manual',
      emailSenderEmailVariable: '',
      emailUseTls: true,
      emailToolName: '',
      emailToolDescription: '',
    });
    // Set MCP form defaults with proper source defaults based on configured resources
    const hasConfiguredConnections = Object.keys(configuredConnections).length > 0;
    const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
    const hasConfiguredGenieRooms = Object.keys(configuredGenieRooms).length > 0;
    const hasConfiguredVectorStores = Object.keys(configuredVectorStores).length > 0;
    
    setMcpForm({
      ...defaultMCPFormData,
      connectionSource: hasConfiguredConnections ? 'configured' : 'select',
      schemaSource: hasConfiguredSchemas ? 'configured' : 'select',
      genieSource: hasConfiguredGenieRooms ? 'configured' : 'select',
      vectorStoreSource: hasConfiguredVectorStores ? 'configured' : 'select',
    });
    setHitlForm(defaultHITLFormData);
    setShowHitlConfig(false);
    setNameManuallyEdited(false);
    setRefNameManuallyEdited(false);
    setEditingKey(null);
  };

  const { scrollToAsset } = useYamlScrollStore();

  // Handle editing an existing tool
  const handleEdit = (key: string, tool: { name: string; function: string | ToolFunctionModel }) => {
    // Scroll to the asset in YAML preview
    scrollToAsset(key);
    
    setEditingKey(key);
    setNameManuallyEdited(true); // Preserve the name when editing
    setRefNameManuallyEdited(true); // Preserve the reference name when editing
    
    const func = tool.function;
    
    if (typeof func === 'string') {
      // Python function tool (string reference)
      const isPythonTool = PYTHON_TOOLS.some(pt => pt.value === func);
      const isFactoryTool = FACTORY_TOOLS.some(ft => ft.value === func);
      
      setFormData(prev => ({
        ...prev,
        refName: key, // YAML key (reference name)
        name: tool.name,
        type: isPythonTool ? 'python' : (isFactoryTool ? 'factory' : 'python'),
        functionName: isPythonTool || isFactoryTool ? func : 'custom',
        customFunctionName: isPythonTool || isFactoryTool ? '' : func,
      }));
    } else if (typeof func === 'object') {
      const funcType = func.type || 'factory';
      
      // Handle HITL config
      if (func.human_in_the_loop) {
        const hitl = func.human_in_the_loop;
        const allowedDecisions = hitl.allowed_decisions || ['approve', 'edit', 'reject'];
        setShowHitlConfig(true);
        setHitlForm({
          enabled: true,
          reviewPrompt: hitl.review_prompt || 'Please review the tool call',
          allowApprove: allowedDecisions.includes('approve'),
          allowEdit: allowedDecisions.includes('edit'),
          allowReject: allowedDecisions.includes('reject'),
        });
      }
      
      if (funcType === 'factory' && 'args' in func) {
        const factoryFunc = func as { name?: string; args?: Record<string, unknown> };
        const funcName = factoryFunc.name || '';
        const isKnownFactory = FACTORY_TOOLS.some(ft => ft.value === funcName);
        const args = factoryFunc.args || {};
        
        // Determine genie config from args
        let genieSource: ResourceSource = 'configured';
        let genieRefName = '';
        let genieSpaceId = '';
        if (args.genie_room) {
          if (typeof args.genie_room === 'string' && args.genie_room.startsWith('__REF__')) {
            genieRefName = args.genie_room.replace('__REF__', '');
            genieSource = 'configured';
          } else if (typeof args.genie_room === 'object' && args.genie_room !== null) {
            const genieRoom = args.genie_room as { space_id?: string; name?: string };
            // Try to find a matching configured genie room
            const matchingKey = findConfiguredGenieRoom(genieRoom);
            if (matchingKey) {
              genieRefName = matchingKey;
              genieSource = 'configured';
            } else if (genieRoom.space_id) {
              genieSpaceId = getVariableDisplayValue(genieRoom.space_id);
              genieSource = 'select';
            }
          }
        }
        
        // Determine vector search source type (retriever vs vector_store)
        let vectorSearchSourceType: 'retriever' | 'vector_store' = 'retriever';
        let retrieverSource: ResourceSource = 'configured';
        let retrieverRefName = '';
        let vectorIndex = '';
        let vectorStoreSource: ResourceSource = 'configured';
        let vectorStoreRefName = '';
        let vsVectorIndex = '';
        let vsVectorCatalog = '';
        let vsVectorSchema = '';
        
        if (args.vector_store) {
          // Using vector_store directly
          vectorSearchSourceType = 'vector_store';
          if (typeof args.vector_store === 'string' && args.vector_store.startsWith('__REF__')) {
            vectorStoreRefName = args.vector_store.replace('__REF__', '');
            vectorStoreSource = 'configured';
          } else if (typeof args.vector_store === 'object' && args.vector_store !== null) {
            const vs = args.vector_store as { 
              index?: { name?: string }; 
              source_table?: { schema?: { catalog_name?: string; schema_name?: string } };
            };
            // Try to find a matching configured vector store
            const matchingVsKey = Object.entries(configuredVectorStores).find(
              ([, store]) => store.index?.name === vs.index?.name
            )?.[0];
            if (matchingVsKey) {
              vectorStoreRefName = matchingVsKey;
              vectorStoreSource = 'configured';
            } else {
              vectorStoreSource = 'select';
              vsVectorIndex = vs.index?.name || '';
              vsVectorCatalog = vs.source_table?.schema?.catalog_name || '';
              vsVectorSchema = vs.source_table?.schema?.schema_name || '';
            }
          }
        } else if (args.retriever) {
          // Using retriever
          vectorSearchSourceType = 'retriever';
          if (typeof args.retriever === 'string' && args.retriever.startsWith('__REF__')) {
            retrieverRefName = args.retriever.replace('__REF__', '');
            retrieverSource = 'configured';
          } else if (typeof args.retriever === 'object' && args.retriever !== null) {
            // Try to find a matching configured retriever
            const matchingKey = findConfiguredRetriever(args.retriever as { vector_store?: unknown });
            if (matchingKey) {
              retrieverRefName = matchingKey;
              retrieverSource = 'configured';
            } else {
              retrieverSource = 'select';
            }
          }
        }
        if (args.index_name && !retrieverRefName && vectorSearchSourceType === 'retriever') {
          vectorIndex = args.index_name as string;
          retrieverSource = 'select';
        }
        
        // Slack tool config
        let slackConnectionSource: ResourceSource = 'configured';
        let slackConnectionRefName = '';
        if (args.connection) {
          if (typeof args.connection === 'string' && args.connection.startsWith('__REF__')) {
            slackConnectionRefName = args.connection.replace('__REF__', '');
            slackConnectionSource = 'configured';
          } else if (typeof args.connection === 'object' && args.connection !== null) {
            // Try to find a matching configured connection
            const matchingKey = findConfiguredConnection(args.connection as { name?: string });
            if (matchingKey) {
              slackConnectionRefName = matchingKey;
              slackConnectionSource = 'configured';
            } else {
              slackConnectionSource = 'select';
            }
          }
        }
        
        // Email tool SMTP config
        let emailHost = 'smtp.gmail.com';
        let emailHostSource: CredentialSource = 'manual';
        let emailHostVariable = '';
        let emailPort = '587';
        let emailPortSource: CredentialSource = 'manual';
        let emailPortVariable = '';
        let emailUsername = '';
        let emailUsernameSource: CredentialSource = 'manual';
        let emailUsernameVariable = '';
        let emailPassword = '';
        let emailPasswordSource: CredentialSource = 'manual';
        let emailPasswordVariable = '';
        let emailSenderEmail = '';
        let emailSenderEmailSource: CredentialSource = 'manual';
        let emailSenderEmailVariable = '';
        let emailUseTls = true;
        let emailToolName = '';
        let emailToolDescription = '';
        
        if (args.smtp_config) {
          const smtpConfig = args.smtp_config as Record<string, unknown>;
          
          // Parse host
          if (typeof smtpConfig.host === 'string') {
            if (smtpConfig.host.startsWith('*')) {
              emailHostSource = 'variable';
              emailHostVariable = smtpConfig.host.substring(1);
            } else {
              emailHost = smtpConfig.host;
            }
          }
          
          // Parse port
          if (smtpConfig.port) {
            if (typeof smtpConfig.port === 'string' && smtpConfig.port.startsWith('*')) {
              emailPortSource = 'variable';
              emailPortVariable = smtpConfig.port.substring(1);
            } else {
              emailPort = String(smtpConfig.port);
            }
          }
          
          // Parse username
          if (typeof smtpConfig.username === 'string') {
            if (smtpConfig.username.startsWith('*')) {
              emailUsernameSource = 'variable';
              emailUsernameVariable = smtpConfig.username.substring(1);
            } else {
              emailUsername = smtpConfig.username;
            }
          }
          
          // Parse password
          if (typeof smtpConfig.password === 'string') {
            if (smtpConfig.password.startsWith('*')) {
              emailPasswordSource = 'variable';
              emailPasswordVariable = smtpConfig.password.substring(1);
            } else {
              emailPassword = smtpConfig.password;
            }
          }
          
          // Parse sender email (optional)
          if (smtpConfig.sender_email) {
            if (typeof smtpConfig.sender_email === 'string' && smtpConfig.sender_email.startsWith('*')) {
              emailSenderEmailSource = 'variable';
              emailSenderEmailVariable = smtpConfig.sender_email.substring(1);
            } else {
              emailSenderEmail = String(smtpConfig.sender_email);
            }
          }
          
          // Parse use_tls
          if (typeof smtpConfig.use_tls === 'boolean') {
            emailUseTls = smtpConfig.use_tls;
          }
        }
        
        // Parse tool name and description
        if (args.name && typeof args.name === 'string') {
          emailToolName = args.name;
        }
        if (args.description && typeof args.description === 'string') {
          emailToolDescription = args.description;
        }
        
        // Agent endpoint LLM config
        let agentLlmSource: ResourceSource = 'configured';
        let agentLlmRefName = '';
        if (args.llm) {
          if (typeof args.llm === 'string' && args.llm.startsWith('__REF__')) {
            agentLlmRefName = args.llm.replace('__REF__', '');
            agentLlmSource = 'configured';
          } else if (typeof args.llm === 'object' && args.llm !== null) {
            // Try to find a matching configured LLM
            const matchingKey = findConfiguredLlm(args.llm as { name?: string });
            if (matchingKey) {
              agentLlmRefName = matchingKey;
              agentLlmSource = 'configured';
            } else {
              agentLlmSource = 'select';
            }
          }
        }
        
        // Extract LRU cache parameters
        let genieLruCacheEnabled = false;
        let genieLruCacheCapacity = 1000;
        let genieLruCacheTtl = 86400;
        let genieLruCacheTtlNeverExpires = false;
        let genieLruCacheWarehouseSource: ResourceSource = 'configured';
        let genieLruCacheWarehouseRefName = '';
        let genieLruCacheWarehouseId = '';
        
        if (args.lru_cache_parameters) {
          genieLruCacheEnabled = true;
          const lruParams = args.lru_cache_parameters as Record<string, unknown>;
          genieLruCacheCapacity = (lruParams.capacity as number) ?? 1000;
          if (lruParams.time_to_live_seconds === null) {
            genieLruCacheTtlNeverExpires = true;
          } else {
            genieLruCacheTtl = (lruParams.time_to_live_seconds as number) ?? 86400;
          }
          // Extract warehouse reference - first check YAML references, then __REF__ marker, then match
          const lruWarehouseRefPath = `tools.${key}.function.args.lru_cache_parameters.warehouse`;
          const lruWarehouseOriginalRef = findOriginalReferenceForPath(lruWarehouseRefPath);
          
          if (lruWarehouseOriginalRef && configuredWarehouses[lruWarehouseOriginalRef]) {
            genieLruCacheWarehouseRefName = lruWarehouseOriginalRef;
            genieLruCacheWarehouseSource = 'configured';
          } else if (typeof lruParams.warehouse === 'string' && lruParams.warehouse.startsWith('__REF__')) {
            genieLruCacheWarehouseRefName = lruParams.warehouse.replace('__REF__', '');
            genieLruCacheWarehouseSource = 'configured';
          } else if (typeof lruParams.warehouse === 'object' && lruParams.warehouse !== null) {
            const wh = lruParams.warehouse as { warehouse_id?: unknown };
            const matchingKey = findConfiguredWarehouse(wh);
            if (matchingKey) {
              genieLruCacheWarehouseRefName = matchingKey;
              genieLruCacheWarehouseSource = 'configured';
            } else {
              genieLruCacheWarehouseId = getVariableDisplayValue(wh.warehouse_id);
              genieLruCacheWarehouseSource = 'select';
            }
          }
        }

        // Extract semantic cache parameters
        let genieSemanticCacheEnabled = false;
        let genieSemanticCacheTtl = 86400;
        let genieSemanticCacheTtlNeverExpires = false;
        let genieSemanticCacheSimilarityThreshold = 0.85;
        let genieSemanticCacheContextSimilarityThreshold = 0.80;
        let genieSemanticCacheQuestionWeight = 0.6;
        let genieSemanticCacheContextWeight = 0.4;
        let genieSemanticCacheContextWindowSize = 4;
        let genieSemanticCacheMaxContextTokens = 2000;
        let genieSemanticCacheEmbeddingModelSource: ResourceSource = 'configured';
        let genieSemanticCacheEmbeddingModelRefName = '';
        let genieSemanticCacheEmbeddingModelManual = 'databricks-gte-large-en';
        let genieSemanticCacheTableName = 'genie_context_aware_cache';
        let genieSemanticCacheDatabaseSource: ResourceSource = 'configured';
        let genieSemanticCacheDatabaseRefName = '';
        let genieSemanticCacheWarehouseSource: ResourceSource = 'configured';
        let genieSemanticCacheWarehouseRefName = '';
        let genieSemanticCacheWarehouseId = '';
        // Prompt history settings
        let genieSemanticCachePromptHistoryTable = 'genie_prompt_history';
        let genieSemanticCacheMaxPromptHistoryLength = 50;
        let genieSemanticCacheUseGenieApiForHistory = false;
        let genieSemanticCachePromptHistoryTtlEnabled = false;
        let genieSemanticCachePromptHistoryTtl = 86400;
        // IVFFlat index tuning settings
        let genieSemanticCacheIvfflatListsAuto = true;
        let genieSemanticCacheIvfflatLists = 100;
        let genieSemanticCacheIvfflatProbesAuto = true;
        let genieSemanticCacheIvfflatProbes = 10;
        let genieSemanticCacheIvfflatCandidates = 20;

        if (args.context_aware_cache_parameters || args.semantic_cache_parameters) {
          genieSemanticCacheEnabled = true;
          const semParams = (args.context_aware_cache_parameters || args.semantic_cache_parameters) as Record<string, unknown>;
          if (semParams.time_to_live_seconds === null) {
            genieSemanticCacheTtlNeverExpires = true;
          } else {
            genieSemanticCacheTtl = (semParams.time_to_live_seconds as number) ?? 86400;
          }
          genieSemanticCacheSimilarityThreshold = (semParams.similarity_threshold as number) ?? 0.85;
          genieSemanticCacheContextSimilarityThreshold = (semParams.context_similarity_threshold as number) ?? 0.80;
          genieSemanticCacheQuestionWeight = (semParams.question_weight as number) ?? 0.6;
          genieSemanticCacheContextWeight = (semParams.context_weight as number) ?? 0.4;
          genieSemanticCacheContextWindowSize = (semParams.context_window_size as number) ?? 4;
          genieSemanticCacheMaxContextTokens = (semParams.max_context_tokens as number) ?? 2000;
          genieSemanticCacheTableName = (semParams.table_name as string) ?? 'genie_context_aware_cache';
          // Parse prompt history settings
          genieSemanticCachePromptHistoryTable = (semParams.prompt_history_table as string) ?? 'genie_prompt_history';
          genieSemanticCacheMaxPromptHistoryLength = (semParams.max_prompt_history_length as number) ?? 50;
          genieSemanticCacheUseGenieApiForHistory = (semParams.use_genie_api_for_history as boolean) ?? false;
          if (semParams.prompt_history_ttl_seconds != null) {
            genieSemanticCachePromptHistoryTtlEnabled = true;
            genieSemanticCachePromptHistoryTtl = semParams.prompt_history_ttl_seconds as number;
          }
          // Parse IVFFlat index tuning settings
          if (semParams.ivfflat_lists != null) {
            genieSemanticCacheIvfflatListsAuto = false;
            genieSemanticCacheIvfflatLists = semParams.ivfflat_lists as number;
          }
          if (semParams.ivfflat_probes != null) {
            genieSemanticCacheIvfflatProbesAuto = false;
            genieSemanticCacheIvfflatProbes = semParams.ivfflat_probes as number;
          }
          genieSemanticCacheIvfflatCandidates = (semParams.ivfflat_candidates as number) ?? 20;
          
          // Extract embedding model - first check YAML references, then __REF__ marker, then match against configured LLMs
          const embeddingModelRefPath = `tools.${key}.function.args.context_aware_cache_parameters.embedding_model`;
          const embeddingModelOriginalRef = findOriginalReferenceForPath(embeddingModelRefPath);
          
          if (embeddingModelOriginalRef && configuredLlms[embeddingModelOriginalRef]) {
            // Found original reference in YAML references - use it
            genieSemanticCacheEmbeddingModelRefName = embeddingModelOriginalRef;
            genieSemanticCacheEmbeddingModelSource = 'configured';
          } else if (typeof semParams.embedding_model === 'string') {
            if (semParams.embedding_model.startsWith('__REF__')) {
              genieSemanticCacheEmbeddingModelRefName = semParams.embedding_model.replace('__REF__', '');
              genieSemanticCacheEmbeddingModelSource = 'configured';
            } else {
              // Check if this string matches a configured LLM name directly
              const matchingLlm = Object.entries(configuredLlms).find(([, llm]) => llm.name === semParams.embedding_model);
              if (matchingLlm) {
                genieSemanticCacheEmbeddingModelRefName = matchingLlm[0];
                genieSemanticCacheEmbeddingModelSource = 'configured';
              } else {
                // Use as manual value
                genieSemanticCacheEmbeddingModelManual = semParams.embedding_model as string;
                genieSemanticCacheEmbeddingModelSource = 'select'; // 'select' represents manual entry here
              }
            }
          } else if (typeof semParams.embedding_model === 'object' && semParams.embedding_model !== null) {
            const embModel = semParams.embedding_model as { name?: string };
            // Try to find a matching configured LLM
            const matchingKey = findConfiguredLlm(embModel);
            if (matchingKey) {
              genieSemanticCacheEmbeddingModelRefName = matchingKey;
              genieSemanticCacheEmbeddingModelSource = 'configured';
            } else if (embModel.name) {
              genieSemanticCacheEmbeddingModelManual = embModel.name;
              genieSemanticCacheEmbeddingModelSource = 'select';
            }
          }
          
          // Extract database reference - first check YAML references, then __REF__ marker, then match
          const databaseRefPath = `tools.${key}.function.args.context_aware_cache_parameters.database`;
          const databaseOriginalRef = findOriginalReferenceForPath(databaseRefPath);
          
          if (databaseOriginalRef && configuredDatabases[databaseOriginalRef]) {
            genieSemanticCacheDatabaseRefName = databaseOriginalRef;
            genieSemanticCacheDatabaseSource = 'configured';
          } else if (typeof semParams.database === 'string' && semParams.database.startsWith('__REF__')) {
            genieSemanticCacheDatabaseRefName = semParams.database.replace('__REF__', '');
            genieSemanticCacheDatabaseSource = 'configured';
          } else if (typeof semParams.database === 'object' && semParams.database !== null) {
            const db = semParams.database as { name?: string };
            // Try to find a matching configured database
            const matchingKey = findConfiguredDatabase(db);
            if (matchingKey) {
              genieSemanticCacheDatabaseRefName = matchingKey;
              genieSemanticCacheDatabaseSource = 'configured';
            }
          }
          
          // Extract warehouse reference - first check YAML references, then __REF__ marker, then match
          const semWarehouseRefPath = `tools.${key}.function.args.context_aware_cache_parameters.warehouse`;
          const semWarehouseOriginalRef = findOriginalReferenceForPath(semWarehouseRefPath);
          
          if (semWarehouseOriginalRef && configuredWarehouses[semWarehouseOriginalRef]) {
            genieSemanticCacheWarehouseRefName = semWarehouseOriginalRef;
            genieSemanticCacheWarehouseSource = 'configured';
          } else if (typeof semParams.warehouse === 'string' && semParams.warehouse.startsWith('__REF__')) {
            genieSemanticCacheWarehouseRefName = semParams.warehouse.replace('__REF__', '');
            genieSemanticCacheWarehouseSource = 'configured';
          } else if (typeof semParams.warehouse === 'object' && semParams.warehouse !== null) {
            const wh = semParams.warehouse as { warehouse_id?: unknown };
            const matchingKey = findConfiguredWarehouse(wh);
            if (matchingKey) {
              genieSemanticCacheWarehouseRefName = matchingKey;
              genieSemanticCacheWarehouseSource = 'configured';
            } else {
              genieSemanticCacheWarehouseId = getVariableDisplayValue(wh.warehouse_id);
              genieSemanticCacheWarehouseSource = 'select';
            }
          }
        }

        // Extract in-memory semantic cache parameters (new in dao-ai 0.1.21)
        let genieInMemoryCacheEnabled = false;
        let genieInMemoryCacheTtl = 604800;
        let genieInMemoryCacheTtlNeverExpires = false;
        let genieInMemoryCacheCapacity = 10000;
        let genieInMemoryCacheCapacityUnlimited = false;
        let genieInMemoryCacheSimilarityThreshold = 0.85;
        let genieInMemoryCacheContextSimilarityThreshold = 0.80;
        let genieInMemoryCacheQuestionWeight = 0.6;
        let genieInMemoryCacheContextWeight = 0.4;
        let genieInMemoryCacheContextWindowSize = 3;
        let genieInMemoryCacheMaxContextTokens = 2000;
        let genieInMemoryCacheEmbeddingModelSource: ResourceSource = 'configured';
        let genieInMemoryCacheEmbeddingModelRefName = '';
        let genieInMemoryCacheEmbeddingModelManual = 'databricks-gte-large-en';
        let genieInMemoryCacheWarehouseSource: ResourceSource = 'configured';
        let genieInMemoryCacheWarehouseRefName = '';
        let genieInMemoryCacheWarehouseId = '';

        if (args.in_memory_context_aware_cache_parameters || args.in_memory_semantic_cache_parameters) {
          genieInMemoryCacheEnabled = true;
          const inMemParams = (args.in_memory_context_aware_cache_parameters || args.in_memory_semantic_cache_parameters) as Record<string, unknown>;
          if (inMemParams.time_to_live_seconds === null) {
            genieInMemoryCacheTtlNeverExpires = true;
          } else {
            genieInMemoryCacheTtl = (inMemParams.time_to_live_seconds as number) ?? 604800;
          }
          if (inMemParams.capacity === null) {
            genieInMemoryCacheCapacityUnlimited = true;
          } else {
            genieInMemoryCacheCapacity = (inMemParams.capacity as number) ?? 10000;
          }
          genieInMemoryCacheSimilarityThreshold = (inMemParams.similarity_threshold as number) ?? 0.85;
          genieInMemoryCacheContextSimilarityThreshold = (inMemParams.context_similarity_threshold as number) ?? 0.80;
          genieInMemoryCacheQuestionWeight = (inMemParams.question_weight as number) ?? 0.6;
          genieInMemoryCacheContextWeight = (inMemParams.context_weight as number) ?? 0.4;
          genieInMemoryCacheContextWindowSize = (inMemParams.context_window_size as number) ?? 3;
          genieInMemoryCacheMaxContextTokens = (inMemParams.max_context_tokens as number) ?? 2000;
          
          // Extract embedding model
          const inMemEmbeddingModelRefPath = `tools.${key}.function.args.in_memory_context_aware_cache_parameters.embedding_model`;
          const inMemEmbeddingModelOriginalRef = findOriginalReferenceForPath(inMemEmbeddingModelRefPath);
          
          if (inMemEmbeddingModelOriginalRef && configuredLlms[inMemEmbeddingModelOriginalRef]) {
            genieInMemoryCacheEmbeddingModelRefName = inMemEmbeddingModelOriginalRef;
            genieInMemoryCacheEmbeddingModelSource = 'configured';
          } else if (typeof inMemParams.embedding_model === 'string') {
            if (inMemParams.embedding_model.startsWith('__REF__')) {
              genieInMemoryCacheEmbeddingModelRefName = inMemParams.embedding_model.replace('__REF__', '');
              genieInMemoryCacheEmbeddingModelSource = 'configured';
            } else {
              const matchingLlm = Object.entries(configuredLlms).find(([, llm]) => llm.name === inMemParams.embedding_model);
              if (matchingLlm) {
                genieInMemoryCacheEmbeddingModelRefName = matchingLlm[0];
                genieInMemoryCacheEmbeddingModelSource = 'configured';
              } else {
                genieInMemoryCacheEmbeddingModelManual = inMemParams.embedding_model as string;
                genieInMemoryCacheEmbeddingModelSource = 'select';
              }
            }
          } else if (typeof inMemParams.embedding_model === 'object' && inMemParams.embedding_model !== null) {
            const embModel = inMemParams.embedding_model as { name?: string };
            const matchingKey = findConfiguredLlm(embModel);
            if (matchingKey) {
              genieInMemoryCacheEmbeddingModelRefName = matchingKey;
              genieInMemoryCacheEmbeddingModelSource = 'configured';
            } else if (embModel.name) {
              genieInMemoryCacheEmbeddingModelManual = embModel.name;
              genieInMemoryCacheEmbeddingModelSource = 'select';
            }
          }
          
          // Extract warehouse reference
          const inMemWarehouseRefPath = `tools.${key}.function.args.in_memory_context_aware_cache_parameters.warehouse`;
          const inMemWarehouseOriginalRef = findOriginalReferenceForPath(inMemWarehouseRefPath);
          
          if (inMemWarehouseOriginalRef && configuredWarehouses[inMemWarehouseOriginalRef]) {
            genieInMemoryCacheWarehouseRefName = inMemWarehouseOriginalRef;
            genieInMemoryCacheWarehouseSource = 'configured';
          } else if (typeof inMemParams.warehouse === 'string' && inMemParams.warehouse.startsWith('__REF__')) {
            genieInMemoryCacheWarehouseRefName = inMemParams.warehouse.replace('__REF__', '');
            genieInMemoryCacheWarehouseSource = 'configured';
          } else if (typeof inMemParams.warehouse === 'object' && inMemParams.warehouse !== null) {
            const wh = inMemParams.warehouse as { warehouse_id?: unknown };
            const matchingKey = findConfiguredWarehouse(wh);
            if (matchingKey) {
              genieInMemoryCacheWarehouseRefName = matchingKey;
              genieInMemoryCacheWarehouseSource = 'configured';
            } else {
              genieInMemoryCacheWarehouseId = getVariableDisplayValue(wh.warehouse_id);
              genieInMemoryCacheWarehouseSource = 'select';
            }
          }
        }

        setFormData(prev => ({
          ...prev,
          refName: key, // YAML key (reference name)
          name: tool.name,
          type: 'factory',
          functionName: isKnownFactory ? funcName : 'custom',
          customFunctionName: isKnownFactory ? '' : funcName,
          genieSource,
          genieRefName,
          genieSpaceId,
          geniePersistConversation: args.persist_conversation as boolean ?? true,
          genieTruncateResults: args.truncate_results as boolean ?? false,
          // LRU Cache
          genieLruCacheEnabled,
          genieLruCacheCapacity,
          genieLruCacheTtl,
          genieLruCacheTtlNeverExpires,
          genieLruCacheWarehouseSource,
          genieLruCacheWarehouseRefName,
          genieLruCacheWarehouseId,
          // Semantic Cache
          genieSemanticCacheEnabled,
          genieSemanticCacheTtl,
          genieSemanticCacheTtlNeverExpires,
          genieSemanticCacheSimilarityThreshold,
          genieSemanticCacheContextSimilarityThreshold,
          genieSemanticCacheQuestionWeight,
          genieSemanticCacheContextWeight,
          genieSemanticCacheContextWindowSize,
          genieSemanticCacheMaxContextTokens,
          genieSemanticCacheEmbeddingModelSource,
          genieSemanticCacheEmbeddingModelRefName,
          genieSemanticCacheEmbeddingModelManual,
          genieSemanticCacheTableName,
          genieSemanticCacheDatabaseSource,
          genieSemanticCacheDatabaseRefName,
          genieSemanticCacheWarehouseSource,
          genieSemanticCacheWarehouseRefName,
          genieSemanticCacheWarehouseId,
          // Prompt history settings
          genieSemanticCachePromptHistoryTable,
          genieSemanticCacheMaxPromptHistoryLength,
          genieSemanticCacheUseGenieApiForHistory,
          genieSemanticCachePromptHistoryTtlEnabled,
          genieSemanticCachePromptHistoryTtl,
          // IVFFlat index tuning settings
          genieSemanticCacheIvfflatListsAuto,
          genieSemanticCacheIvfflatLists,
          genieSemanticCacheIvfflatProbesAuto,
          genieSemanticCacheIvfflatProbes,
          genieSemanticCacheIvfflatCandidates,
          // In-Memory Semantic Cache
          genieInMemoryCacheEnabled,
          genieInMemoryCacheTtl,
          genieInMemoryCacheTtlNeverExpires,
          genieInMemoryCacheCapacity,
          genieInMemoryCacheCapacityUnlimited,
          genieInMemoryCacheSimilarityThreshold,
          genieInMemoryCacheContextSimilarityThreshold,
          genieInMemoryCacheQuestionWeight,
          genieInMemoryCacheContextWeight,
          genieInMemoryCacheContextWindowSize,
          genieInMemoryCacheMaxContextTokens,
          genieInMemoryCacheEmbeddingModelSource,
          genieInMemoryCacheEmbeddingModelRefName,
          genieInMemoryCacheEmbeddingModelManual,
          genieInMemoryCacheWarehouseSource,
          genieInMemoryCacheWarehouseRefName,
          genieInMemoryCacheWarehouseId,
          vectorSearchSourceType,
          retrieverSource,
          retrieverRefName,
          vectorIndex,
          vectorStoreSource,
          vectorStoreRefName,
          vsVectorIndex,
          vsVectorCatalog,
          vsVectorSchema,
          vectorSearchDescription: args.description as string || '',
          slackConnectionSource,
          slackConnectionRefName,
          slackChannelId: args.channel_id as string || '',
          slackChannelName: args.channel_name as string || '',
          agentLlmSource,
          agentLlmRefName,
          // Email tool fields
          emailHost,
          emailHostSource,
          emailHostVariable,
          emailPort,
          emailPortSource,
          emailPortVariable,
          emailUsername,
          emailUsernameSource,
          emailUsernameVariable,
          emailPassword,
          emailPasswordSource,
          emailPasswordVariable,
          emailSenderEmail,
          emailSenderEmailSource,
          emailSenderEmailVariable,
          emailUseTls,
          emailToolName,
          emailToolDescription,
        }));
      } else if (funcType === 'python') {
        const funcName = 'name' in func ? func.name : '';
        const isKnownPython = PYTHON_TOOLS.some(pt => pt.value === funcName);
        
        setFormData(prev => ({
          ...prev,
          refName: key, // YAML key (reference name)
          name: tool.name,
          type: 'python',
          functionName: isKnownPython ? funcName : 'custom',
          customFunctionName: isKnownPython ? '' : funcName,
        }));
      } else if (funcType === 'inline') {
        // Inline function type (new in dao-ai 0.1.21)
        const inlineCode = 'code' in func ? (func.code as string) : '';
        
        setFormData(prev => ({
          ...prev,
          refName: key, // YAML key (reference name)
          name: tool.name,
          type: 'inline',
          inlineCode,
        }));
      } else if (funcType === 'unity_catalog') {
        // Cast to proper type for unity_catalog
        const ucFunc = func as UnityCatalogFunctionModel;
        
        // dao-ai 0.1.2: Use 'resource' field instead of __MERGE__
        const resource = ucFunc.resource;
        const partialArgs = ucFunc.partial_args || {};
        
        // Convert partial_args to PartialArgEntry array
        const ucPartialArgs: PartialArgEntry[] = Object.entries(partialArgs).map(([argName, argValue]) => {
          let source: PartialArgSource = 'manual';
          let value = String(argValue);
          
          if (typeof argValue === 'string') {
            if (argValue.startsWith('__REF__')) {
              const refName = argValue.replace('__REF__', '');
              // Check if it's a service principal or variable
              const servicePrincipals = config.service_principals || {};
              if (servicePrincipals[refName]) {
                source = 'service_principal';
                value = refName;
              } else {
                source = 'variable';
                value = refName;
              }
            }
          }
          
          return {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: argName,
            source,
            value,
          };
        });
        
        // Check if resource is a string reference
        if (typeof resource === 'string') {
          // It's a reference to a configured function
          const refName = resource.startsWith('*') ? resource.slice(1) : resource;
          setFormData(prev => ({
            ...prev,
            refName: key, // YAML key (reference name)
            name: tool.name,
            type: 'unity_catalog',
            functionSource: 'configured',
            functionRefName: refName,
            ucPartialArgs,
          }));
        } else if (resource && typeof resource === 'object') {
          // Inline FunctionModel - try to find a matching configured function first
          const resourceObj = resource as { schema?: { catalog_name?: string; schema_name?: string }; name?: string };
          const schema = resourceObj.schema;
          const funcName = resourceObj.name || '';
          
          // Try to find a matching configured function
          const matchingFuncKey = findConfiguredFunction({
            name: funcName,
            schema: schema,
          });
          
          if (matchingFuncKey) {
            // Found a matching configured function
            setFormData(prev => ({
              ...prev,
              refName: key, // YAML key (reference name)
              name: tool.name,
              type: 'unity_catalog',
              functionSource: 'configured',
              functionRefName: matchingFuncKey,
              ucPartialArgs,
            }));
          } else {
            // No match - use direct selection
            let fullFuncName = funcName;
            if (schema && 'catalog_name' in schema && 'schema_name' in schema) {
              fullFuncName = `${schema.catalog_name}.${schema.schema_name}.${funcName}`;
            }
            
            setFormData(prev => ({
              ...prev,
              refName: key, // YAML key (reference name)
              name: tool.name,
              type: 'unity_catalog',
              functionSource: 'select',
              ucFunction: fullFuncName,
              ucPartialArgs,
            }));
          }
        } else {
          // No resource - empty UC function
          setFormData(prev => ({
            ...prev,
            refName: key,
            name: tool.name,
            type: 'unity_catalog',
            functionSource: 'select',
            ucFunction: '',
            ucPartialArgs,
          }));
        }
      } else if (funcType === 'mcp') {
        // MCP tool - handle all source types
        const mcpFunc = func as McpFunctionModel;
        setFormData(prev => ({
          ...prev,
          refName: key, // YAML key (reference name)
          name: tool.name,
          type: 'mcp',
        }));
        
        // Determine source type and set MCP form data accordingly
        if (mcpFunc.connection) {
          // UC Connection source
          const conn = mcpFunc.connection as any;
          // Check if it's a reference (string starting with *) or an object
          const isReference = typeof conn === 'string' && conn.startsWith('*');
          const connName = isReference ? conn.slice(1) : (conn?.name || '');
          
          // Try to find matching configured connection
          const matchingConnKey = Object.entries(configuredConnections).find(
            ([connKey, c]) => {
              if (isReference) {
                return connKey === connName;
              }
              return (c as any).name === connName;
            }
          )?.[0];
          
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'connection',
            connectionSource: matchingConnKey ? 'configured' : 'select',
            connectionRefName: matchingConnKey || '',
            connectionName: matchingConnKey ? '' : connName,
          }));
        } else if (mcpFunc.genie_room) {
          // Genie Room source
          const genie = mcpFunc.genie_room as any;
          const isReference = typeof genie === 'string' && genie.startsWith('*');
          const genieId = isReference ? genie.slice(1) : '';
          
          // Try to find matching configured genie room
          const genieSpaceIdValue = getVariableDisplayValue(genie?.space_id);
          const matchingGenieKey = isReference ? genieId : 
            Object.entries(configuredGenieRooms).find(
              ([, g]) => getVariableDisplayValue((g as any).space_id) === genieSpaceIdValue || (g as any).name === genie?.name
            )?.[0];
          
          // Get name and description from configured room if available, otherwise from inline config
          let genieName = '';
          let genieDescription = '';
          if (matchingGenieKey) {
            const configuredRoom = configuredGenieRooms[matchingGenieKey];
            genieName = configuredRoom?.name || matchingGenieKey;
            genieDescription = configuredRoom?.description || '';
          } else if (genie?.name) {
            genieName = genie.name;
            genieDescription = genie.description || '';
          }
          
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'genie',
            genieSource: matchingGenieKey ? 'configured' : 'select',
            genieRefName: matchingGenieKey || '',
            genieSpaceId: !matchingGenieKey && genie?.space_id ? genieSpaceIdValue : '',
            genieName: genieName,
            genieDescription: genieDescription,
          }));
        } else if (mcpFunc.vector_search) {
          // Vector Search source
          const vs = mcpFunc.vector_search;
          let vectorStoreSource: ResourceSource = 'select';
          let vectorStoreRefName = '';
          let vectorIndex = '';
          let vectorCatalog = '';
          let vectorSchema = '';
          let vectorEndpoint = '';
          
          // Check if it's a reference to a configured vector store
          if (typeof vs === 'string' && vs.startsWith('*')) {
            vectorStoreRefName = vs.slice(1);
            vectorStoreSource = 'configured';
          } else if (typeof vs === 'object' && vs !== null) {
            const vsObj = vs as any;
            const configuredVectorStores = config.resources?.vector_stores || {};
            
            // Try multiple matching strategies to find the configured vector store
            let matchingVsKey: string | undefined;
            
            // Strategy 1: Match by index name
            const vsIndexName = typeof vsObj.index === 'string' ? vsObj.index : vsObj.index?.name;
            if (vsIndexName) {
              matchingVsKey = Object.entries(configuredVectorStores).find(
                ([, store]) => {
                  const storeIndex = (store as any).index;
                  const storeIndexName = typeof storeIndex === 'string' ? storeIndex : storeIndex?.name;
                  return storeIndexName === vsIndexName;
                }
              )?.[0];
            }
            
            // Strategy 2: Match by endpoint name if index didn't match
            if (!matchingVsKey && vsObj.endpoint?.name) {
              matchingVsKey = Object.entries(configuredVectorStores).find(
                ([, store]) => (store as any).endpoint?.name === vsObj.endpoint?.name
              )?.[0];
            }
            
            // Strategy 3: Deep equality check (YAML resolved same object)
            if (!matchingVsKey) {
              matchingVsKey = Object.entries(configuredVectorStores).find(
                ([, store]) => JSON.stringify(store) === JSON.stringify(vsObj)
              )?.[0];
            }
            
            if (matchingVsKey) {
              vectorStoreRefName = matchingVsKey;
              vectorStoreSource = 'configured';
            } else {
              // Inline vector store configuration
              vectorStoreSource = 'select';
              vectorIndex = vsIndexName || '';
              vectorCatalog = vsObj.source_table?.schema?.catalog_name || '';
              vectorSchema = vsObj.source_table?.schema?.schema_name || '';
              vectorEndpoint = vsObj.endpoint?.name || '';
            }
          }
          
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'vector_search',
            vectorStoreSource,
            vectorStoreRefName,
            vectorIndex,
            vectorCatalog,
            vectorSchema,
            vectorEndpoint,
          }));
        } else if (mcpFunc.functions) {
          // UC Functions source
          const schema = mcpFunc.functions as any;
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'functions',
            functionsCatalog: schema?.catalog_name || '',
            functionsSchema: schema?.schema_name || '',
          }));
        } else if (mcpFunc.sql) {
          // SQL source
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'sql',
          }));
        } else if (mcpFunc.app) {
          // Databricks App source
          const appRef = mcpFunc.app;
          const isReference = typeof appRef === 'string' && appRef.startsWith('*');
          const appRefName = isReference ? appRef.slice(1) : '';
          const appName = typeof appRef === 'object' && appRef.name ? appRef.name : '';
          
          setMcpForm(prev => ({
            ...prev,
            sourceType: 'app',
            appSource: isReference ? 'configured' : 'select',
            appRefName: appRefName,
            appName: appName,
          }));
        } else if (mcpFunc.url) {
          if (typeof mcpFunc.url === 'string') {
            const isUrlVariable = mcpFunc.url.startsWith('__REF__');
            setMcpForm(prev => ({
              ...prev,
              sourceType: 'url',
              urlSource: isUrlVariable ? 'variable' : 'manual',
              url: isUrlVariable ? '' : mcpFunc.url as string,
              urlVariable: isUrlVariable ? (mcpFunc.url as string).substring(7) : '',
            }));
          } else {
            const resolved = getVariableDisplayValue(mcpFunc.url);
            setMcpForm(prev => ({
              ...prev,
              sourceType: 'url',
              urlSource: 'manual',
              url: resolved,
              urlVariable: '',
            }));
          }
        }
        
        // Load include_tools and exclude_tools if present
        if (mcpFunc.include_tools || mcpFunc.exclude_tools) {
          setMcpForm(prev => ({
            ...prev,
            includeTools: mcpFunc.include_tools || [],
            excludeTools: mcpFunc.exclude_tools || [],
          }));
        }
      }
    }
    
    setIsModalOpen(true);
  };

  const getToolType = (tool: { function: string | { type?: string } }): string => {
    if (typeof tool.function === 'string') return 'string';
    return tool.function?.type || 'unknown';
  };

  const hasHITL = (tool: { function: string | { human_in_the_loop?: HumanInTheLoopModel } }): boolean => {
    if (typeof tool.function === 'string') return false;
    return !!tool.function?.human_in_the_loop;
  };

  const getToolIcon = (tool: { function: string | { type?: string; name?: string } }) => {
    const type = getToolType(tool);
    if (type === 'mcp') return Link2;
    if (type === 'unity_catalog') return Database;
    if (type === 'inline') return Code;
    if (typeof tool.function === 'object' && tool.function.name) {
      if (tool.function.name.includes('genie')) return MessageSquare;
      if (tool.function.name.includes('vector') || tool.function.name.includes('search')) return Search;
      if (tool.function.name.includes('time')) return Clock;
      if (tool.function.name.includes('agent')) return Bot;
    }
    return Wrench;
  };

  const ucFunctionOptions = [
    { value: '', label: 'Select a function...' },
    ...(ucFunctions || []).map((f) => ({
      value: f.full_name,
      label: `${f.name}${f.comment ? ` - ${f.comment}` : ''}`,
    })),
  ];

  const vectorIndexOptions = [
    { value: '', label: 'Select an index...' },
    ...(vectorIndexes || []).map((i) => ({
      value: i.name,
      label: `${i.name}${i.index_type ? ` (${i.index_type})` : ''}`,
    })),
  ];

  const mcpVectorIndexOptions = [
    { value: '', label: 'Select an index...' },
    ...(mcpVectorIndexes || []).map((i) => ({
      value: i.name,
      label: `${i.name}${i.index_type ? ` (${i.index_type})` : ''}`,
    })),
  ];

  // Helper to get display name for variable
  const getVariableDisplayName = (variable: typeof variables[string]): string => {
    if (!variable) return 'unknown';
    if ('env' in variable) return `env: ${variable.env}`;
    if ('scope' in variable && 'secret' in variable) return `secret: ${variable.scope}/${variable.secret}`;
    if ('value' in variable) return `value: ${String(variable.value)}`;
    if ('options' in variable) return `composite (${variable.options.length} options)`;
    return 'unknown';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Tools</h2>
          <p className="text-slate-400 mt-1">
            Configure tools that agents can use to perform tasks
          </p>
        </div>
        <Button onClick={() => setIsModalOpen(true)}>
          <Plus className="w-4 h-4" />
          Add Tool
        </Button>
      </div>

      {/* Tool List */}
      {Object.keys(tools).length === 0 ? (
        <Card className="text-center py-12">
          <Wrench className="w-12 h-12 mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-medium text-slate-300 mb-2">No tools configured</h3>
          <p className="text-slate-500 mb-4">
            Tools enable agents to interact with external systems and data.
          </p>
          <Button onClick={() => setIsModalOpen(true)}>
            <Plus className="w-4 h-4" />
            Add Your First Tool
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4">
          {Object.entries(tools).map(([key, tool]) => {
            const Icon = getToolIcon(tool);
            return (
              <Card 
                key={key} 
                variant="interactive" 
                className="group cursor-pointer"
                onClick={() => handleEdit(key, tool)}
              >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center">
                      <Icon className="w-5 h-5 text-amber-400" />
                  </div>
                  <div>
                      <h3 className="font-medium text-white">{key}</h3>
                      {key !== tool.name && (
                        <p className="text-xs text-slate-500">name: {tool.name}</p>
                      )}
                    <p className="text-sm text-slate-400 font-mono">
                      {typeof tool.function === 'object' 
                        ? ('name' in tool.function ? tool.function.name : `${tool.function.type}`)
                        : tool.function}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                    {hasHITL(tool) && (
                      <Badge variant="success" title="Human In The Loop Enabled">
                        <UserCheck className="w-3 h-3 mr-1" />
                        HITL
                      </Badge>
                    )}
                  <Badge variant="warning">{getToolType(tool)}</Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleEdit(key, tool);
                      }}
                      title="Edit tool"
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                  <Button
                    variant="danger"
                    size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        safeDelete('Tool', key, () => removeTool(key));
                      }}
                      title="Delete tool"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {/* Add Tool Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          resetForm();
        }}
        title={editingKey ? 'Edit Tool' : 'Add Tool'}
        description={editingKey ? 'Modify the tool configuration' : 'Configure a tool for your agents'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Reference Name"
              placeholder="e.g., find_product_by_sku_tool"
              value={formData.refName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const normalizedValue = normalizeRefNameWhileTyping(e.target.value);
                // If Tool Name hasn't been manually edited, sync it with Reference Name
                if (!nameManuallyEdited) {
                  setFormData({ ...formData, refName: normalizedValue, name: normalizedValue });
                } else {
                  setFormData({ ...formData, refName: normalizedValue });
                }
                setRefNameManuallyEdited(true);
              }}
              hint="YAML key (spaces become underscores)"
              required
            />
            <Select
              label="Tool Type"
              options={TOOL_TYPES}
              value={formData.type}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, type: e.target.value as 'factory' | 'python' | 'inline' | 'unity_catalog' | 'mcp' })}
            />
          </div>

          <Input
            label="Tool Name"
            placeholder="e.g., find_product_by_sku_uc"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const newName = e.target.value;
              // If Reference Name hasn't been manually edited, sync it with Tool Name
              if (!refNameManuallyEdited) {
                const normalizedRefName = normalizeRefNameWhileTyping(newName);
                setFormData({ ...formData, name: newName, refName: normalizedRefName });
              } else {
                setFormData({ ...formData, name: newName });
              }
              setNameManuallyEdited(true);
            }}
            hint="The name property inside the tool config (can differ from reference name)"
            required
          />

          {/* Factory Tool Configuration */}
          {formData.type === 'factory' && (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300">Factory Function</label>
                <div className="grid grid-cols-2 gap-2">
                  {FACTORY_TOOLS.map((tool) => {
                    const Icon = tool.icon;
                    const isSelected = formData.functionName === tool.value;
                    return (
                      <button
                        key={tool.value}
                        type="button"
                        onClick={() => {
                          const generatedName = generateToolName(tool.value);
                          setFormData({ 
                            ...formData, 
                            functionName: tool.value,
                            // Auto-generate tool name if not manually edited
                            name: nameManuallyEdited ? formData.name : generatedName,
                            // Auto-generate ref name if not manually edited
                            refName: refNameManuallyEdited ? formData.refName : generatedName,
                          });
                        }}
                        className={`p-3 rounded-lg border text-left transition-all ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500/10'
                            : 'border-slate-700 hover:border-slate-600 bg-slate-800/50'
                        }`}
                      >
                        <div className="flex items-center space-x-2">
                          <Icon className={`w-4 h-4 ${isSelected ? 'text-blue-400' : 'text-slate-400'}`} />
                          <span className={`text-sm font-medium ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                            {tool.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">{tool.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Genie Tool Configuration */}
              {formData.functionName === 'dao_ai.tools.create_genie_tool' && (
                <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                  <h4 className="text-sm font-medium text-slate-300">Genie Tool Configuration</h4>
                  <ResourceSelector
                    label="Genie Room"
                    resourceType="Genie room"
                    configuredOptions={configuredGenieOptions}
                    configuredValue={formData.genieRefName}
                    onConfiguredChange={(value) => setFormData({ ...formData, genieRefName: value, genieSpaceId: '' })}
                    source={formData.genieSource}
                    onSourceChange={(source) => setFormData({ ...formData, genieSource: source })}
                  >
                  <GenieSpaceSelect
                    value={formData.genieSpaceId}
                    onChange={(value) => {
                      // Auto-populate Genie tool name from selected space
                      const space = genieSpaces?.find(s => s.space_id === value);
                      const spaceName = space?.title || '';
                      
                      setFormData({ 
                        ...formData, 
                        genieSpaceId: value, 
                        genieRefName: '',
                        name: editingKey ? formData.name : spaceName // Only auto-fill when creating new
                      });
                    }}
                    required
                  />
                  </ResourceSelector>
                  
                  {/* Genie Tool Options */}
                  <div className="space-y-3 pt-2 border-t border-slate-700">
                    <h5 className="text-xs font-medium text-slate-400 uppercase tracking-wider">Options</h5>
                    
                    <label className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={formData.geniePersistConversation}
                        onChange={(e) => setFormData({ ...formData, geniePersistConversation: e.target.checked })}
                        className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
                      />
                      <div>
                        <span className="text-sm text-slate-200 group-hover:text-white">Persist Conversation</span>
                        <p className="text-xs text-slate-500">Keep conversation context across tool calls for multi-turn conversations within the same Genie space</p>
                      </div>
                    </label>
                    
                    <label className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={formData.genieTruncateResults}
                        onChange={(e) => setFormData({ ...formData, genieTruncateResults: e.target.checked })}
                        className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
                      />
                      <div>
                        <span className="text-sm text-slate-200 group-hover:text-white">Truncate Results</span>
                        <p className="text-xs text-slate-500">Truncate large query results to fit within token limits</p>
                      </div>
                    </label>
                    
                    {/* LRU Cache */}
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={formData.genieLruCacheEnabled}
                          onChange={(e) => setFormData({ ...formData, genieLruCacheEnabled: e.target.checked })}
                          className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
                        />
                        <div>
                          <span className="text-sm text-slate-200 group-hover:text-white">Enable LRU Cache</span>
                          <p className="text-xs text-slate-500">Cache query results using Least Recently Used eviction policy</p>
                        </div>
                      </label>
                      
                      {formData.genieLruCacheEnabled && (
                        <div className="ml-7 space-y-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Capacity"
                              type="number"
                              value={formData.genieLruCacheCapacity.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieLruCacheCapacity: parseInt(e.target.value) || 1000 })}
                              hint="Max cached entries"
                            />
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-slate-300">TTL (seconds)</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  value={formData.genieLruCacheTtlNeverExpires ? '' : formData.genieLruCacheTtl}
                                  onChange={(e) => setFormData({ ...formData, genieLruCacheTtl: parseInt(e.target.value) || 86400 })}
                                  disabled={formData.genieLruCacheTtlNeverExpires}
                                  className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                                />
                              </div>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={formData.genieLruCacheTtlNeverExpires}
                                  onChange={(e) => setFormData({ ...formData, genieLruCacheTtlNeverExpires: e.target.checked })}
                                  className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                />
                                <span className="text-xs text-slate-400">Never expires</span>
                              </label>
                            </div>
                          </div>
                          <ResourceSelector
                            label="Warehouse"
                            resourceType="Warehouse"
                            configuredOptions={configuredWarehouseOptions}
                            configuredValue={formData.genieLruCacheWarehouseRefName}
                            onConfiguredChange={(value) => setFormData({ ...formData, genieLruCacheWarehouseRefName: value, genieLruCacheWarehouseId: '' })}
                            source={formData.genieLruCacheWarehouseSource}
                            onSourceChange={(source) => setFormData({ ...formData, genieLruCacheWarehouseSource: source })}
                            hint="SQL warehouse for cache operations"
                          >
                            <Input
                              label="Warehouse ID"
                              placeholder="Enter warehouse ID"
                              value={formData.genieLruCacheWarehouseId}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieLruCacheWarehouseId: e.target.value, genieLruCacheWarehouseRefName: '' })}
                            />
                          </ResourceSelector>
                        </div>
                      )}
                    </div>

                    {/* Context-Aware Cache (PostgreSQL/Lakebase-backed) */}
                    <div className="space-y-3">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={formData.genieSemanticCacheEnabled}
                          onChange={(e) => setFormData({ ...formData, genieSemanticCacheEnabled: e.target.checked })}
                          className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
                        />
                        <div>
                          <span className="text-sm text-slate-200 group-hover:text-white">Enable Persistent Context-Aware Cache</span>
                          <p className="text-xs text-slate-500">Context-aware similarity matching with database-backed storage (requires Lakebase database)</p>
                        </div>
                      </label>
                      
                      {formData.genieSemanticCacheEnabled && (
                        <div className="ml-7 space-y-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Question Similarity Threshold"
                              type="number"
                              step="0.01"
                              min="0"
                              max="1"
                              value={formData.genieSemanticCacheSimilarityThreshold.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheSimilarityThreshold: parseFloat(e.target.value) || 0.85 })}
                              hint="Min similarity for question matching (0-1)"
                            />
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-slate-300">TTL (seconds)</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  value={formData.genieSemanticCacheTtlNeverExpires ? '' : formData.genieSemanticCacheTtl}
                                  onChange={(e) => setFormData({ ...formData, genieSemanticCacheTtl: parseInt(e.target.value) || 86400 })}
                                  disabled={formData.genieSemanticCacheTtlNeverExpires}
                                  className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                                />
                              </div>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={formData.genieSemanticCacheTtlNeverExpires}
                                  onChange={(e) => setFormData({ ...formData, genieSemanticCacheTtlNeverExpires: e.target.checked })}
                                  className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                />
                                <span className="text-xs text-slate-400">Never expires</span>
                              </label>
                            </div>
                          </div>
                          
                          {/* Conversation-Aware Caching Parameters */}
                          <div className="space-y-3 p-3 bg-slate-800/30 rounded-lg border border-slate-700/30">
                            <h5 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Conversation-Aware Settings</h5>
                            <p className="text-xs text-slate-500">Cache considers conversation context, not just the current question</p>
                            
                            <div className="grid grid-cols-2 gap-3">
                              <Input
                                label="Context Similarity Threshold"
                                type="number"
                                step="0.01"
                                min="0"
                                max="1"
                                value={formData.genieSemanticCacheContextSimilarityThreshold.toString()}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheContextSimilarityThreshold: parseFloat(e.target.value) || 0.80 })}
                                hint="Min similarity for conversation context (0-1)"
                              />
                              <Input
                                label="Question Weight"
                                type="number"
                                step="0.01"
                                min="0"
                                max="1"
                                value={formData.genieSemanticCacheQuestionWeight.toString()}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                  const qWeight = parseFloat(e.target.value) || 0.6;
                                  setFormData({ 
                                    ...formData, 
                                    genieSemanticCacheQuestionWeight: qWeight,
                                    genieSemanticCacheContextWeight: 1 - qWeight
                                  });
                                }}
                                hint="Weight for question similarity. Context weight = 1 - this"
                              />
                              <Input
                                label="Context Window Size"
                                type="number"
                                min="1"
                                max="10"
                                value={formData.genieSemanticCacheContextWindowSize.toString()}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheContextWindowSize: parseInt(e.target.value) || 4 })}
                                hint="Number of previous turns to include"
                              />
                              <Input
                                label="Max Context Tokens"
                                type="number"
                                step="100"
                                min="100"
                                max="10000"
                                value={formData.genieSemanticCacheMaxContextTokens.toString()}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheMaxContextTokens: parseInt(e.target.value) || 2000 })}
                                hint="Max tokens to prevent long embeddings"
                              />
                            </div>
                          </div>
                          
                          <ResourceSelector
                            label="Embedding Model"
                            resourceType="LLM"
                            configuredOptions={configuredLlmOptions}
                            configuredValue={formData.genieSemanticCacheEmbeddingModelRefName}
                            onConfiguredChange={(value) => setFormData({ ...formData, genieSemanticCacheEmbeddingModelRefName: value, genieSemanticCacheEmbeddingModelManual: '' })}
                            source={formData.genieSemanticCacheEmbeddingModelSource}
                            onSourceChange={(source) => setFormData({ ...formData, genieSemanticCacheEmbeddingModelSource: source })}
                            hint="Model for computing embeddings"
                          >
                            <Input
                              label="Model Name"
                              placeholder="databricks-gte-large-en"
                              value={formData.genieSemanticCacheEmbeddingModelManual}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheEmbeddingModelManual: e.target.value, genieSemanticCacheEmbeddingModelRefName: '' })}
                              hint="Enter embedding model name manually"
                            />
                          </ResourceSelector>
                          <Input
                            label="Cache Table Name"
                            placeholder="genie_semantic_cache"
                            value={formData.genieSemanticCacheTableName}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheTableName: e.target.value })}
                            hint="Table to store cache entries"
                          />
                          <Select
                            label="Database (Lakebase)"
                            value={formData.genieSemanticCacheDatabaseRefName}
                            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, genieSemanticCacheDatabaseRefName: e.target.value, genieSemanticCacheDatabaseSource: 'configured' })}
                            hint="Lakebase database for context-aware cache storage"
                            options={configuredDatabaseOptions}
                            placeholder="Select configured database..."
                          />
                          <ResourceSelector
                            label="Warehouse"
                            resourceType="Warehouse"
                            configuredOptions={configuredWarehouseOptions}
                            configuredValue={formData.genieSemanticCacheWarehouseRefName}
                            onConfiguredChange={(value) => setFormData({ ...formData, genieSemanticCacheWarehouseRefName: value, genieSemanticCacheWarehouseId: '' })}
                            source={formData.genieSemanticCacheWarehouseSource}
                            onSourceChange={(source) => setFormData({ ...formData, genieSemanticCacheWarehouseSource: source })}
                            hint="SQL warehouse for cache operations"
                          >
                            <Input
                              label="Warehouse ID"
                              placeholder="Enter warehouse ID"
                              value={formData.genieSemanticCacheWarehouseId}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheWarehouseId: e.target.value, genieSemanticCacheWarehouseRefName: '' })}
                            />
                          </ResourceSelector>

                          {/* Prompt History Settings */}
                          <div className="space-y-3 p-3 bg-slate-800/30 rounded-lg border border-slate-700/30">
                            <h5 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Prompt History</h5>
                            <p className="text-xs text-slate-500">Stores user prompts to maintain conversation context for accurate context-aware matching</p>
                            
                            <div className="grid grid-cols-2 gap-3">
                              <Input
                                label="History Table Name"
                                placeholder="genie_prompt_history"
                                value={formData.genieSemanticCachePromptHistoryTable}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCachePromptHistoryTable: e.target.value || 'genie_prompt_history' })}
                                hint="Table for storing prompt history"
                              />
                              <Input
                                label="Max History Length"
                                type="number"
                                min="1"
                                max="1000"
                                value={formData.genieSemanticCacheMaxPromptHistoryLength.toString()}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheMaxPromptHistoryLength: parseInt(e.target.value) || 50 })}
                                hint="Max prompts per conversation"
                              />
                            </div>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={formData.genieSemanticCacheUseGenieApiForHistory}
                                onChange={(e) => setFormData({ ...formData, genieSemanticCacheUseGenieApiForHistory: e.target.checked })}
                                className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                              />
                              <span className="text-xs text-slate-400">Use Genie API for history (fallback when local history is empty)</span>
                            </label>
                            <div className="space-y-1">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={formData.genieSemanticCachePromptHistoryTtlEnabled}
                                  onChange={(e) => setFormData({ ...formData, genieSemanticCachePromptHistoryTtlEnabled: e.target.checked })}
                                  className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                />
                                <span className="text-xs text-slate-400">Custom prompt history TTL (default: use cache TTL)</span>
                              </label>
                              {formData.genieSemanticCachePromptHistoryTtlEnabled && (
                                <Input
                                  label="Prompt History TTL (seconds)"
                                  type="number"
                                  min="1"
                                  value={formData.genieSemanticCachePromptHistoryTtl.toString()}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCachePromptHistoryTtl: parseInt(e.target.value) || 86400 })}
                                  hint="TTL for prompt history entries"
                                />
                              )}
                            </div>
                          </div>

                          {/* IVFFlat Index Tuning */}
                          <div className="space-y-3 p-3 bg-slate-800/30 rounded-lg border border-slate-700/30">
                            <h5 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">IVFFlat Index Tuning</h5>
                            <p className="text-xs text-slate-500">Controls recall vs speed trade-offs for pg_vector similarity search at scale</p>
                            
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={formData.genieSemanticCacheIvfflatListsAuto}
                                    onChange={(e) => setFormData({ ...formData, genieSemanticCacheIvfflatListsAuto: e.target.checked })}
                                    className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                  />
                                  <span className="text-xs text-slate-400">Auto-compute IVF lists</span>
                                </label>
                                {!formData.genieSemanticCacheIvfflatListsAuto && (
                                  <Input
                                    label="IVFFlat Lists"
                                    type="number"
                                    min="1"
                                    value={formData.genieSemanticCacheIvfflatLists.toString()}
                                    onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheIvfflatLists: parseInt(e.target.value) || 100 })}
                                    hint="Number of IVF lists (auto: max(100, sqrt(rows)))"
                                  />
                                )}
                              </div>
                              <div className="space-y-1">
                                <label className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={formData.genieSemanticCacheIvfflatProbesAuto}
                                    onChange={(e) => setFormData({ ...formData, genieSemanticCacheIvfflatProbesAuto: e.target.checked })}
                                    className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                  />
                                  <span className="text-xs text-slate-400">Auto-compute probes</span>
                                </label>
                                {!formData.genieSemanticCacheIvfflatProbesAuto && (
                                  <Input
                                    label="IVFFlat Probes"
                                    type="number"
                                    min="1"
                                    value={formData.genieSemanticCacheIvfflatProbes.toString()}
                                    onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheIvfflatProbes: parseInt(e.target.value) || 10 })}
                                    hint="Lists to probe per query (auto: max(10, sqrt(lists)))"
                                  />
                                )}
                              </div>
                            </div>
                            <Input
                              label="IVFFlat Candidates"
                              type="number"
                              min="1"
                              value={formData.genieSemanticCacheIvfflatCandidates.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieSemanticCacheIvfflatCandidates: parseInt(e.target.value) || 20 })}
                              hint="Top-K candidates before Python-side reranking (default: 20)"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* In-Memory Context-Aware Cache (no database required) */}
                    <div className="space-y-2 mt-4 pt-4 border-t border-slate-700/50">
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={formData.genieInMemoryCacheEnabled}
                          onChange={(e) => setFormData({ ...formData, genieInMemoryCacheEnabled: e.target.checked })}
                          className="mt-0.5 w-4 h-4 rounded border-slate-600 bg-slate-800 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
                        />
                        <div>
                          <span className="text-sm font-medium text-slate-300 group-hover:text-white">Enable In-Memory Context-Aware Cache</span>
                          <p className="text-xs text-slate-500">Context-aware similarity matching stored in memory (no database required, single-instance only)</p>
                        </div>
                      </label>
                      
                      {formData.genieInMemoryCacheEnabled && (
                        <div className="ml-7 space-y-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Similarity Threshold"
                              type="number"
                              step="0.01"
                              min="0"
                              max="1"
                              value={formData.genieInMemoryCacheSimilarityThreshold.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheSimilarityThreshold: parseFloat(e.target.value) || 0.85 })}
                              hint="Min similarity for question matching (0-1)"
                            />
                            <Input
                              label="Context Similarity Threshold"
                              type="number"
                              step="0.01"
                              min="0"
                              max="1"
                              value={formData.genieInMemoryCacheContextSimilarityThreshold.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheContextSimilarityThreshold: parseFloat(e.target.value) || 0.80 })}
                              hint="Min similarity for context matching (0-1)"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Question Weight"
                              type="number"
                              step="0.1"
                              min="0"
                              max="1"
                              value={formData.genieInMemoryCacheQuestionWeight.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                const qw = parseFloat(e.target.value) || 0.6;
                                setFormData({ ...formData, genieInMemoryCacheQuestionWeight: qw, genieInMemoryCacheContextWeight: 1 - qw });
                              }}
                              hint="Weight for question similarity (0-1)"
                            />
                            <Input
                              label="Context Weight"
                              type="number"
                              step="0.1"
                              min="0"
                              max="1"
                              value={formData.genieInMemoryCacheContextWeight.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                const cw = parseFloat(e.target.value) || 0.4;
                                setFormData({ ...formData, genieInMemoryCacheContextWeight: cw, genieInMemoryCacheQuestionWeight: 1 - cw });
                              }}
                              hint="Weight for context similarity (0-1)"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <Input
                              label="Context Window Size"
                              type="number"
                              min="1"
                              value={formData.genieInMemoryCacheContextWindowSize.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheContextWindowSize: parseInt(e.target.value) || 3 })}
                              hint="Number of previous turns to include"
                            />
                            <Input
                              label="Max Context Tokens"
                              type="number"
                              min="100"
                              value={formData.genieInMemoryCacheMaxContextTokens.toString()}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheMaxContextTokens: parseInt(e.target.value) || 2000 })}
                              hint="Maximum context length"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-slate-300">Max Cache Entries</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min="100"
                                  value={formData.genieInMemoryCacheCapacityUnlimited ? '' : formData.genieInMemoryCacheCapacity}
                                  onChange={(e) => setFormData({ ...formData, genieInMemoryCacheCapacity: parseInt(e.target.value) || 10000 })}
                                  disabled={formData.genieInMemoryCacheCapacityUnlimited}
                                  className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                                />
                                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer whitespace-nowrap">
                                  <input
                                    type="checkbox"
                                    checked={formData.genieInMemoryCacheCapacityUnlimited}
                                    onChange={(e) => setFormData({ ...formData, genieInMemoryCacheCapacityUnlimited: e.target.checked })}
                                    className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                  />
                                  Unlimited
                                </label>
                              </div>
                              <p className="text-xs text-slate-500">LRU eviction when full (~200MB per 10k entries)</p>
                            </div>
                            <div className="space-y-2">
                              <label className="block text-sm font-medium text-slate-300">TTL (seconds)</label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min="1"
                                  value={formData.genieInMemoryCacheTtlNeverExpires ? '' : formData.genieInMemoryCacheTtl}
                                  onChange={(e) => setFormData({ ...formData, genieInMemoryCacheTtl: parseInt(e.target.value) || 604800 })}
                                  disabled={formData.genieInMemoryCacheTtlNeverExpires}
                                  className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
                                />
                                <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer whitespace-nowrap">
                                  <input
                                    type="checkbox"
                                    checked={formData.genieInMemoryCacheTtlNeverExpires}
                                    onChange={(e) => setFormData({ ...formData, genieInMemoryCacheTtlNeverExpires: e.target.checked })}
                                    className="w-3 h-3 rounded border-slate-600 bg-slate-800 text-violet-500"
                                  />
                                  Never
                                </label>
                              </div>
                              <p className="text-xs text-slate-500">Default: 604800 (1 week)</p>
                            </div>
                          </div>
                          <ResourceSelector
                            label="Embedding Model"
                            resourceType="LLM"
                            configuredOptions={configuredLlmOptions}
                            configuredValue={formData.genieInMemoryCacheEmbeddingModelRefName}
                            onConfiguredChange={(value) => setFormData({ ...formData, genieInMemoryCacheEmbeddingModelRefName: value, genieInMemoryCacheEmbeddingModelManual: '' })}
                            source={formData.genieInMemoryCacheEmbeddingModelSource}
                            onSourceChange={(source) => setFormData({ ...formData, genieInMemoryCacheEmbeddingModelSource: source })}
                            hint="Model for computing embeddings"
                          >
                            <Input
                              label="Model Name"
                              placeholder="databricks-gte-large-en"
                              value={formData.genieInMemoryCacheEmbeddingModelManual}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheEmbeddingModelManual: e.target.value, genieInMemoryCacheEmbeddingModelRefName: '' })}
                              hint="Enter embedding model name manually"
                            />
                          </ResourceSelector>
                          <ResourceSelector
                            label="Warehouse"
                            resourceType="Warehouse"
                            configuredOptions={configuredWarehouseOptions}
                            configuredValue={formData.genieInMemoryCacheWarehouseRefName}
                            onConfiguredChange={(value) => setFormData({ ...formData, genieInMemoryCacheWarehouseRefName: value, genieInMemoryCacheWarehouseId: '' })}
                            source={formData.genieInMemoryCacheWarehouseSource}
                            onSourceChange={(source) => setFormData({ ...formData, genieInMemoryCacheWarehouseSource: source })}
                            hint="SQL warehouse for re-executing cached SQL (required)"
                          >
                            <Input
                              label="Warehouse ID"
                              placeholder="Enter warehouse ID"
                              value={formData.genieInMemoryCacheWarehouseId}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, genieInMemoryCacheWarehouseId: e.target.value, genieInMemoryCacheWarehouseRefName: '' })}
                            />
                          </ResourceSelector>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Vector Search Tool Configuration */}
              {formData.functionName === 'dao_ai.tools.create_vector_search_tool' && (
                <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                  <h4 className="text-sm font-medium text-slate-300">Vector Search Configuration</h4>
                  
                  {/* Source Type Toggle - Retriever or Vector Store */}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-400">Source Type:</label>
                    <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, vectorSearchSourceType: 'retriever' })}
                        className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                          formData.vectorSearchSourceType === 'retriever'
                            ? 'bg-teal-500/20 text-teal-400 border border-teal-500/40'
                            : 'text-slate-400 border border-transparent hover:text-slate-300'
                        }`}
                      >
                        Retriever
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, vectorSearchSourceType: 'vector_store' })}
                        className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                          formData.vectorSearchSourceType === 'vector_store'
                            ? 'bg-teal-500/20 text-teal-400 border border-teal-500/40'
                            : 'text-slate-400 border border-transparent hover:text-slate-300'
                        }`}
                      >
                        Vector Store
                      </button>
                    </div>
                    <p className="text-xs text-slate-500">
                      {formData.vectorSearchSourceType === 'retriever' 
                        ? 'Retriever provides full search configuration with parameters and optional reranking'
                        : 'Vector Store uses default search parameters for simpler configuration'
                      }
                    </p>
                  </div>

                  {/* Retriever Configuration */}
                  {formData.vectorSearchSourceType === 'retriever' && (
                    <ResourceSelector
                      label="Retriever"
                      resourceType="Retriever"
                      configuredOptions={configuredRetrieverOptions}
                      configuredValue={formData.retrieverRefName}
                      onConfiguredChange={(value) => setFormData({ 
                        ...formData, 
                        retrieverRefName: value, 
                        vectorEndpoint: '', 
                        vectorIndex: '' 
                      })}
                      source={formData.retrieverSource}
                      onSourceChange={(source) => setFormData({ ...formData, retrieverSource: source })}
                      hint={formData.retrieverSource === 'configured' ? 'Use a pre-configured retriever from the Retrievers section' : undefined}
                    >
                      <div className="space-y-4">
                        <VectorSearchEndpointSelect
                          label="Vector Search Endpoint"
                          value={formData.vectorEndpoint}
                          onChange={(value) => setFormData({ ...formData, vectorEndpoint: value, vectorIndex: '', retrieverRefName: '' })}
                          required
                        />
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <label className="block text-sm font-medium text-slate-300">Vector Index</label>
                            {formData.vectorEndpoint && (
                              <button
                                type="button"
                                onClick={() => refetchIndexes()}
                                className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                                disabled={vectorIndexesLoading}
                              >
                                <RefreshCw className={`w-3 h-3 ${vectorIndexesLoading ? 'animate-spin' : ''}`} />
                                <span>Refresh</span>
                              </button>
                            )}
                          </div>
                          <Select
                            options={vectorIndexOptions}
                            value={formData.vectorIndex}
                            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, vectorIndex: e.target.value })}
                            disabled={!formData.vectorEndpoint || vectorIndexesLoading}
                            required
                          />
                        </div>
                      </div>
                    </ResourceSelector>
                  )}

                  {/* Vector Store Configuration */}
                  {formData.vectorSearchSourceType === 'vector_store' && (
                    <ResourceSelector
                      label="Vector Store"
                      resourceType="Vector Store"
                      configuredOptions={configuredVectorStoreOptions}
                      configuredValue={formData.vectorStoreRefName}
                      onConfiguredChange={(value) => setFormData({ 
                        ...formData, 
                        vectorStoreRefName: value, 
                        vsVectorEndpoint: '', 
                        vsVectorIndex: '',
                        vsVectorCatalog: '',
                        vsVectorSchema: ''
                      })}
                      source={formData.vectorStoreSource}
                      onSourceChange={(source) => setFormData({ ...formData, vectorStoreSource: source })}
                      hint={formData.vectorStoreSource === 'configured' ? 'Use a pre-configured vector store from the Resources section' : undefined}
                    >
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <CatalogSelect
                            label="Catalog"
                            value={formData.vsVectorCatalog}
                            onChange={(value: string) => setFormData({ 
                              ...formData, 
                              vsVectorCatalog: value, 
                              vsVectorSchema: '' 
                            })}
                            required
                          />
                          <SchemaSelect
                            label="Schema"
                            value={formData.vsVectorSchema}
                            catalog={formData.vsVectorCatalog}
                            onChange={(value: string) => setFormData({ 
                              ...formData, 
                              vsVectorSchema: value 
                            })}
                            required
                          />
                        </div>
                        <VectorSearchEndpointSelect
                          label="Vector Search Endpoint"
                          value={formData.vsVectorEndpoint}
                          onChange={(value) => setFormData({ 
                            ...formData, 
                            vsVectorEndpoint: value, 
                            vsVectorIndex: '' 
                          })}
                          required
                        />
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <label className="block text-sm font-medium text-slate-300">Vector Index</label>
                            {formData.vsVectorEndpoint && (
                              <button
                                type="button"
                                onClick={() => refetchIndexes()}
                                className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                                disabled={vectorIndexesLoading}
                              >
                                <RefreshCw className={`w-3 h-3 ${vectorIndexesLoading ? 'animate-spin' : ''}`} />
                                <span>Refresh</span>
                              </button>
                            )}
                          </div>
                          <Select
                            options={vectorIndexOptions}
                            value={formData.vsVectorIndex}
                            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, vsVectorIndex: e.target.value })}
                            disabled={!formData.vsVectorEndpoint || vectorIndexesLoading}
                            required
                          />
                        </div>
                      </div>
                    </ResourceSelector>
                  )}
                  
                  {/* Vector Search Options */}
                  <div className="pt-2 border-t border-slate-700">
                    <Input
                      label="Description"
                      placeholder="e.g., Search product documentation for answers"
                      value={formData.vectorSearchDescription}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, vectorSearchDescription: e.target.value })}
                      hint="Optional description for the tool (defaults to generic description)"
                    />
                  </div>
                </div>
              )}

              {/* Slack Message Tool Configuration */}
              {formData.functionName === 'dao_ai.tools.create_send_slack_message_tool' && (
                <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                  <h4 className="text-sm font-medium text-slate-300">Slack Message Tool Configuration</h4>
                  
                  <ResourceSelector
                    label="Slack Connection"
                    resourceType="Connection"
                    configuredOptions={configuredConnectionOptions}
                    configuredValue={formData.slackConnectionRefName}
                    onConfiguredChange={(value) => setFormData({ ...formData, slackConnectionRefName: value })}
                    source={formData.slackConnectionSource}
                    onSourceChange={(source) => setFormData({ ...formData, slackConnectionSource: source })}
                    hint="Unity Catalog connection to Slack"
                  >
                    <p className="text-sm text-slate-400">
                      Select a configured connection or create one in the Resources section
                    </p>
                  </ResourceSelector>
                  
                  <div className="space-y-3 pt-2 border-t border-slate-700">
                    <h5 className="text-xs font-medium text-slate-400 uppercase tracking-wider">Channel Configuration</h5>
                    <p className="text-xs text-slate-500">Provide either a Channel ID or Channel Name. Channel ID is preferred if known.</p>
                    
                    <Input
                      label="Channel ID"
                      placeholder="e.g., C1234567890"
                      value={formData.slackChannelId}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, slackChannelId: e.target.value })}
                      hint="Slack channel ID (e.g., C1234567890). Takes precedence over channel name."
                    />
                    
                    <Input
                      label="Channel Name"
                      placeholder="e.g., general or #general"
                      value={formData.slackChannelName}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, slackChannelName: e.target.value })}
                      hint="Slack channel name. Used to lookup channel ID if not provided above."
                    />
                  </div>
                </div>
              )}

              {/* Agent Endpoint Tool Configuration */}
              {formData.functionName === 'dao_ai.tools.create_agent_endpoint_tool' && (
                <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                  <h4 className="text-sm font-medium text-slate-300">Agent Endpoint Tool Configuration</h4>
                  
                  <ResourceSelector
                    label="LLM / Agent Endpoint"
                    resourceType="LLM"
                    configuredOptions={configuredLlmOptions}
                    configuredValue={formData.agentLlmRefName}
                    onConfiguredChange={(value) => setFormData({ ...formData, agentLlmRefName: value })}
                    source={formData.agentLlmSource}
                    onSourceChange={(source) => setFormData({ ...formData, agentLlmSource: source })}
                    hint="Select the LLM or agent endpoint to call"
                  >
                    <p className="text-sm text-slate-400">
                      Configure an LLM in the Resources section, then select it here
                    </p>
                  </ResourceSelector>
                </div>
              )}

              {/* Email Tool Configuration */}
              {formData.functionName === 'dao_ai.tools.create_send_email_tool' && (
                <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                  <h4 className="text-sm font-medium text-slate-300">Email Tool Configuration</h4>
                  
                  <div className="space-y-3">
                    <p className="text-sm text-slate-400">Configure SMTP settings for sending emails</p>
                    
                    {/* SMTP Host */}
                    <CredentialInput
                      label="SMTP Host"
                      manualValue={formData.emailHost}
                      onManualChange={(value) => setFormData({ ...formData, emailHost: value })}
                      variableValue={formData.emailHostVariable}
                      onVariableChange={(value) => setFormData({ ...formData, emailHostVariable: value })}
                      source={formData.emailHostSource}
                      onSourceChange={(source) => setFormData({ ...formData, emailHostSource: source })}
                      placeholder="smtp.gmail.com"
                      hint="SMTP server hostname"
                      variables={variables}
                    />
                    
                    {/* SMTP Port */}
                    <CredentialInput
                      label="SMTP Port"
                      manualValue={formData.emailPort}
                      onManualChange={(value) => setFormData({ ...formData, emailPort: value })}
                      variableValue={formData.emailPortVariable}
                      onVariableChange={(value) => setFormData({ ...formData, emailPortVariable: value })}
                      source={formData.emailPortSource}
                      onSourceChange={(source) => setFormData({ ...formData, emailPortSource: source })}
                      placeholder="587"
                      hint="SMTP server port (typically 587 for TLS)"
                      variables={variables}
                      type="number"
                    />
                    
                    {/* SMTP Username */}
                    <CredentialInput
                      label="SMTP Username"
                      manualValue={formData.emailUsername}
                      onManualChange={(value) => setFormData({ ...formData, emailUsername: value })}
                      variableValue={formData.emailUsernameVariable}
                      onVariableChange={(value) => setFormData({ ...formData, emailUsernameVariable: value })}
                      source={formData.emailUsernameSource}
                      onSourceChange={(source) => setFormData({ ...formData, emailUsernameSource: source })}
                      placeholder="user@example.com"
                      hint="SMTP authentication username"
                      variables={variables}
                      required
                    />
                    
                    {/* SMTP Password */}
                    <CredentialInput
                      label="SMTP Password"
                      manualValue={formData.emailPassword}
                      onManualChange={(value) => setFormData({ ...formData, emailPassword: value })}
                      variableValue={formData.emailPasswordVariable}
                      onVariableChange={(value) => setFormData({ ...formData, emailPasswordVariable: value })}
                      source={formData.emailPasswordSource}
                      onSourceChange={(source) => setFormData({ ...formData, emailPasswordSource: source })}
                      placeholder="password or app-specific password"
                      hint="SMTP authentication password (recommended: use a variable for security)"
                      variables={variables}
                      type="password"
                      required
                    />
                    
                    {/* Sender Email (Optional) */}
                    <CredentialInput
                      label="Sender Email (Optional)"
                      manualValue={formData.emailSenderEmail}
                      onManualChange={(value) => setFormData({ ...formData, emailSenderEmail: value })}
                      variableValue={formData.emailSenderEmailVariable}
                      onVariableChange={(value) => setFormData({ ...formData, emailSenderEmailVariable: value })}
                      source={formData.emailSenderEmailSource}
                      onSourceChange={(source) => setFormData({ ...formData, emailSenderEmailSource: source })}
                      placeholder="bot@example.com (defaults to username)"
                      hint="Email address to use as sender. If not provided, username will be used."
                      variables={variables}
                    />
                    
                    {/* Use TLS */}
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        id="emailUseTls"
                        checked={formData.emailUseTls}
                        onChange={(e) => setFormData({ ...formData, emailUseTls: e.target.checked })}
                        className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500"
                      />
                      <label htmlFor="emailUseTls" className="text-sm text-slate-300">
                        Use TLS Encryption (Recommended)
                      </label>
                    </div>
                    
                    {/* Tool Name (Optional) */}
                    <Input
                      label="Tool Name (Optional)"
                      value={formData.emailToolName}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, emailToolName: e.target.value })}
                      placeholder="send_email"
                      hint="Custom name for the email tool function"
                    />
                    
                    {/* Tool Description (Optional) */}
                    <Textarea
                      label="Tool Description (Optional)"
                      value={formData.emailToolDescription}
                      onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, emailToolDescription: e.target.value })}
                      placeholder="Send an email to a recipient"
                      rows={2}
                      hint="Custom description for the email tool"
                    />
                  </div>
                </div>
              )}

              {/* Custom Factory */}
              {formData.functionName === 'custom' && (
                <Input
                  label="Custom Factory Function"
                  placeholder="e.g., my_package.tools.my_factory"
                  value={formData.customFunctionName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, customFunctionName: e.target.value })}
                  required
                />
              )}

              {/* JSON args for custom factory tools only */}
              {formData.functionName === 'custom' && (
                <Textarea
                  label="Arguments (JSON)"
                  placeholder='{"key": "value"}'
                  value={formData.args}
                  onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFormData({ ...formData, args: e.target.value })}
                  rows={6}
                  hint="JSON object passed to the factory function"
                />
              )}
            </>
          )}

          {/* Python Function */}
          {formData.type === 'python' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300">Python Tool Function</label>
                <p className="text-xs text-slate-500">
                  Python functions decorated with @tool that can be used directly as tools
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {PYTHON_TOOLS.map((tool) => {
                    const Icon = tool.icon;
                    const isSelected = formData.functionName === tool.value;
                    return (
                      <button
                        key={tool.value}
                        type="button"
                        onClick={() => {
                          const generatedName = tool.value !== 'custom' ? generateToolName(tool.value) : '';
                          setFormData({ 
                            ...formData, 
                            functionName: tool.value,
                            customFunctionName: '',
                            // Auto-generate tool name if not manually edited
                            name: nameManuallyEdited ? formData.name : generatedName,
                            // Auto-generate ref name if not manually edited
                            refName: refNameManuallyEdited ? formData.refName : generatedName,
                          });
                        }}
                        className={`p-3 rounded-lg border text-left transition-all ${
                          isSelected
                            ? 'border-violet-500 bg-violet-500/10'
                            : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                        }`}
                      >
                        <div className="flex items-start space-x-2">
                          <Icon className={`w-4 h-4 mt-0.5 ${isSelected ? 'text-violet-400' : 'text-slate-400'}`} />
                          <div>
                            <div className={`text-sm font-medium ${isSelected ? 'text-violet-400' : 'text-slate-300'}`}>
                              {tool.label}
                            </div>
                            <div className="text-xs text-slate-500">{tool.description}</div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom Python Function Path */}
              {formData.functionName === 'custom' && (
            <Input
                  label="Custom Python Function Path"
              placeholder="e.g., my_package.tools.my_function"
                  value={formData.customFunctionName}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const funcName = e.target.value;
                    const generatedName = generateToolName(funcName);
                    setFormData({ 
                      ...formData, 
                      customFunctionName: funcName,
                      // Auto-generate tool name if not manually edited
                      name: nameManuallyEdited ? formData.name : generatedName,
                      // Auto-generate ref name if not manually edited
                      refName: refNameManuallyEdited ? formData.refName : generatedName,
                    });
                  }}
                  hint="Fully qualified path to a Python function decorated with @tool"
              required
            />
              )}
            </div>
          )}

          {/* Inline Function */}
          {formData.type === 'inline' && (
            <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              <h4 className="text-sm font-medium text-slate-300">Inline Function Code</h4>
              <p className="text-xs text-slate-500">
                Define a Python tool function directly in the configuration. The code must import @tool from langchain.tools and define exactly one function decorated with @tool.
              </p>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300">Python Code</label>
                <textarea
                  value={formData.inlineCode}
                  onChange={(e) => setFormData({ ...formData, inlineCode: e.target.value })}
                  placeholder={`from langchain.tools import tool

@tool
def my_tool(param: str) -> str:
    """Description of what this tool does.
    
    Args:
        param: Description of the parameter
        
    Returns:
        The result of the tool
    """
    # Your tool logic here
    return f"Result: {param}"`}
                  className="w-full h-64 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500 font-mono text-sm"
                  spellCheck={false}
                />
                <p className="text-xs text-slate-500">
                  The function name defined in the code becomes the tool name used by the agent.
                </p>
              </div>
            </div>
          )}

          {/* Unity Catalog Function */}
          {formData.type === 'unity_catalog' && (
            <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              <h4 className="text-sm font-medium text-slate-300">Unity Catalog Function</h4>
              
              {/* Function Source Toggle */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-300">Function Source</label>
                  <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, functionSource: 'configured', ucCatalog: '', ucSchema: '', ucFunction: '' })}
                      className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                        formData.functionSource === 'configured'
                          ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                          : 'text-slate-400 border border-transparent hover:text-slate-300'
                      }`}
                    >
                      Configured
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, functionSource: 'select', functionRefName: '' })}
                      className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                        formData.functionSource === 'select'
                          ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                          : 'text-slate-400 border border-transparent hover:text-slate-300'
                      }`}
                    >
                      Select
                    </button>
                  </div>
                </div>
              </div>

              {/* Configured Function Selection */}
              {formData.functionSource === 'configured' && (
                <div className="space-y-2">
                  <Select
                    options={[
                      { value: '', label: 'Select a configured function...' },
                      ...configuredFunctionOptions
                    ]}
                    value={formData.functionRefName}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      const value = e.target.value;
                      const func = configuredFunctions[value];
                      const generatedName = generateToolName(func?.name || value);
                      setFormData({ 
                        ...formData, 
                        functionRefName: value, 
                        ucFunction: '',
                        ucCatalog: '',
                        ucSchema: '',
                        // Auto-generate tool name if not manually edited
                        name: nameManuallyEdited ? formData.name : generatedName,
                        // Auto-generate ref name if not manually edited
                        refName: refNameManuallyEdited ? formData.refName : generatedName,
                      });
                    }}
                  />
                  {configuredFunctionOptions.length === 0 && (
                    <p className="text-xs text-amber-400">
                      No functions configured. Add one in Resources → Functions or switch to "Select".
                    </p>
                  )}
                  <p className="text-xs text-slate-500">
                    Select a pre-configured function from the Resources section
                  </p>
                </div>
              )}

              {/* Direct Function Selection */}
              {formData.functionSource === 'select' && (
                <div className="space-y-4">
                  {/* Schema Selection */}
                  <ResourceSelector
                    label="Schema"
                    resourceType="schema"
                    configuredOptions={configuredSchemaOptions}
                    configuredValue={formData.schemaRefName}
                    onConfiguredChange={(value) => {
                      const schema = configuredSchemas[value];
                      setFormData({ 
                        ...formData, 
                        schemaRefName: value,
                        ucCatalog: getVariableDisplayValue(schema?.catalog_name),
                        ucSchema: getVariableDisplayValue(schema?.schema_name),
                        ucFunction: ''
                      });
                    }}
                    source={formData.schemaSource}
                    onSourceChange={(source) => setFormData({ ...formData, schemaSource: source })}
                  >
                    <div className="grid grid-cols-2 gap-4">
              <CatalogSelect
                label="Catalog"
                value={formData.ucCatalog}
                        onChange={(value) => setFormData({ ...formData, ucCatalog: value, ucSchema: '', ucFunction: '', schemaRefName: '' })}
                required
              />
              <SchemaSelect
                label="Schema"
                value={formData.ucSchema}
                        onChange={(value) => setFormData({ ...formData, ucSchema: value, ucFunction: '', schemaRefName: '' })}
                catalog={formData.ucCatalog || null}
                required
              />
                    </div>
                  </ResourceSelector>

                  {/* Function Selection from Schema */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-300">Function</label>
                      {(formData.ucCatalog && formData.ucSchema) || formData.schemaRefName ? (
                    <button
                      type="button"
                      onClick={() => refetchFunctions()}
                      className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                      disabled={ucFunctionsLoading}
                    >
                      <RefreshCw className={`w-3 h-3 ${ucFunctionsLoading ? 'animate-spin' : ''}`} />
                      <span>Refresh</span>
                    </button>
                      ) : null}
                </div>
                <Select
                  options={ucFunctionOptions}
                  value={formData.ucFunction}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                        const funcFullName = e.target.value;
                        const generatedName = generateToolName(funcFullName);
                        setFormData({ 
                          ...formData, 
                          ucFunction: funcFullName, 
                          functionRefName: '',
                          // Auto-generate tool name if not manually edited
                          name: nameManuallyEdited ? formData.name : generatedName,
                          // Auto-generate ref name if not manually edited
                          refName: refNameManuallyEdited ? formData.refName : generatedName,
                        });
                      }}
                      disabled={(!formData.ucCatalog || !formData.ucSchema) && !formData.schemaRefName || ucFunctionsLoading}
                  required
                />
                {ucFunctionsLoading && (
                  <p className="text-xs text-slate-500">Loading functions...</p>
                )}
                    {!formData.ucCatalog && !formData.ucSchema && !formData.schemaRefName && (
                      <p className="text-xs text-slate-500">Select a schema first to browse functions</p>
                )}
              </div>
            </div>
          )}

              {/* Partial Arguments Section */}
              <div className="space-y-3 pt-3 border-t border-slate-700">
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="text-sm font-medium text-slate-300">Partial Arguments</h5>
                    <p className="text-xs text-slate-500">Pre-fill function parameters with static values or variable references</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFormData({
                      ...formData,
                      ucPartialArgs: [...formData.ucPartialArgs, { id: `arg_${Date.now()}`, name: '', source: 'manual', value: '' }]
                    })}
                    className="flex items-center space-x-1 text-xs text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    <span>Add Argument</span>
                  </button>
                </div>

                {formData.ucPartialArgs.length === 0 ? (
                  <p className="text-xs text-slate-500 italic">No partial arguments configured. Click "Add Argument" to pre-fill function parameters.</p>
                ) : (
                  <div className="space-y-3">
                    {formData.ucPartialArgs.map((arg, index) => (
                      <div key={arg.id} className="p-3 bg-slate-900/50 rounded-lg border border-slate-600 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 grid grid-cols-2 gap-3">
                            <Input
                              label="Parameter Name"
                              value={arg.name}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                const newArgs = [...formData.ucPartialArgs];
                                newArgs[index] = { ...arg, name: e.target.value };
                                setFormData({ ...formData, ucPartialArgs: newArgs });
                              }}
                              placeholder="e.g., host, client_id"
                            />
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between">
                                <label className="block text-sm font-medium text-slate-300">Value Source</label>
                                <div className="inline-flex rounded-lg bg-slate-800 p-0.5 text-xs">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newArgs = [...formData.ucPartialArgs];
                                      newArgs[index] = { ...arg, source: 'manual', value: '' };
                                      setFormData({ ...formData, ucPartialArgs: newArgs });
                                    }}
                                    className={`px-2 py-1 rounded font-medium transition-all ${
                                      arg.source === 'manual'
                                        ? 'bg-violet-500/20 text-violet-400'
                                        : 'text-slate-400 hover:text-slate-300'
                                    }`}
                                  >
                                    Manual
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newArgs = [...formData.ucPartialArgs];
                                      newArgs[index] = { ...arg, source: 'variable', value: '' };
                                      setFormData({ ...formData, ucPartialArgs: newArgs });
                                    }}
                                    className={`px-2 py-1 rounded font-medium transition-all ${
                                      arg.source === 'variable'
                                        ? 'bg-violet-500/20 text-violet-400'
                                        : 'text-slate-400 hover:text-slate-300'
                                    }`}
                                  >
                                    Variable
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const newArgs = [...formData.ucPartialArgs];
                                      newArgs[index] = { ...arg, source: 'service_principal', value: '' };
                                      setFormData({ ...formData, ucPartialArgs: newArgs });
                                    }}
                                    className={`px-2 py-1 rounded font-medium transition-all ${
                                      arg.source === 'service_principal'
                                        ? 'bg-violet-500/20 text-violet-400'
                                        : 'text-slate-400 hover:text-slate-300'
                                    }`}
                                  >
                                    SP
                                  </button>
                                </div>
                              </div>
                              {arg.source === 'manual' && (
                                <Input
                                  value={arg.value}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                    const newArgs = [...formData.ucPartialArgs];
                                    newArgs[index] = { ...arg, value: e.target.value };
                                    setFormData({ ...formData, ucPartialArgs: newArgs });
                                  }}
                                  placeholder="Enter value..."
                                />
                              )}
                              {arg.source === 'variable' && (
                                <Select
                                  value={arg.value}
                                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                                    const newArgs = [...formData.ucPartialArgs];
                                    newArgs[index] = { ...arg, value: e.target.value };
                                    setFormData({ ...formData, ucPartialArgs: newArgs });
                                  }}
                                  options={variableOptions}
                                />
                              )}
                              {arg.source === 'service_principal' && (
                                <Select
                                  value={arg.value}
                                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                                    const newArgs = [...formData.ucPartialArgs];
                                    newArgs[index] = { ...arg, value: e.target.value };
                                    setFormData({ ...formData, ucPartialArgs: newArgs });
                                  }}
                                  options={servicePrincipalOptions}
                                />
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const newArgs = formData.ucPartialArgs.filter(a => a.id !== arg.id);
                              setFormData({ ...formData, ucPartialArgs: newArgs });
                            }}
                            className="mt-6 p-1 text-slate-400 hover:text-red-400 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Human In The Loop Configuration - Available for all tool types */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => setShowHitlConfig(!showHitlConfig)}
              className="flex items-center space-x-2 text-sm text-slate-400 hover:text-white transition-colors w-full"
            >
              {showHitlConfig ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <UserCheck className="w-4 h-4" />
              <span>Human In The Loop</span>
              {hitlForm.enabled && (
                <Badge variant="success" className="ml-2">Enabled</Badge>
              )}
            </button>

            {showHitlConfig && (
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
                {/* Enable HITL */}
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="hitlEnabled"
                    checked={hitlForm.enabled}
                    onChange={(e) => setHitlForm({ ...hitlForm, enabled: e.target.checked })}
                    className="mt-1 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                  />
                  <div>
                    <label htmlFor="hitlEnabled" className="block text-sm font-medium text-slate-300 cursor-pointer">
                      Require Human Approval
                    </label>
                    <p className="text-xs text-slate-500 mt-1">
                      Pause execution and request human review before this tool runs.
                    </p>
                  </div>
                </div>

                {hitlForm.enabled && (
                  <>
                    {/* Review Prompt */}
                    <Input
                      label="Review Prompt"
                      value={hitlForm.reviewPrompt}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setHitlForm({ ...hitlForm, reviewPrompt: e.target.value })}
                      placeholder="Please review the tool call"
                      hint="Message shown to the reviewer"
                    />

                    {/* Allowed Decisions */}
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-2">Allowed Decisions</label>
                      <p className="text-xs text-slate-500 mb-3">
                        Select which decision types the reviewer can choose from
                      </p>
                      <div className="grid grid-cols-3 gap-2">
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hitlForm.allowApprove}
                            onChange={(e) => setHitlForm({ ...hitlForm, allowApprove: e.target.checked })}
                            className="rounded border-slate-600 bg-slate-800 text-green-500 focus:ring-green-500"
                          />
                          <span className="text-sm text-slate-400">Approve</span>
                        </label>
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hitlForm.allowEdit}
                            onChange={(e) => setHitlForm({ ...hitlForm, allowEdit: e.target.checked })}
                            className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                          />
                          <span className="text-sm text-slate-400">Edit</span>
                        </label>
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hitlForm.allowReject}
                            onChange={(e) => setHitlForm({ ...hitlForm, allowReject: e.target.checked })}
                            className="rounded border-slate-600 bg-slate-800 text-red-500 focus:ring-red-500"
                          />
                          <span className="text-sm text-slate-400">Reject</span>
                        </label>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        <strong>Approve:</strong> Execute with original arguments • 
                        <strong> Edit:</strong> Modify arguments before execution • 
                        <strong> Reject:</strong> Skip execution
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* MCP Tool Configuration */}
          {formData.type === 'mcp' && (
            <div className="space-y-4">
              {/* MCP Source Type Selection */}
              <div className="space-y-2">
                <label className="block text-sm font-medium text-slate-300">MCP Server Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {MCP_SOURCE_TYPES.map((source) => {
                    const isSelected = mcpForm.sourceType === source.value;
                    return (
                      <button
                        key={source.value}
                        type="button"
                        onClick={() => {
                          setMcpForm({ ...mcpForm, sourceType: source.value as MCPFormData['sourceType'] });
                          
                          // For SQL type, auto-generate default names if not manually edited
                          if (source.value === 'sql' && !nameManuallyEdited) {
                            const generatedName = generateMcpToolName('sql', 'databricks');
                            setFormData(prev => ({ ...prev, name: generatedName }));
                          }
                          if (source.value === 'sql' && !refNameManuallyEdited) {
                            const generatedName = generateMcpToolName('sql', 'databricks');
                            setFormData(prev => ({ ...prev, refName: generatedName }));
                          }
                        }}
                        className={`p-3 rounded-lg border text-left transition-all ${
                          isSelected
                            ? 'border-purple-500 bg-purple-500/10'
                            : 'border-slate-700 hover:border-slate-600 bg-slate-800/50'
                        }`}
                      >
                        <span className={`text-sm font-medium ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                          {source.label}
                        </span>
                        <p className="text-xs text-slate-500 mt-1">{source.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Source-specific configuration */}
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
                {mcpForm.sourceType === 'url' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-slate-300">MCP Server URL</label>
                      <div className="flex space-x-1">
                        <button
                          type="button"
                          onClick={() => setMcpForm({ ...mcpForm, urlSource: 'manual', urlVariable: '' })}
                          className={`px-2 py-1 text-xs rounded ${
                            mcpForm.urlSource === 'manual' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                          }`}
                        >
                          Manual
                        </button>
                        <button
                          type="button"
                          onClick={() => setMcpForm({ ...mcpForm, urlSource: 'variable', url: '' })}
                          className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                            mcpForm.urlSource === 'variable' ? 'bg-purple-500/30 text-purple-300' : 'bg-slate-700 text-slate-400'
                          }`}
                        >
                          <span>Variable</span>
                        </button>
                      </div>
                    </div>
                    
                    {mcpForm.urlSource === 'manual' && (
                      <Input
                        placeholder="https://your-workspace.databricks.net/api/2.0/mcp/..."
                        value={mcpForm.url}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, url: e.target.value })}
                        hint="Full URL to the MCP server endpoint"
                        required
                      />
                    )}
                    
                    {mcpForm.urlSource === 'variable' && (
                      <div className="space-y-2">
                        {Object.keys(config.variables || {}).length > 0 ? (
                          <Select
                            value={mcpForm.urlVariable}
                            onChange={(e: ChangeEvent<HTMLSelectElement>) => setMcpForm({ ...mcpForm, urlVariable: e.target.value })}
                            options={[
                              { value: '', label: 'Select a variable...' },
                              ...Object.keys(config.variables || {}).map(name => ({
                                value: name,
                                label: name,
                              })),
                            ]}
                          />
                        ) : (
                          <Input
                            value={mcpForm.urlVariable}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, urlVariable: e.target.value })}
                            placeholder="mcp_server_url"
                          />
                        )}
                        <p className="text-xs text-slate-500">
                          Reference a variable containing the MCP server URL
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {mcpForm.sourceType === 'genie' && (
                  <>
                    <ResourceSelector
                      label="Genie Room"
                      resourceType="Genie room"
                      configuredOptions={configuredGenieOptions}
                      configuredValue={mcpForm.genieRefName}
                      onConfiguredChange={(value) => {
                        // Auto-populate name and description from configured Genie Room
                        const room = configuredGenieRooms[value];
                        const generatedName = generateMcpToolName('genie', room?.name || value);
                        
                        setMcpForm({ 
                          ...mcpForm, 
                          genieRefName: value, 
                          genieSpaceId: '',
                          genieName: room?.name || value,
                          genieDescription: room?.description || ''
                        });
                        
                        // Auto-generate tool name and ref name if not manually edited
                        if (!nameManuallyEdited) {
                          setFormData(prev => ({ ...prev, name: generatedName }));
                        }
                        if (!refNameManuallyEdited) {
                          setFormData(prev => ({ ...prev, refName: generatedName }));
                        }
                      }}
                      source={mcpForm.genieSource}
                      onSourceChange={(source) => {
                        if (source === 'select') {
                          // Switching to Select mode: clear configured reference and reset name/description
                          setMcpForm({ 
                            ...mcpForm, 
                            genieSource: source,
                            genieRefName: '',
                            genieName: '',
                            genieDescription: ''
                          });
                        } else {
                          // Switching to Configured mode: restore previously selected configured room if any
                          const previouslyConfiguredRef = mcpForm.genieRefName;
                          if (previouslyConfiguredRef && configuredGenieRooms[previouslyConfiguredRef]) {
                            const room = configuredGenieRooms[previouslyConfiguredRef];
                            setMcpForm({ 
                              ...mcpForm, 
                              genieSource: source,
                              genieSpaceId: '',
                              genieName: room?.name || previouslyConfiguredRef,
                              genieDescription: room?.description || ''
                            });
                          } else {
                            setMcpForm({ 
                              ...mcpForm, 
                              genieSource: source,
                              genieSpaceId: ''
                            });
                          }
                        }
                      }}
                      hint="Display Name and Description will auto-fill from your selection."
                    >
                      <GenieSpaceSelect
                        value={mcpForm.genieSpaceId}
                        onChange={(value) => {
                          // Auto-populate name and description from selected space
                          const space = genieSpaces?.find(s => s.space_id === value);
                          const spaceName = space?.title || '';
                          const spaceDesc = space?.description || '';
                          const generatedName = generateMcpToolName('genie', spaceName || value);
                          
                          setMcpForm({ 
                            ...mcpForm, 
                            genieSpaceId: value, 
                            genieRefName: '',
                            genieName: spaceName,
                            genieDescription: spaceDesc
                          });
                          
                          // Auto-generate tool name and ref name if not manually edited
                          if (!nameManuallyEdited) {
                            setFormData(prev => ({ ...prev, name: generatedName }));
                          }
                          if (!refNameManuallyEdited) {
                            setFormData(prev => ({ ...prev, refName: generatedName }));
                          }
                        }}
                        required
                      />
                    </ResourceSelector>
                    <Input
                      label="Display Name"
                      placeholder="e.g., Retail Genie"
                      value={mcpForm.genieName}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, genieName: e.target.value })}
                      hint="Name for this Genie Room configuration (auto-filled from selection)"
                    />
                    <Input
                      label="Description (optional)"
                      placeholder="Query retail data using natural language"
                      value={mcpForm.genieDescription}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, genieDescription: e.target.value })}
                      hint="Optional description (auto-filled from selection)"
                    />
                  </>
                )}

                {mcpForm.sourceType === 'vector_search' && (
                  <ResourceSelector
                    label="Vector Store"
                    resourceType="Vector store"
                    configuredOptions={configuredVectorStoreOptions}
                    configuredValue={mcpForm.vectorStoreRefName}
                    onConfiguredChange={(value) => {
                      const vectorStore = configuredVectorStores[value];
                      const indexName = (vectorStore as any)?.index?.name || value;
                      const generatedName = generateMcpToolName('vector_search', indexName);
                      
                      setMcpForm({ 
                        ...mcpForm, 
                        vectorStoreRefName: value, 
                        vectorEndpoint: '',
                        vectorIndex: '',
                        vectorCatalog: '',
                        vectorSchema: ''
                      });
                      
                      // Auto-generate tool name and ref name if not manually edited
                      if (!nameManuallyEdited) {
                        setFormData(prev => ({ ...prev, name: generatedName }));
                      }
                      if (!refNameManuallyEdited) {
                        setFormData(prev => ({ ...prev, refName: generatedName }));
                      }
                    }}
                    source={mcpForm.vectorStoreSource}
                    onSourceChange={(source) => setMcpForm({ ...mcpForm, vectorStoreSource: source })}
                  >
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <CatalogSelect
                          label="Catalog"
                          value={mcpForm.vectorCatalog}
                          onChange={(value) => setMcpForm({ ...mcpForm, vectorCatalog: value, vectorSchema: '', vectorStoreRefName: '' })}
                          required
                        />
                        <SchemaSelect
                          label="Schema"
                          value={mcpForm.vectorSchema}
                          onChange={(value) => setMcpForm({ ...mcpForm, vectorSchema: value, vectorStoreRefName: '' })}
                          catalog={mcpForm.vectorCatalog || null}
                          required
                        />
                      </div>
                      <VectorSearchEndpointSelect
                        label="Vector Search Endpoint"
                        value={mcpForm.vectorEndpoint}
                        onChange={(value) => setMcpForm({ ...mcpForm, vectorEndpoint: value, vectorIndex: '', vectorStoreRefName: '' })}
                        required
                      />
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <label className="block text-sm font-medium text-slate-300">Vector Index</label>
                          {mcpForm.vectorEndpoint && (
                            <button
                              type="button"
                              onClick={() => refetchMcpIndexes()}
                              className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                              disabled={mcpVectorIndexesLoading}
                            >
                              <RefreshCw className={`w-3 h-3 ${mcpVectorIndexesLoading ? 'animate-spin' : ''}`} />
                              <span>Refresh</span>
                            </button>
                          )}
                        </div>
                        <Select
                          options={mcpVectorIndexOptions}
                          value={mcpForm.vectorIndex}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                            const indexName = e.target.value;
                            const generatedName = generateMcpToolName('vector_search', indexName);
                            
                            setMcpForm({ ...mcpForm, vectorIndex: indexName });
                            
                            // Auto-generate tool name and ref name if not manually edited
                            if (!nameManuallyEdited) {
                              setFormData(prev => ({ ...prev, name: generatedName }));
                            }
                            if (!refNameManuallyEdited) {
                              setFormData(prev => ({ ...prev, refName: generatedName }));
                            }
                          }}
                          disabled={!mcpForm.vectorEndpoint || mcpVectorIndexesLoading}
                          required
                        />
                      </div>
                    </div>
                  </ResourceSelector>
                )}

                {mcpForm.sourceType === 'functions' && (
                  <ResourceSelector
                    label="Schema"
                    resourceType="schema"
                    configuredOptions={configuredSchemaOptions}
                    configuredValue={mcpForm.schemaRefName}
                    onConfiguredChange={(value) => {
                      const schema = configuredSchemas[value];
                      const schemaName = getVariableDisplayValue(schema?.schema_name) || value;
                      const generatedName = generateMcpToolName('functions', schemaName);
                      
                      setMcpForm({ 
                        ...mcpForm, 
                        schemaRefName: value,
                        functionsCatalog: getVariableDisplayValue(schema?.catalog_name),
                        functionsSchema: getVariableDisplayValue(schema?.schema_name)
                      });
                      
                      // Auto-generate tool name and ref name if not manually edited
                      if (!nameManuallyEdited) {
                        setFormData(prev => ({ ...prev, name: generatedName }));
                      }
                      if (!refNameManuallyEdited) {
                        setFormData(prev => ({ ...prev, refName: generatedName }));
                      }
                    }}
                    source={mcpForm.schemaSource}
                    onSourceChange={(source) => setMcpForm({ ...mcpForm, schemaSource: source })}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <CatalogSelect
                        label="Catalog"
                        value={mcpForm.functionsCatalog}
                        onChange={(value) => setMcpForm({ ...mcpForm, functionsCatalog: value, functionsSchema: '', schemaRefName: '' })}
                        required
                      />
                      <SchemaSelect
                        label="Schema"
                        value={mcpForm.functionsSchema}
                        onChange={(value) => {
                          const generatedName = generateMcpToolName('functions', value);
                          
                          setMcpForm({ ...mcpForm, functionsSchema: value, schemaRefName: '' });
                          
                          // Auto-generate tool name and ref name if not manually edited
                          if (!nameManuallyEdited) {
                            setFormData(prev => ({ ...prev, name: generatedName }));
                          }
                          if (!refNameManuallyEdited) {
                            setFormData(prev => ({ ...prev, refName: generatedName }));
                          }
                        }}
                        catalog={mcpForm.functionsCatalog || null}
                        required
                      />
                    </div>
                  </ResourceSelector>
                )}

                {mcpForm.sourceType === 'sql' && (
                  <div className="p-3 bg-slate-900/50 rounded-lg">
                    <p className="text-sm text-slate-300">
                      <strong>Databricks SQL MCP</strong> - Enables serverless SQL execution without requiring a warehouse.
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      The sql: true flag will be set automatically.
                    </p>
                  </div>
                )}

                {mcpForm.sourceType === 'app' && (
                  <ResourceSelector
                    label="Databricks App"
                    resourceType="Databricks App"
                    configuredOptions={configuredAppOptions}
                    configuredValue={mcpForm.appRefName}
                    onConfiguredChange={(value) => {
                      const apps = config.resources?.apps || {};
                      const app = apps[value];
                      const appName = app?.name || value;
                      const generatedName = generateMcpToolName('app', appName);
                      
                      setMcpForm({ 
                        ...mcpForm, 
                        appRefName: value, 
                        appName: ''
                      });
                      
                      // Auto-generate tool name and ref name if not manually edited
                      if (!nameManuallyEdited) {
                        setFormData(prev => ({ ...prev, name: generatedName }));
                      }
                      if (!refNameManuallyEdited) {
                        setFormData(prev => ({ ...prev, refName: generatedName }));
                      }
                    }}
                    source={mcpForm.appSource}
                    onSourceChange={(source) => setMcpForm({ ...mcpForm, appSource: source })}
                    hint="The app's URL will be retrieved dynamically from the workspace at runtime."
                  >
                    <DatabricksAppSelect
                      value={mcpForm.appName}
                      onChange={(value) => {
                        const generatedName = generateMcpToolName('app', value);
                        
                        setMcpForm({ ...mcpForm, appName: value, appRefName: '' });
                        
                        // Auto-generate tool name and ref name if not manually edited
                        if (!nameManuallyEdited) {
                          setFormData(prev => ({ ...prev, name: generatedName }));
                        }
                        if (!refNameManuallyEdited) {
                          setFormData(prev => ({ ...prev, refName: generatedName }));
                        }
                      }}
                      required
                    />
                  </ResourceSelector>
                )}

                {mcpForm.sourceType === 'connection' && (
                  <ResourceSelector
                    label="UC Connection"
                    resourceType="connection"
                    configuredOptions={configuredConnectionOptions}
                    configuredValue={mcpForm.connectionRefName}
                    onConfiguredChange={(value) => {
                      const conn = configuredConnections[value];
                      const connName = conn?.name || value;
                      const generatedName = generateMcpToolName('connection', connName);
                      
                      setMcpForm({ 
                        ...mcpForm, 
                        connectionRefName: value,
                        connectionName: conn?.name || ''
                      });
                      
                      // Auto-generate tool name and ref name if not manually edited
                      if (!nameManuallyEdited) {
                        setFormData(prev => ({ ...prev, name: generatedName }));
                      }
                      if (!refNameManuallyEdited) {
                        setFormData(prev => ({ ...prev, refName: generatedName }));
                      }
                    }}
                    source={mcpForm.connectionSource}
                    onSourceChange={(source) => setMcpForm({ ...mcpForm, connectionSource: source })}
                  >
                    <UCConnectionSelect
                      label="Select Connection"
                      value={mcpForm.connectionName}
                      onChange={(value) => {
                        const generatedName = generateMcpToolName('connection', value);
                        
                        setMcpForm({ ...mcpForm, connectionName: value, connectionRefName: '' });
                        
                        // Auto-generate tool name and ref name if not manually edited
                        if (!nameManuallyEdited) {
                          setFormData(prev => ({ ...prev, name: generatedName }));
                        }
                        if (!refNameManuallyEdited) {
                          setFormData(prev => ({ ...prev, refName: generatedName }));
                        }
                      }}
                      required
                    />
                  </ResourceSelector>
                )}
              </div>

              {/* Credentials Configuration */}
              <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium text-slate-300">Authentication</h4>
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mcpForm.useCredentials}
                      onChange={(e) => setMcpForm({ ...mcpForm, useCredentials: e.target.checked })}
                      className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                    />
                    <span className="text-sm text-slate-400">Use credentials</span>
                  </label>
                </div>

                {mcpForm.useCredentials && (
                  <div className="space-y-4">
                    {/* Credentials Mode Toggle */}
                    <div className="flex items-center space-x-2">
                      <button
                        type="button"
                        onClick={() => setMcpForm({ ...mcpForm, credentialsMode: 'service_principal' })}
                        className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                          mcpForm.credentialsMode === 'service_principal'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600'
                        }`}
                      >
                        Configured Service Principal
                      </button>
                      <button
                        type="button"
                        onClick={() => setMcpForm({ ...mcpForm, credentialsMode: 'manual' })}
                        className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                          mcpForm.credentialsMode === 'manual'
                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                            : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600'
                        }`}
                      >
                        Manual Credentials
                      </button>
                    </div>
                    
                    {mcpForm.credentialsMode === 'service_principal' ? (
                      <div className="space-y-2">
                        <Select
                          label="Service Principal"
                          options={[
                            { value: '', label: 'Select a service principal...' },
                            ...Object.keys(config.service_principals || {}).map((sp) => ({
                              value: sp,
                              label: sp,
                            })),
                          ]}
                          value={mcpForm.servicePrincipalRef}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => setMcpForm({ ...mcpForm, servicePrincipalRef: e.target.value })}
                          hint="Reference a pre-configured service principal"
                        />
                        {Object.keys(config.service_principals || {}).length === 0 && (
                          <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-xs">
                            No service principals configured. Add one in Resources → Service Principals first.
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* Client ID */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-slate-300">Client ID</label>
                            <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                              <button
                                type="button"
                                onClick={() => setMcpForm({ ...mcpForm, clientIdSource: 'variable' })}
                                className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                                  mcpForm.clientIdSource === 'variable'
                                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                                }`}
                              >
                                Variable
                              </button>
                              <button
                                type="button"
                                onClick={() => setMcpForm({ ...mcpForm, clientIdSource: 'manual' })}
                                className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                                  mcpForm.clientIdSource === 'manual'
                                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                                }`}
                              >
                                Manual
                              </button>
                            </div>
                          </div>
                          {mcpForm.clientIdSource === 'variable' ? (
                            <Select
                              options={[
                                { value: '', label: 'Select a variable...' },
                                ...variableNames.map((name) => ({
                                  value: name,
                                  label: `${name} (${getVariableDisplayName(variables[name])})`,
                                })),
                              ]}
                              value={mcpForm.clientIdVar}
                              onChange={(e: ChangeEvent<HTMLSelectElement>) => setMcpForm({ ...mcpForm, clientIdVar: e.target.value })}
                              hint={variableNames.length === 0 ? 'Define variables in the Variables section first' : undefined}
                            />
                          ) : (
                            <Input
                              placeholder="Enter client ID..."
                              value={mcpForm.clientIdManual}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, clientIdManual: e.target.value })}
                            />
                          )}
                        </div>

                    {/* Client Secret */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-slate-300">Client Secret</label>
                        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                          <button
                            type="button"
                            onClick={() => setMcpForm({ ...mcpForm, clientSecretSource: 'variable' })}
                            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                              mcpForm.clientSecretSource === 'variable'
                                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                : 'text-slate-400 border border-transparent hover:text-slate-300'
                            }`}
                          >
                            Variable
                          </button>
                          <button
                            type="button"
                            onClick={() => setMcpForm({ ...mcpForm, clientSecretSource: 'manual' })}
                            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                              mcpForm.clientSecretSource === 'manual'
                                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                : 'text-slate-400 border border-transparent hover:text-slate-300'
                            }`}
                          >
                            Manual
                          </button>
                        </div>
                      </div>
                      {mcpForm.clientSecretSource === 'variable' ? (
                        <Select
                          options={[
                            { value: '', label: 'Select a variable...' },
                            ...variableNames.map((name) => ({
                              value: name,
                              label: `${name} (${getVariableDisplayName(variables[name])})`,
                            })),
                          ]}
                          value={mcpForm.clientSecretVar}
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => setMcpForm({ ...mcpForm, clientSecretVar: e.target.value })}
                          hint={variableNames.length === 0 ? 'Define variables in the Variables section first' : undefined}
                        />
                      ) : (
                        <Input
                          type="password"
                          placeholder="Enter client secret..."
                          value={mcpForm.clientSecretManual}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, clientSecretManual: e.target.value })}
                        />
                      )}
                    </div>

                        {/* Workspace Host (Optional) */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <label className="text-sm font-medium text-slate-300">
                              Workspace Host <span className="text-slate-500">(Optional)</span>
                            </label>
                            <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                              <button
                                type="button"
                                onClick={() => setMcpForm({ ...mcpForm, workspaceHostSource: 'variable' })}
                                className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                                  mcpForm.workspaceHostSource === 'variable'
                                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                                }`}
                              >
                                Variable
                              </button>
                              <button
                                type="button"
                                onClick={() => setMcpForm({ ...mcpForm, workspaceHostSource: 'manual' })}
                                className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                                  mcpForm.workspaceHostSource === 'manual'
                                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                                }`}
                              >
                                Manual
                              </button>
                            </div>
                          </div>
                          {mcpForm.workspaceHostSource === 'variable' ? (
                            <Select
                              options={[
                                { value: '', label: 'Select a variable...' },
                                ...variableNames.map((name) => ({
                                  value: name,
                                  label: `${name} (${getVariableDisplayName(variables[name])})`,
                                })),
                              ]}
                              value={mcpForm.workspaceHostVar}
                              onChange={(e: ChangeEvent<HTMLSelectElement>) => setMcpForm({ ...mcpForm, workspaceHostVar: e.target.value })}
                              hint={variableNames.length === 0 ? 'Define variables in the Variables section first' : undefined}
                            />
                          ) : (
                            <Input
                              placeholder="https://your-workspace.cloud.databricks.com"
                              value={mcpForm.workspaceHostManual}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => setMcpForm({ ...mcpForm, workspaceHostManual: e.target.value })}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Tool Filtering Section */}
              <div className="p-4 bg-slate-800/30 rounded-lg border border-slate-700/50 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <h4 className="text-sm font-medium text-slate-200">Tool Filtering</h4>
                      <button
                        type="button"
                        onClick={async () => {
                          // Clear any previous error and start loading
                          setMcpForm(prev => ({ ...prev, availableToolsLoading: true, availableToolsError: '', availableTools: [] }));
                          
                          try {
                            // Build the MCP config from form state
                            // NOTE: 'name' is not part of McpFunctionModel, only at ToolModel level
                            const mcpConfig: Record<string, unknown> = {};
                            
                            // Add source-specific configuration
                            switch (mcpForm.sourceType) {
                              case 'url':
                                if (mcpForm.urlSource === 'variable' && mcpForm.urlVariable) {
                                  // Can't discover tools without actual URL
                                  throw new Error('Cannot discover tools when using a variable for URL. Enter a direct URL to discover tools.');
                                }
                                if (!mcpForm.url) {
                                  throw new Error('Please enter a URL to discover tools.');
                                }
                                mcpConfig.url = mcpForm.url;
                                break;
                              case 'connection':
                                if (mcpForm.connectionSource === 'configured' && mcpForm.connectionRefName) {
                                  const conn = configuredConnections[mcpForm.connectionRefName];
                                  if (conn) {
                                    mcpConfig.connection = { name: conn.name };
                                  }
                                } else if (mcpForm.connectionName) {
                                  mcpConfig.connection = { name: mcpForm.connectionName };
                                } else {
                                  throw new Error('Please select a connection to discover tools.');
                                }
                                break;
                              case 'genie':
                                if (mcpForm.genieSource === 'configured' && mcpForm.genieRefName) {
                                  const genieConfig = config.resources?.genie_rooms?.[mcpForm.genieRefName];
                                  if (genieConfig) {
                                    // Extract space_id value - handle variable references
                                    const spaceId = typeof genieConfig.space_id === 'string' && genieConfig.space_id.startsWith('*')
                                      ? config.variables?.[genieConfig.space_id.slice(1)]?.value
                                      : genieConfig.space_id;
                                    mcpConfig.genie_room = {
                                      name: genieConfig.name || 'Genie Room',
                                      space_id: spaceId || genieConfig.space_id,
                                    };
                                  } else {
                                    throw new Error('Selected Genie Room not found. Please select a configured Genie room.');
                                  }
                                } else if (mcpForm.genieSource === 'select' && mcpForm.genieSpaceId) {
                                  mcpConfig.genie_room = {
                                    name: mcpForm.genieName || 'Genie Room',
                                    space_id: mcpForm.genieSpaceId,
                                  };
                                } else {
                                  throw new Error('Please select a Genie space to discover tools.');
                                }
                                break;
                              case 'functions':
                                if (mcpForm.functionsCatalog && mcpForm.functionsSchema) {
                                  mcpConfig.functions = {
                                    catalog_name: mcpForm.functionsCatalog,
                                    schema_name: mcpForm.functionsSchema,
                                  };
                                } else {
                                  throw new Error('Please select a catalog and schema to discover functions.');
                                }
                                break;
                              case 'sql':
                                mcpConfig.sql = true;
                                break;
                              case 'app':
                                // App source - need the actual app to discover tools
                                if (mcpForm.appSource === 'configured' && mcpForm.appRefName) {
                                  const appConfig = config.resources?.apps?.[mcpForm.appRefName];
                                  if (appConfig) {
                                    mcpConfig.app = { name: appConfig.name };
                                  } else {
                                    throw new Error('Selected Databricks App not found. Please select a configured app.');
                                  }
                                } else if (mcpForm.appSource === 'select' && mcpForm.appName) {
                                  mcpConfig.app = { name: mcpForm.appName };
                                } else {
                                  throw new Error('Please select a Databricks App to discover tools.');
                                }
                                break;
                              case 'vector_search':
                                // Vector search source - need catalog/schema and index name for MCP URL
                                // The MCP URL format is: /api/2.0/mcp/vector-search/{catalog}/{schema}
                                if (mcpForm.vectorStoreSource === 'configured' && mcpForm.vectorStoreRefName) {
                                  const vsConfig = config.resources?.vector_stores?.[mcpForm.vectorStoreRefName] as any;
                                  if (vsConfig) {
                                    // Extract just what's needed for MCP URL to avoid triggering
                                    // validators that require authentication (like primary_key discovery)
                                    const indexSchema = vsConfig.index?.schema;
                                    if (!indexSchema?.catalog_name || !indexSchema?.schema_name) {
                                      throw new Error('Vector store must have an index with schema (catalog/schema) configured.');
                                    }
                                    mcpConfig.vector_search = {
                                      index: {
                                        schema: {
                                          catalog_name: indexSchema.catalog_name,
                                          schema_name: indexSchema.schema_name,
                                        },
                                        name: vsConfig.index.name,
                                      },
                                    };
                                  } else {
                                    throw new Error('Selected Vector Store not found. Please select a configured vector store.');
                                  }
                                } else if (mcpForm.vectorStoreSource === 'select') {
                                  if (!mcpForm.vectorIndex) {
                                    throw new Error('Please select a vector index to discover tools.');
                                  }
                                  if (!mcpForm.vectorCatalog || !mcpForm.vectorSchema) {
                                    throw new Error('Please select a catalog and schema for the vector index.');
                                  }
                                  // Build minimal vector_search config for tool discovery
                                  mcpConfig.vector_search = {
                                    index: {
                                      schema: {
                                        catalog_name: mcpForm.vectorCatalog,
                                        schema_name: mcpForm.vectorSchema,
                                      },
                                      name: mcpForm.vectorIndex,
                                    },
                                  };
                                } else {
                                  throw new Error('Please select a vector store to discover tools.');
                                }
                                break;
                            }
                            
                            // Add authentication configuration if credentials are enabled
                            if (mcpForm.useCredentials) {
                              if (mcpForm.credentialsMode === 'service_principal' && mcpForm.servicePrincipalRef) {
                                // Get the service principal config and inline it
                                const spConfig = config.service_principals?.[mcpForm.servicePrincipalRef];
                                if (spConfig) {
                                  // Resolve variable references in service principal
                                  const resolveValue = (val: unknown): string | undefined => {
                                    if (typeof val === 'string') {
                                      if (val.startsWith('*')) {
                                        const varName = val.slice(1);
                                        const varConfig = config.variables?.[varName];
                                        if (varConfig && typeof varConfig === 'object' && 'value' in varConfig) {
                                          return String(varConfig.value);
                                        }
                                        if (typeof varConfig === 'string') return varConfig;
                                      }
                                      return val;
                                    }
                                    return undefined;
                                  };
                                  
                                  mcpConfig.client_id = resolveValue(spConfig.client_id);
                                  mcpConfig.client_secret = resolveValue(spConfig.client_secret);
                                  // Include workspace host for OAuth token endpoint (ensure https:// prefix)
                                  if (databricksHost) {
                                    let host = databricksHost.replace(/\/$/, '');
                                    if (!host.startsWith('http://') && !host.startsWith('https://')) {
                                      host = `https://${host}`;
                                    }
                                    mcpConfig.workspace_host = host;
                                  }
                                } else {
                                  console.warn('Service principal not found:', mcpForm.servicePrincipalRef);
                                }
                              } else if (mcpForm.credentialsMode === 'service_principal' && !mcpForm.servicePrincipalRef) {
                                // Service principal mode but none selected - use ambient auth
                                // Just add workspace host so backend knows which workspace to use
                                console.log('No service principal selected, using ambient auth');
                                if (databricksHost) {
                                  let host = databricksHost.replace(/\/$/, '');
                                  if (!host.startsWith('http://') && !host.startsWith('https://')) {
                                    host = `https://${host}`;
                                  }
                                  mcpConfig.workspace_host = host;
                                }
                              } else if (mcpForm.credentialsMode === 'manual') {
                                // Manual credentials
                                if (mcpForm.clientIdSource === 'variable' && mcpForm.clientIdVar) {
                                  const varConfig = config.variables?.[mcpForm.clientIdVar];
                                  if (varConfig && typeof varConfig === 'object' && 'value' in varConfig) {
                                    mcpConfig.client_id = String(varConfig.value);
                                  }
                                } else if (mcpForm.clientIdManual) {
                                  mcpConfig.client_id = mcpForm.clientIdManual;
                                }
                                
                                if (mcpForm.clientSecretSource === 'variable' && mcpForm.clientSecretVar) {
                                  const varConfig = config.variables?.[mcpForm.clientSecretVar];
                                  if (varConfig && typeof varConfig === 'object' && 'value' in varConfig) {
                                    mcpConfig.client_secret = String(varConfig.value);
                                  }
                                } else if (mcpForm.clientSecretManual) {
                                  mcpConfig.client_secret = mcpForm.clientSecretManual;
                                }
                                
                                if (mcpForm.workspaceHostSource === 'variable' && mcpForm.workspaceHostVar) {
                                  const varConfig = config.variables?.[mcpForm.workspaceHostVar];
                                  if (varConfig && typeof varConfig === 'object' && 'value' in varConfig) {
                                    mcpConfig.workspace_host = String(varConfig.value);
                                  }
                                } else if (mcpForm.workspaceHostManual) {
                                  mcpConfig.workspace_host = mcpForm.workspaceHostManual;
                                }
                              }
                            }
                            
                            // Call the backend API with Databricks host header
                            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                            if (databricksHost) {
                              headers['X-Databricks-Host'] = databricksHost.replace(/\/$/, '');
                            }
                            
                            const response = await fetch('/api/mcp/list-tools', {
                              method: 'POST',
                              headers,
                              body: JSON.stringify(mcpConfig),
                            });
                            
                            const data = await response.json();
                            
                            if (!response.ok) {
                              throw new Error(data.error || 'Failed to discover tools');
                            }
                            
                            if (data.tools && data.tools.length > 0) {
                              setMcpForm(prev => ({
                                ...prev,
                                availableToolsLoading: false,
                                availableTools: data.tools.map((t: { name: string }) => t.name),
                                availableToolsError: '',
                              }));
                            } else {
                              setMcpForm(prev => ({
                                ...prev,
                                availableToolsLoading: false,
                                availableTools: [],
                                availableToolsError: 'No tools found on the MCP server.',
                              }));
                            }
                          } catch (error) {
                            setMcpForm(prev => ({
                              ...prev,
                              availableToolsLoading: false,
                              availableToolsError: error instanceof Error ? error.message : 'Failed to discover tools',
                            }));
                          }
                        }}
                        className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                        disabled={mcpForm.availableToolsLoading}
                      >
                        <RefreshCw className={`w-3 h-3 ${mcpForm.availableToolsLoading ? 'animate-spin' : ''}`} />
                        <span>Refresh</span>
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Control which tools are loaded from the MCP server. Supports glob patterns: * (any chars), ? (single char), [abc] (char set)
                    </p>
                  </div>
                </div>
                
                {/* Error/Info message */}
                {mcpForm.availableToolsError && (
                  <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded text-xs text-amber-400">
                    {mcpForm.availableToolsError}
                  </div>
                )}

                {/* Include Tools */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300">Include Tools</label>
                  <p className="text-xs text-slate-500">Only load tools matching these patterns. Leave empty to include all tools.</p>
                  <div className="space-y-2">
                    {mcpForm.includeTools.map((tool, index) => (
                      <div key={index} className="flex items-center space-x-2">
                        <Input
                          value={tool}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            const newTools = [...mcpForm.includeTools];
                            newTools[index] = e.target.value;
                            setMcpForm({ ...mcpForm, includeTools: newTools });
                          }}
                          placeholder="e.g., query_*, list_tables, get_?_data"
                          className="flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            const newTools = mcpForm.includeTools.filter((_, i) => i !== index);
                            setMcpForm({ ...mcpForm, includeTools: newTools });
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center space-x-2">
                      {mcpForm.availableTools.length > 0 ? (
                        <Select
                          options={[
                            { value: '', label: 'Select Tool...' },
                            ...mcpForm.availableTools.map(t => ({ value: t, label: t })),
                          ]}
                          value=""
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                            if (e.target.value) {
                              setMcpForm({ ...mcpForm, includeTools: [...mcpForm.includeTools, e.target.value] });
                            }
                          }}
                          className="flex-1"
                        />
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => setMcpForm({ ...mcpForm, includeTools: [...mcpForm.includeTools, ''] })}
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Pattern
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Exclude Tools */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-300">Exclude Tools</label>
                  <p className="text-xs text-slate-500">Exclude tools matching these patterns. Takes precedence over include patterns.</p>
                  <div className="space-y-2">
                    {mcpForm.excludeTools.map((tool, index) => (
                      <div key={index} className="flex items-center space-x-2">
                        <Input
                          value={tool}
                          onChange={(e: ChangeEvent<HTMLInputElement>) => {
                            const newTools = [...mcpForm.excludeTools];
                            newTools[index] = e.target.value;
                            setMcpForm({ ...mcpForm, excludeTools: newTools });
                          }}
                          placeholder="e.g., drop_*, delete_*, execute_ddl"
                          className="flex-1"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => {
                            const newTools = mcpForm.excludeTools.filter((_, i) => i !== index);
                            setMcpForm({ ...mcpForm, excludeTools: newTools });
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center space-x-2">
                      {mcpForm.availableTools.length > 0 ? (
                        <Select
                          options={[
                            { value: '', label: 'Select Tool...' },
                            ...mcpForm.availableTools.map(t => ({ value: t, label: t })),
                          ]}
                          value=""
                          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                            if (e.target.value) {
                              setMcpForm({ ...mcpForm, excludeTools: [...mcpForm.excludeTools, e.target.value] });
                            }
                          }}
                          className="flex-1"
                        />
                      ) : null}
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => setMcpForm({ ...mcpForm, excludeTools: [...mcpForm.excludeTools, ''] })}
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Pattern
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Summary */}
                {(mcpForm.includeTools.length > 0 || mcpForm.excludeTools.length > 0) && (
                  <div className="p-3 bg-purple-900/20 border border-purple-500/30 rounded-lg">
                    <p className="text-xs text-purple-300">
                      <strong>Filter Summary:</strong>{' '}
                      {mcpForm.includeTools.length > 0 && (
                        <span>Including: {mcpForm.includeTools.filter(t => t).join(', ') || 'none'}</span>
                      )}
                      {mcpForm.includeTools.length > 0 && mcpForm.excludeTools.length > 0 && ' | '}
                      {mcpForm.excludeTools.length > 0 && (
                        <span>Excluding: {mcpForm.excludeTools.filter(t => t).join(', ') || 'none'}</span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="secondary" type="button" onClick={() => {
              setIsModalOpen(false);
              resetForm();
            }}>
              Cancel
            </Button>
            <Button 
              type="submit"
              disabled={
                !formData.name ||
                (formData.type === 'mcp' && mcpForm.sourceType === 'connection' && 
                  !((mcpForm.connectionSource === 'configured' && mcpForm.connectionRefName) ||
                    (mcpForm.connectionSource === 'select' && mcpForm.connectionName)))
              }
            >
              {editingKey ? 'Save Changes' : 'Add Tool'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
