/**
 * Resources Section - Configure Databricks resources that can be referenced throughout the configuration.
 * 
 * Supports:
 * - LLMs (Language Models)
 * - Genie Rooms (with space_id selector)
 * - Tables (with catalog/schema/table selector)
 * - Volumes (with catalog/schema/volume selector)  
 * - Functions (with catalog/schema/function selector)
 * - Warehouses (with warehouse_id selector)
 * - Connections (UC connections)
 */
import { useState, useEffect, ChangeEvent } from 'react';
import { normalizeRefNameWhileTyping } from '@/utils/name-utils';
import { safeDelete } from '@/utils/safe-delete';
import { useYamlScrollStore } from '@/stores/yamlScrollStore';

// Helper to scroll YAML preview to a specific asset
const scrollToAsset = (refName: string) => {
  useYamlScrollStore.getState().scrollToAsset(refName);
};

/**
 * Safely check if a value is a string that starts with a prefix.
 * Handles the case where YAML anchors are resolved to objects instead of strings.
 */
function safeStartsWith(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix);
}

/**
 * Safely convert a value to string, returning empty string for objects/undefined.
 */
function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
import { 
  MessageSquare, 
  Table2, 
  FolderOpen, 
  Code2, 
  Database, 
  Link,
  Plus, 
  Trash2, 
  Edit2,
  Pencil,
  Info,
  UserCheck,
  Cpu,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Layers,
  User,
  Server,
  CloudCog,
  Key,
  Loader2,
  AppWindow,
} from 'lucide-react';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import Badge from '@/components/ui/Badge';
import Modal from '@/components/ui/Modal';
import { StatusSelect, StatusSelectOption, StatusType } from '@/components/ui/StatusSelect';
import { 
  ResourceAuthSection, 
  parseResourceAuth, 
  applyResourceAuth
} from '@/components/ui/ResourceAuthSection';
import { useConfigStore } from '@/stores/configStore';
import { 
  AppConfig,
  GenieRoomModel, 
  TableModel, 
  VolumeModel, 
  FunctionModel, 
  WarehouseModel, 
  ConnectionModel,
  DatabricksAppModel,
  LLMModel,
  DatabaseModel,
  VariableModel,
  VectorStoreModel,
  SchemaModel,
} from '@/types/dao-ai-types';
import { 
  useGenieSpaces, 
  useSQLWarehouses,
  useCatalogs,
  useSchemas,
  useTables,
  useTableColumns,
  useFunctions,
  useVolumes,
  useServingEndpoints,
  useUCConnections,
  useDatabases,
  useVectorSearchEndpoints,
  useVectorSearchIndexes,
} from '@/hooks/useDatabricks';
import { DatabricksAppSelect } from '@/components/ui/DatabricksSelect';

type ResourceType = 'llms' | 'genie_rooms' | 'tables' | 'volumes' | 'functions' | 'warehouses' | 'connections' | 'databases' | 'vector_stores' | 'apps';

interface ResourceTab {
  id: ResourceType;
  label: string;
  icon: typeof MessageSquare;
  description: string;
}

const RESOURCE_TABS: ResourceTab[] = [
  { id: 'llms', label: 'LLMs', icon: Cpu, description: 'Language models' },
  { id: 'genie_rooms', label: 'Genie Rooms', icon: MessageSquare, description: 'AI-powered data assistants' },
  { id: 'warehouses', label: 'SQL Warehouses', icon: Database, description: 'SQL compute resources' },
  { id: 'tables', label: 'Tables', icon: Table2, description: 'Unity Catalog tables' },
  { id: 'volumes', label: 'Volumes', icon: FolderOpen, description: 'Unity Catalog volumes' },
  { id: 'functions', label: 'Functions', icon: Code2, description: 'Unity Catalog functions' },
  { id: 'connections', label: 'Connections', icon: Link, description: 'External connections' },
  { id: 'databases', label: 'Databases', icon: Server, description: 'Lakebase/PostgreSQL backends' },
  { id: 'vector_stores', label: 'Vector Stores', icon: Layers, description: 'Vector search indexes' },
  { id: 'apps', label: 'Apps', icon: AppWindow, description: 'Databricks Apps' },
];

const COMMON_MODELS = [
  { value: 'databricks-claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
  { value: 'databricks-claude-sonnet-4', label: 'Claude Sonnet 4' },
  { value: 'databricks-meta-llama-3-3-70b-instruct', label: 'Llama 3.3 70B Instruct' },
  { value: 'databricks-meta-llama-3-1-405b-instruct', label: 'Llama 3.1 405B Instruct' },
  { value: 'databricks-meta-llama-3-1-8b-instruct', label: 'Llama 3.1 8B Instruct' },
  { value: 'databricks-dbrx-instruct', label: 'DBRX Instruct' },
  { value: 'databricks-gte-large-en', label: 'GTE Large (Embeddings)' },
];

/**
 * Generate a normalized reference name from an asset name.
 * - Converts to lowercase
 * - Replaces consecutive whitespace/special chars with single underscore
 * - Removes leading/trailing underscores
 */
function generateRefName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric chars with underscore
    .replace(/_+/g, '_')          // Collapse multiple underscores
    .replace(/^_|_$/g, '');       // Remove leading/trailing underscores
}

/**
 * Check if a reference name already exists in the config.
 * Returns true if the refName is a duplicate (exists and is not the editingKey).
 * 
 * @param refName - The reference name to check
 * @param config - The full config object
 * @param editingKey - The key being edited (allowed to match itself)
 * @returns true if duplicate, false otherwise
 */
function isRefNameDuplicate(refName: string, config: AppConfig, editingKey: string | null): boolean {
  if (!refName) return false;
  
  // Check resources
  const resources = config.resources || {};
  const resourceTypes = ['llms', 'genie_rooms', 'tables', 'volumes', 'functions', 'warehouses', 'connections', 'databases', 'vector_stores', 'apps'] as const;
  for (const type of resourceTypes) {
    const items = resources[type] || {};
    if (refName in items && refName !== editingKey) {
      return true;
    }
  }
  
  // Check top-level service_principals
  const servicePrincipals = config.service_principals || {};
  if (refName in servicePrincipals && refName !== editingKey) {
    return true;
  }
  
  // Check agents
  const agents = config.agents || {};
  if (refName in agents && refName !== editingKey) {
    return true;
  }
  
  // Check tools
  const tools = config.tools || {};
  if (refName in tools && refName !== editingKey) {
    return true;
  }
  
  // Check guardrails
  const guardrails = config.guardrails || {};
  if (refName in guardrails && refName !== editingKey) {
    return true;
  }
  
  // Check retrievers
  const retrievers = config.retrievers || {};
  if (refName in retrievers && refName !== editingKey) {
    return true;
  }
  
  // Check schemas
  const schemas = config.schemas || {};
  if (refName in schemas && refName !== editingKey) {
    return true;
  }
  
  // Check prompts
  const prompts = config.prompts || {};
  if (refName in prompts && refName !== editingKey) {
    return true;
  }
  
  // Check variables
  const variables = config.variables || {};
  if (refName in variables && refName !== editingKey) {
    return true;
  }
  
  return false;
}

export function ResourcesSection() {
  const { config } = useConfigStore();
  const resources = config.resources;
  
  const [activeTab, setActiveTab] = useState<ResourceType>('llms');
  const [showForm, setShowForm] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const handleCloseForm = () => {
    setShowForm(false);
    setEditingKey(null);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'llms':
        return <LLMsPanel />;
      case 'genie_rooms':
        return <GenieRoomsPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'warehouses':
        return <WarehousesPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'tables':
        return <TablesPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'volumes':
        return <VolumesPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'functions':
        return <FunctionsPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'connections':
        return <ConnectionsPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'databases':
        return <DatabasesPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'vector_stores':
        return <VectorStoresPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      case 'apps':
        return <DatabricksAppsPanel showForm={showForm} setShowForm={setShowForm} editingKey={editingKey} setEditingKey={setEditingKey} onClose={handleCloseForm} />;
      default:
        return null;
    }
  };

  const getResourceCount = (type: ResourceType): number => {
    switch (type) {
      case 'llms': return Object.keys(resources?.llms || {}).length;
      case 'genie_rooms': return Object.keys(resources?.genie_rooms || {}).length;
      case 'tables': return Object.keys(resources?.tables || {}).length;
      case 'volumes': return Object.keys(resources?.volumes || {}).length;
      case 'functions': return Object.keys(resources?.functions || {}).length;
      case 'warehouses': return Object.keys(resources?.warehouses || {}).length;
      case 'connections': return Object.keys(resources?.connections || {}).length;
      case 'databases': return Object.keys(resources?.databases || {}).length;
      case 'vector_stores': return Object.keys(resources?.vector_stores || {}).length;
      case 'apps': return Object.keys(resources?.apps || {}).length;
      default: return 0;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-slate-100">Resources</h2>
        <p className="text-slate-400 mt-1">
          Configure Databricks resources that can be referenced in tools, agents, and other parts of your configuration.
        </p>
      </div>

      {/* Info Card */}
      <Card className="p-4 bg-blue-900/20 border-blue-500/30">
        <div className="flex items-start space-x-3">
          <Info className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-300">
            <p className="font-medium">Resource References</p>
            <p className="mt-1 text-blue-400/80">
              Resources defined here can be referenced by their <strong>reference name</strong> (the key) 
              in tools and other configuration sections. For example, a Genie room named "retail_genie" 
              can be used in tools to create Genie-powered assistants.
            </p>
          </div>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-700 pb-4">
        {RESOURCE_TABS.map((tab) => {
          const Icon = tab.icon;
          const count = getResourceCount(tab.id);
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setShowForm(false);
                setEditingKey(null);
              }}
              className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
                activeTab === tab.id
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                  : 'bg-slate-800/50 text-slate-400 hover:bg-slate-800 hover:text-slate-300'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {count > 0 && (
                <Badge variant="default" className="ml-1">{count}</Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div>
        {renderTabContent()}
      </div>
    </div>
  );
}

// =============================================================================
// Panel Props Interface
// =============================================================================
interface PanelProps {
  showForm: boolean;
  setShowForm: (show: boolean) => void;
  editingKey: string | null;
  setEditingKey: (key: string | null) => void;
  onClose: () => void;
}

// =============================================================================
// Fallback Item Component
// =============================================================================
type FallbackSource = 'reference' | 'endpoint';

interface FallbackItemProps {
  index: number;
  fallback: string;
  isReference: boolean;
  refKey: string | null;
  hasConfiguredLLMs: boolean;
  llms: Record<string, LLMModel>;
  endpoints: { name: string; state?: { ready?: string; config_update?: string } }[];
  editingKey: string | null;
  formDataName: string;
  onUpdate: (value: string) => void;
  onRemove: () => void;
  getEndpointStatus: (state: { ready?: string; config_update?: string } | undefined) => StatusType;
}

function FallbackItem({
  index,
  fallback,
  isReference,
  refKey,
  hasConfiguredLLMs,
  llms,
  endpoints,
  editingKey,
  formDataName,
  onUpdate,
  onRemove,
  getEndpointStatus,
}: FallbackItemProps) {
  const [source, setSource] = useState<FallbackSource>(isReference ? 'reference' : 'endpoint');
  
  // Available configured LLMs (excluding the one being edited)
  const availableLLMs = Object.entries(llms)
    .filter(([key]) => key !== editingKey && key !== formDataName)
    .map(([key, llm]) => ({
      value: `ref:${key}`,
      label: `*${key} → ${llm.name}`,
    }));
  
  // Available endpoints with status
  const availableEndpoints: StatusSelectOption[] = endpoints.map((e) => ({
    value: e.name,
    label: e.name,
    status: getEndpointStatus(e.state),
  }));

  const handleSourceChange = (newSource: FallbackSource) => {
    setSource(newSource);
    onUpdate(''); // Clear selection when switching source
  };

  return (
    <div className="p-3 bg-slate-900/50 rounded-lg border border-slate-700 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 font-medium">Fallback #{index + 1}</span>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={onRemove}
        >
          <Trash2 className="w-3 h-3 text-red-400" />
        </Button>
      </div>

      {/* Source Toggle */}
      {hasConfiguredLLMs && (
        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 w-full">
          <button
            type="button"
            onClick={() => handleSourceChange('reference')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'reference'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Configured
          </button>
          <button
            type="button"
            onClick={() => handleSourceChange('endpoint')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
              source === 'endpoint'
                ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                : 'text-slate-400 border border-transparent hover:text-slate-300'
            }`}
          >
            Endpoint
          </button>
        </div>
      )}

      {/* Selection based on source */}
      {source === 'reference' && hasConfiguredLLMs ? (
        <div className="space-y-2">
          <Select
            value={fallback}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => onUpdate(e.target.value)}
            options={[
              { value: '', label: 'Select a configured LLM...' },
              ...availableLLMs,
            ]}
          />
          {isReference && refKey && llms[refKey] && (
            <div className="p-2 bg-slate-800/50 rounded text-xs">
              <span className="text-blue-400">YAML output:</span>{' '}
              <code className="text-slate-300">*{refKey}</code>
              <span className="text-slate-500 ml-2">→ {llms[refKey].name}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <StatusSelect
            value={safeStartsWith(fallback, 'ref:') ? '' : safeString(fallback)}
            onChange={onUpdate}
            options={[
              { value: '', label: 'Select an endpoint...' },
              ...availableEndpoints,
            ]}
            placeholder="Select an endpoint..."
          />
          {fallback && !safeStartsWith(fallback, 'ref:') && (
            <div className="p-2 bg-slate-800/50 rounded text-xs">
              <span className="text-green-400">YAML output:</span>{' '}
              <code className="text-slate-300">{fallback}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// LLMs Panel
// =============================================================================
type ModelSource = 'preset' | 'endpoint' | 'custom';

function LLMsPanel() {
  const { config, addLLM, removeLLM, updateLLM } = useConfigStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [modelSource, setModelSource] = useState<ModelSource>('preset');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    modelName: '',
    customModelName: '',
    temperature: '0.1',
    maxTokens: '8192',
    onBehalfOfUser: false,
    useResponseApi: false,
    fallbacks: [] as string[],
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const { data: endpoints, loading: endpointsLoading, refetch: refetchEndpoints } = useServingEndpoints();

  const llms = config.resources?.llms || {};

  const resetForm = () => {
    setFormData({
      name: '',
      modelName: '',
      customModelName: '',
      temperature: '0.1',
      maxTokens: '8192',
      onBehalfOfUser: false,
      useResponseApi: false,
      fallbacks: [],
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    setModelSource('preset');
    setShowAdvanced(false);
    setEditingKey(null);
  };

  const handleEdit = (key: string, llm: LLMModel) => {
    scrollToAsset(key);
    setEditingKey(key);
    // Convert fallbacks: if it matches a configured LLM key, prefix with ref:
    const convertedFallbacks = (llm.fallbacks || []).map(f => {
      const fallbackName = typeof f === 'string' ? f : f.name;
      // Check if this fallback matches a configured LLM key
      if (Object.keys(llms).includes(fallbackName) && fallbackName !== key) {
        return `ref:${fallbackName}`;
      }
      return fallbackName;
    });
    
    // Parse authentication data
    const authData = parseResourceAuth(llm, safeStartsWith, safeString, config.service_principals || {});
    
    setFormData({
      name: key,
      modelName: llm.name,
      customModelName: llm.name,
      temperature: String(llm.temperature ?? 0.1),
      maxTokens: String(llm.max_tokens ?? 8192),
      onBehalfOfUser: llm.on_behalf_of_user ?? false,
      useResponseApi: llm.use_responses_api ?? false,
      fallbacks: convertedFallbacks,
      ...authData,
    });
    
    // Detect model source
    if (COMMON_MODELS.some(m => m.value === llm.name)) {
      setModelSource('preset');
    } else if (endpoints?.some(e => e.name === llm.name)) {
      setModelSource('endpoint');
    } else {
      setModelSource('custom');
    }
    
    const hasAuth = authData.authMethod !== 'default';
    setShowAdvanced(!!(llm.on_behalf_of_user || llm.use_responses_api || (llm.fallbacks && llm.fallbacks.length > 0) || hasAuth));
    setIsModalOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let modelName = '';
    
    switch (modelSource) {
      case 'preset':
        modelName = formData.modelName;
        break;
      case 'endpoint':
        modelName = formData.modelName;
        break;
      case 'custom':
        modelName = formData.customModelName;
        break;
    }
    
    if (formData.name && modelName) {
      const llmConfig: LLMModel = {
        name: modelName,
        temperature: parseFloat(formData.temperature),
        max_tokens: parseInt(formData.maxTokens),
      };

      if (formData.onBehalfOfUser) {
        llmConfig.on_behalf_of_user = true;
      }

      if (formData.useResponseApi) {
        llmConfig.use_responses_api = true;
      }

      if (formData.fallbacks.length > 0) {
        llmConfig.fallbacks = formData.fallbacks;
      }

      // Apply authentication configuration
      applyResourceAuth(llmConfig, formData as any);

      if (editingKey) {
        // If key changed, remove old and add new
        if (editingKey !== formData.name) {
          removeLLM(editingKey);
          addLLM(formData.name, llmConfig);
        } else {
          updateLLM(editingKey, llmConfig);
        }
      } else {
        addLLM(formData.name, llmConfig);
      }

      resetForm();
      setIsModalOpen(false);
    }
  };

  const addFallback = () => {
    setFormData({
      ...formData,
      fallbacks: [...formData.fallbacks, ''],
    });
  };

  const updateFallback = (index: number, value: string) => {
    const newFallbacks = [...formData.fallbacks];
    newFallbacks[index] = value;
    setFormData({ ...formData, fallbacks: newFallbacks });
  };

  const removeFallback = (index: number) => {
    setFormData({
      ...formData,
      fallbacks: formData.fallbacks.filter((_, i) => i !== index),
    });
  };

  // Status mapper for serving endpoints
  const getEndpointStatus = (state: { ready?: string; config_update?: string } | undefined): StatusType => {
    const readyState = state?.ready?.toUpperCase();
    switch (readyState) {
      case 'READY':
        return 'ready';
      case 'NOT_READY':
        return 'transitioning';
      default:
        return 'unknown';
    }
  };

  const endpointOptions: StatusSelectOption[] = [
    { value: '', label: endpointsLoading ? 'Loading endpoints...' : 'Select an endpoint...' },
    ...(endpoints || []).map((e) => ({
      value: e.name,
      label: e.name,
      status: getEndpointStatus(e.state),
    })),
  ];


  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Cpu className="w-5 h-5 text-purple-400" />
          <h3 className="text-lg font-semibold text-slate-100">Language Models</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setIsModalOpen(true)}>
          <Plus className="w-4 h-4 mr-1" />
          Add LLM
        </Button>
      </div>

      {/* LLM List */}
      {Object.keys(llms).length > 0 ? (
        <div className="space-y-2">
          {Object.entries(llms).map(([key, llm]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key, llm)}
            >
              <div className="flex items-center space-x-3">
                <Cpu className="w-4 h-4 text-purple-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">{llm.name}</p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {llm.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                {llm.fallbacks && llm.fallbacks.length > 0 && (
                  <Badge variant="warning" title={`${llm.fallbacks.length} fallback(s)`}>
                    <Layers className="w-3 h-3 mr-1" />
                    {llm.fallbacks.length}
                  </Badge>
                )}
                <Badge variant="info">temp: {llm.temperature ?? 0.1}</Badge>
                <Badge variant="default">tokens: {llm.max_tokens ?? 8192}</Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    safeDelete('LLM', key, () => removeLLM(key));
                  }}
                >
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-slate-500 text-sm">No LLMs configured. Add language models that will power your AI agents.</p>
      )}

      {/* Add/Edit LLM Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          resetForm();
        }}
        title={editingKey ? 'Edit Language Model' : 'Add Language Model'}
        description="Configure an LLM for your agents to use"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Reference Name"
            placeholder="e.g., Default LLM"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: normalizeRefNameWhileTyping(e.target.value) })}
            hint="Type naturally - spaces become underscores"
            required
          />

          {/* Model Source Selector */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">Model Source</label>
            <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 w-full">
              <button
                type="button"
                onClick={() => setModelSource('preset')}
                className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                  modelSource === 'preset'
                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                }`}
              >
                Preset
              </button>
              <button
                type="button"
                onClick={() => setModelSource('endpoint')}
                className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                  modelSource === 'endpoint'
                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                }`}
              >
                Endpoint
              </button>
              <button
                type="button"
                onClick={() => setModelSource('custom')}
                className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                  modelSource === 'custom'
                    ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                }`}
              >
                Custom
              </button>
            </div>
          </div>

          {modelSource === 'preset' && (
            <Select
              label="Model"
              options={[{ value: '', label: 'Select a model...' }, ...COMMON_MODELS]}
              value={formData.modelName}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ 
                ...formData, 
                modelName: e.target.value,
                name: formData.name || generateRefName(e.target.value),
              })}
              required
            />
          )}

          {modelSource === 'endpoint' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-slate-300">Serving Endpoint</label>
                <button
                  type="button"
                  onClick={() => refetchEndpoints()}
                  className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                  disabled={endpointsLoading}
                >
                  <RefreshCw className={`w-3 h-3 ${endpointsLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>
              <StatusSelect
                options={endpointOptions}
                value={formData.modelName}
                onChange={(value) => setFormData({ 
                  ...formData, 
                  modelName: value,
                  name: formData.name || generateRefName(value),
                })}
                disabled={endpointsLoading}
                placeholder="Select an endpoint..."
              />
              {endpointsLoading && (
                <p className="text-xs text-slate-500">Loading endpoints from Databricks...</p>
              )}
            </div>
          )}

          {modelSource === 'custom' && (
            <Input
              label="Custom Model Name"
              placeholder="e.g., my-custom-endpoint"
              value={formData.customModelName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, customModelName: e.target.value })}
              hint="Enter the name of your custom model endpoint"
              required
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Temperature"
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={formData.temperature}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, temperature: e.target.value })}
              hint="0.0 = deterministic, 2.0 = creative"
            />
            <Input
              label="Max Tokens"
              type="number"
              min="1"
              max="128000"
              value={formData.maxTokens}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, maxTokens: e.target.value })}
              hint="Maximum response length"
            />
          </div>

          {/* Advanced Options Toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center space-x-2 text-sm text-slate-400 hover:text-white transition-colors"
          >
            {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span>Advanced Options</span>
            {(formData.onBehalfOfUser || formData.useResponseApi || formData.fallbacks.length > 0 || formData.authMethod !== 'default') && (
              <Badge variant="info" className="ml-2">
                {(formData.onBehalfOfUser ? 1 : 0) + (formData.useResponseApi ? 1 : 0) + (formData.fallbacks.length > 0 ? 1 : 0) + (formData.authMethod !== 'default' ? 1 : 0)} configured
              </Badge>
            )}
          </button>

          {showAdvanced && (
            <div className="space-y-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700">
              {/* Authentication Section */}
              <ResourceAuthSection
                formData={formData as any}
                setFormData={(data) => setFormData({ ...formData, ...data })}
                servicePrincipals={config.service_principals || {}}
                variables={config.variables || {}}
                variableNames={Object.keys(config.variables || {})}
              />

              {/* Response API Option */}
              <div className="space-y-2">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.useResponseApi}
                    onChange={(e) => setFormData({ ...formData, useResponseApi: e.target.checked })}
                    className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                  />
                  <span className="text-sm text-slate-300">Use Response API</span>
                </label>
                <p className="text-xs text-slate-500 ml-6">
                  Enable when using the Databricks response API for streaming and enhanced features
                </p>
              </div>

              {/* Fallbacks */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-slate-300">Fallback Models</label>
                    <p className="text-xs text-slate-500 mt-1">
                      Alternative models to try if the primary model fails.
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={addFallback}
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Fallback
                  </Button>
                </div>

                {formData.fallbacks.length > 0 ? (
                  <div className="space-y-3">
                    {formData.fallbacks.map((fallback, index) => {
                      const fallbackStr = safeString(fallback);
                      const isReference = safeStartsWith(fallbackStr, 'ref:');
                      const refKey = isReference ? fallbackStr.slice(4) : null;
                      const hasConfiguredLLMs = Object.keys(llms).filter(k => k !== editingKey && k !== formData.name).length > 0;
                      
                      return (
                        <FallbackItem
                          key={index}
                          index={index}
                          fallback={fallback}
                          isReference={isReference}
                          refKey={refKey}
                          hasConfiguredLLMs={hasConfiguredLLMs}
                          llms={llms}
                          endpoints={endpoints || []}
                          editingKey={editingKey}
                          formDataName={formData.name}
                          onUpdate={(value) => updateFallback(index, value)}
                          onRemove={() => removeFallback(index)}
                          getEndpointStatus={getEndpointStatus}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 italic">No fallbacks configured.</p>
                )}
              </div>
            </div>
          )}

          {/* Duplicate reference name warning */}
          {formData.name && isRefNameDuplicate(formData.name, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.name}" already exists. Please choose a unique name.
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="secondary" type="button" onClick={() => {
              setIsModalOpen(false);
              resetForm();
            }}>
              Cancel
            </Button>
            <Button type="submit" disabled={isRefNameDuplicate(formData.name, config, editingKey)}>
              {editingKey ? 'Save Changes' : 'Add LLM'}
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

// =============================================================================
// Genie Rooms Panel
// =============================================================================
type SpaceIdSource = 'select' | 'manual' | 'variable';

function GenieRoomsPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addGenieRoom, updateGenieRoom, removeGenieRoom } = useConfigStore();
  const genieRooms = config.resources?.genie_rooms || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};
  const { data: genieSpaces, loading, refetch: refetchSpaces } = useGenieSpaces();
  
  const [spaceIdSource, setSpaceIdSource] = useState<SpaceIdSource>('select');
  const [formData, setFormData] = useState({
    refName: '',
    name: '',
    description: '',
    space_id: '',
    space_id_variable: '', // For variable reference
    on_behalf_of_user: false,
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const room = genieRooms[key];
    const spaceIdDisplay = room.space_id ? getVariableDisplayValue(room.space_id) : '';
    
    // Determine source type and extract appropriate values
    let source: SpaceIdSource = 'manual';
    let spaceIdValue = '';
    let variableName = '';
    
    if (!room.space_id) {
      source = 'manual';
    } else if (typeof room.space_id === 'string') {
      if (safeStartsWith(room.space_id, '*')) {
        source = 'variable';
        variableName = room.space_id.substring(1);
      } else {
        const isInList = genieSpaces?.some(s => s.space_id === room.space_id);
        source = isInList ? 'select' : 'manual';
        spaceIdValue = room.space_id;
      }
    } else if (typeof room.space_id === 'object' && room.space_id !== null) {
      const obj = room.space_id as unknown as Record<string, unknown>;
      if ('env' in obj) {
        source = 'manual';
        spaceIdValue = obj.default_value !== undefined ? String(obj.default_value) : spaceIdDisplay;
      } else if ('secret' in obj) {
        source = 'manual';
        spaceIdValue = spaceIdDisplay;
      } else {
        source = 'manual';
        spaceIdValue = spaceIdDisplay;
      }
    }
    
    // Parse authentication data
    const authData = parseResourceAuth(room, safeStartsWith, safeString, servicePrincipals);
    
    // Auto-populate name and description from Genie space if not provided
    let name = room.name || '';
    let description = room.description || '';
    if (spaceIdValue && (!room.name || !room.description)) {
      const space = genieSpaces?.find(s => s.space_id === spaceIdValue);
      if (space) {
        if (!room.name && space.title) {
          name = space.title;
        }
        if (!room.description && space.description) {
          description = space.description;
        }
      }
    }
    
    setSpaceIdSource(source);
    setFormData({
      refName: key,
      name,
      description,
      space_id: spaceIdValue,
      space_id_variable: variableName,
      ...authData,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    // Determine space_id value based on source (optional - name-only is valid)
    let spaceIdValue: string | undefined = formData.space_id || undefined;
    if (spaceIdSource === 'variable' && formData.space_id_variable) {
      spaceIdValue = `*${formData.space_id_variable}`;
    }
    
    const genieRoom: GenieRoomModel = {
      name: formData.name,
      description: formData.description || undefined,
      ...(spaceIdValue && { space_id: spaceIdValue }),
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    // Apply authentication configuration
    applyResourceAuth(genieRoom, formData as any);
    
    if (editingKey) {
      // If key changed, remove old and add new
      if (editingKey !== formData.refName) {
        removeGenieRoom(editingKey);
        addGenieRoom(formData.refName, genieRoom);
      } else {
        updateGenieRoom(formData.refName, genieRoom);
      }
    } else {
      addGenieRoom(formData.refName, genieRoom);
    }
    
    setSpaceIdSource('select');
    setFormData({ 
      refName: '', 
      name: '', 
      description: '', 
      space_id: '', 
      space_id_variable: '', 
      on_behalf_of_user: false,
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    onClose();
  };

  const handleDelete = (key: string) => {
    safeDelete('Genie Room', key, () => removeGenieRoom(key));
  };

  const genieSpaceOptions = [
    { value: '', label: loading ? 'Loading Genie spaces...' : 'Select a Genie space...' },
    ...(genieSpaces || []).map((s) => ({
      value: s.space_id,
      label: `${s.title}${s.description ? ` - ${s.description.substring(0, 50)}${s.description.length > 50 ? '...' : ''}` : ''}`,
    })),
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <MessageSquare className="w-5 h-5 text-purple-400" />
          <h3 className="text-lg font-semibold text-slate-100">Genie Rooms</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setSpaceIdSource('select'); setFormData({ refName: '', name: '', description: '', space_id: '', space_id_variable: '', on_behalf_of_user: false, authMethod: 'default', servicePrincipalRef: '', clientIdSource: 'variable', clientSecretSource: 'variable', workspaceHostSource: 'variable', patSource: 'variable', client_id: '', client_secret: '', workspace_host: '', pat: '', clientIdVariable: '', clientSecretVariable: '', workspaceHostVariable: '', patVariable: '' }); setEditingKey(null); setShowForm(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Genie Room
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(genieRooms).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(genieRooms).map(([key, room]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <MessageSquare className="w-4 h-4 text-purple-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {room.name}{room.space_id ? ` • Space ID: ${getVariableDisplayValue(room.space_id).substring(0, 12)}...` : ' (name only)'}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {room.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(genieRooms).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No Genie rooms configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Genie Room</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Retail Genie"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Space ID Source Toggle */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300">Genie Space</label>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => {
                    setSpaceIdSource('select');
                    setFormData({ ...formData, space_id: '', space_id_variable: '', name: '', description: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded ${
                    spaceIdSource === 'select' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Select
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSpaceIdSource('manual');
                    setFormData({ ...formData, space_id: '', space_id_variable: '', name: '', description: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded ${
                    spaceIdSource === 'manual' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Manual
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSpaceIdSource('variable');
                    setFormData({ ...formData, space_id: '', space_id_variable: '', name: '', description: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                    spaceIdSource === 'variable' ? 'bg-purple-500/30 text-purple-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  <Key className="w-3 h-3" />
                  <span>Variable</span>
                </button>
              </div>
            </div>
            
            {spaceIdSource === 'select' && (
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <div className="flex-1">
                    <Select
                      value={formData.space_id}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                        const selectedSpaceId = e.target.value;
                        const space = genieSpaces?.find(s => s.space_id === selectedSpaceId);
                        const spaceName = space?.title || '';
                        const spaceDesc = space?.description || '';
                        
                        setFormData({ 
                          ...formData, 
                          space_id: selectedSpaceId,
                          space_id_variable: '',
                          refName: editingKey ? formData.refName : generateRefName(spaceName),
                          name: spaceName,
                          description: spaceDesc,
                        });
                      }}
                      options={genieSpaceOptions}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => refetchSpaces()}
                    className="p-2 text-slate-400 hover:text-white"
                    disabled={loading}
                  >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Select from {genieSpaces?.length || 0} available Genie spaces. Display Name and Description will auto-fill.
                </p>
              </div>
            )}
            
            {spaceIdSource === 'manual' && (
              <div className="space-y-2">
                <Input
                  value={formData.space_id}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const spaceId = e.target.value;
                    setFormData({ 
                      ...formData, 
                      space_id: spaceId,
                      space_id_variable: '',
                      refName: editingKey ? formData.refName : generateRefName(spaceId),
                    });
                  }}
                  placeholder="01f0d05d42ed11eeae85802c1d5bcccd"
                />
                <p className="text-xs text-slate-500">
                  Enter the Genie space ID directly. You can find this in the Genie room URL.
                </p>
              </div>
            )}
            
            {spaceIdSource === 'variable' && (
              <div className="space-y-2">
                {Object.keys(variables).length > 0 ? (
                  <Select
                    value={formData.space_id_variable}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      const varName = e.target.value;
                      setFormData({ 
                        ...formData, 
                        space_id_variable: varName,
                        space_id: '',
                        refName: editingKey ? formData.refName : generateRefName(varName || 'genie'),
                      });
                    }}
                    options={[
                      { value: '', label: 'Select a variable...' },
                      ...Object.keys(variables).map(name => ({
                        value: name,
                        label: name,
                      })),
                    ]}
                  />
                ) : (
                  <Input
                    value={formData.space_id_variable}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const varName = e.target.value;
                      setFormData({ 
                        ...formData, 
                        space_id_variable: varName,
                        space_id: '',
                        refName: editingKey ? formData.refName : generateRefName(varName || 'genie'),
                      });
                    }}
                    placeholder="genie_space_id"
                  />
                )}
                <p className="text-xs text-slate-500">
                  Reference a variable containing the Genie space ID. The value will be resolved at runtime.
                </p>
              </div>
            )}
          </div>
          
          <Input
            label="Display Name"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Retail Analytics Genie"
            required
          />
          
          <div className="space-y-1">
            <label className="block text-sm font-medium text-slate-300">Description</label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Query retail data using natural language"
              rows={3}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>
          
          {/* Authentication Section */}
          <ResourceAuthSection
            formData={formData as any}
            setFormData={(data) => setFormData({ ...formData, ...data })}
            servicePrincipals={config.service_principals || {}}
            variables={config.variables || {}}
            variableNames={Object.keys(config.variables || {})}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={
                !formData.refName || 
                !formData.name || 
                isRefNameDuplicate(formData.refName, config, editingKey)
              }
            >
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Warehouses Panel
// =============================================================================
type WarehouseIdSource = 'select' | 'manual' | 'variable' | 'env';

function WarehousesPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addWarehouse, updateWarehouse, removeWarehouse } = useConfigStore();
  const warehouses = config.resources?.warehouses || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};
  const { data: sqlWarehouses, loading, refetch: refetchWarehouses } = useSQLWarehouses();
  
  const [warehouseIdSource, setWarehouseIdSource] = useState<WarehouseIdSource>('select');
  const [formData, setFormData] = useState({
    refName: '',
    name: '',
    description: '',
    warehouse_id: '',
    warehouse_id_variable: '',
    warehouse_id_env: '',
    warehouse_id_env_default: '',
    on_behalf_of_user: false,
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const wh = warehouses[key];
    
    let source: WarehouseIdSource = 'manual';
    let directId = '';
    let variableName = '';
    let envName = '';
    let envDefault = '';
    
    if (!wh.warehouse_id) {
      source = 'manual';
    } else if (typeof wh.warehouse_id === 'object' && wh.warehouse_id !== null) {
      const obj = wh.warehouse_id as unknown as Record<string, unknown>;
      if ('env' in obj && typeof obj.env === 'string') {
        source = 'env';
        envName = obj.env;
        envDefault = obj.default_value !== undefined && obj.default_value !== null ? String(obj.default_value) : '';
      } else {
        source = 'manual';
        directId = getVariableDisplayValue(wh.warehouse_id);
      }
    } else {
      const warehouseId = safeString(wh.warehouse_id);
      const isVariableRef = safeStartsWith(warehouseId, '__REF__');
      variableName = isVariableRef ? warehouseId.substring(7) : '';
      directId = isVariableRef ? '' : warehouseId;
      
      if (isVariableRef) {
        source = 'variable';
      } else if (sqlWarehouses?.some(w => w.id === warehouseId)) {
        source = 'select';
      }
    }
    
    // Parse authentication data
    const authData = parseResourceAuth(wh, safeStartsWith, safeString, servicePrincipals);
    
    // Auto-populate name from SQL warehouse if not provided
    let name = wh.name || '';
    if (directId && !wh.name) {
      const warehouse = sqlWarehouses?.find(w => w.id === directId);
      if (warehouse?.name) {
        name = warehouse.name;
      }
    }
    
    setWarehouseIdSource(source);
    setFormData({
      refName: key,
      name,
      description: wh.description || '',
      warehouse_id: directId,
      warehouse_id_variable: variableName,
      warehouse_id_env: envName,
      warehouse_id_env_default: envDefault,
      ...authData,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    // Determine the final warehouse_id value (optional - name-only is valid)
    let finalWarehouseId: WarehouseModel['warehouse_id'] | undefined = formData.warehouse_id || undefined;
    if (warehouseIdSource === 'variable' && formData.warehouse_id_variable) {
      finalWarehouseId = `__REF__${formData.warehouse_id_variable}`;
    } else if (warehouseIdSource === 'env' && formData.warehouse_id_env) {
      const envObj: Record<string, unknown> = { env: formData.warehouse_id_env };
      if (formData.warehouse_id_env_default) {
        envObj.default_value = formData.warehouse_id_env_default;
      }
      finalWarehouseId = envObj as any;
    }
    
    const warehouse: WarehouseModel = {
      name: formData.name,
      description: formData.description || undefined,
      ...(finalWarehouseId && { warehouse_id: finalWarehouseId }),
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    // Apply authentication configuration
    applyResourceAuth(warehouse, formData as any);
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeWarehouse(editingKey);
        addWarehouse(formData.refName, warehouse);
      } else {
        updateWarehouse(formData.refName, warehouse);
      }
    } else {
      addWarehouse(formData.refName, warehouse);
    }
    
    setFormData({ 
      refName: '', 
      name: '', 
      description: '', 
      warehouse_id: '', 
      warehouse_id_variable: '', 
      warehouse_id_env: '',
      warehouse_id_env_default: '',
      on_behalf_of_user: false,
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    setWarehouseIdSource('select');
    onClose();
  };

  const handleDelete = (key: string) => {
    safeDelete('Warehouse', key, () => removeWarehouse(key));
  };

  // Status mapper for warehouses
  const getWarehouseStatus = (state: string | undefined): StatusType => {
    switch (state?.toUpperCase()) {
      case 'RUNNING':
        return 'ready';
      case 'STARTING':
      case 'STOPPING':
      case 'RESTARTING':
        return 'transitioning';
      case 'STOPPED':
      case 'DELETED':
      case 'DELETING':
        return 'stopped';
      default:
        return 'unknown';
    }
  };

  const warehouseOptions: StatusSelectOption[] = [
    { value: '', label: loading ? 'Loading...' : 'Select a SQL warehouse...' },
    ...(sqlWarehouses || []).map((wh) => ({
      value: wh.id,
      label: wh.name,
      status: getWarehouseStatus(wh.state),
    })),
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Database className="w-5 h-5 text-emerald-400" />
          <h3 className="text-lg font-semibold text-slate-100">SQL Warehouses</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setFormData({ refName: '', name: '', description: '', warehouse_id: '', warehouse_id_variable: '', warehouse_id_env: '', warehouse_id_env_default: '', on_behalf_of_user: false, authMethod: 'default', servicePrincipalRef: '', clientIdSource: 'variable', clientSecretSource: 'variable', workspaceHostSource: 'variable', patSource: 'variable', client_id: '', client_secret: '', workspace_host: '', pat: '', clientIdVariable: '', clientSecretVariable: '', workspaceHostVariable: '', patVariable: '' }); setWarehouseIdSource('select'); setEditingKey(null); setShowForm(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Warehouse
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(warehouses).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(warehouses).map(([key, wh]) => {
            let displayId = '';
            let displayLabel = '';
            if (!wh.warehouse_id) {
              displayLabel = '';
              displayId = '(name only)';
            } else {
              const isEnvVar = typeof wh.warehouse_id === 'object' && wh.warehouse_id !== null && 'env' in (wh.warehouse_id as unknown as Record<string, unknown>);
              const warehouseIdStr = safeString(wh.warehouse_id);
              const isVariableRef = safeStartsWith(warehouseIdStr, '__REF__');
              if (isEnvVar) {
                const envObj = wh.warehouse_id as unknown as Record<string, unknown>;
                displayId = `$${envObj.env}`;
                displayLabel = 'Env: ';
              } else if (isVariableRef) {
                displayId = `$${warehouseIdStr.substring(7)}`;
                displayLabel = 'Var: ';
              } else {
                const resolved = getVariableDisplayValue(wh.warehouse_id);
                displayId = resolved ? `${resolved.substring(0, 12)}...` : '';
                displayLabel = 'ID: ';
              }
            }
            return (
              <div 
                key={key} 
                className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
                onClick={() => handleEdit(key)}
              >
                <div className="flex items-center space-x-3">
                  <Database className="w-4 h-4 text-emerald-400" />
                  <div>
                    <p className="font-medium text-slate-200">{key}</p>
                    <p className="text-xs text-slate-500">
                      {wh.name}{displayLabel || displayId ? ` • ${displayLabel}${displayId}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {wh.on_behalf_of_user && (
                    <Badge variant="success" title="On Behalf of User">
                      <User className="w-3 h-3 mr-1" />
                      OBO
                    </Badge>
                  )}
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {Object.keys(warehouses).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No SQL warehouses configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} SQL Warehouse</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Main Warehouse"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* SQL Warehouse Source Toggle */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300">SQL Warehouse</label>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => {
                    setWarehouseIdSource('select');
                    setFormData({ ...formData, warehouse_id_variable: '', warehouse_id_env: '', warehouse_id_env_default: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded ${
                    warehouseIdSource === 'select' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Select
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWarehouseIdSource('manual');
                    setFormData({ ...formData, warehouse_id_variable: '', warehouse_id_env: '', warehouse_id_env_default: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded ${
                    warehouseIdSource === 'manual' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Manual
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWarehouseIdSource('variable');
                    setFormData({ ...formData, warehouse_id: '', warehouse_id_env: '', warehouse_id_env_default: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                    warehouseIdSource === 'variable' ? 'bg-purple-500/30 text-purple-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  <Key className="w-3 h-3" />
                  <span>Variable</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWarehouseIdSource('env');
                    setFormData({ ...formData, warehouse_id: '', warehouse_id_variable: '' });
                  }}
                  className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                    warehouseIdSource === 'env' ? 'bg-green-500/30 text-green-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  <CloudCog className="w-3 h-3" />
                  <span>Env</span>
                </button>
              </div>
            </div>
            
            {warehouseIdSource === 'select' && (
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <div className="flex-1">
                    <StatusSelect
                      value={formData.warehouse_id}
                      onChange={(value) => {
                        const wh = sqlWarehouses?.find(w => w.id === value);
                        const whName = wh?.name || '';
                        setFormData({ 
                          ...formData, 
                          warehouse_id: value,
                          warehouse_id_variable: '',
                          refName: editingKey ? formData.refName : generateRefName(whName),
                          name: whName || formData.name || '',
                        });
                      }}
                      options={warehouseOptions}
                      placeholder="Select a SQL warehouse..."
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => refetchWarehouses()}
                    className="p-2 text-slate-400 hover:text-white"
                    disabled={loading}
                  >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-xs text-slate-500">
                  Select from {sqlWarehouses?.length || 0} available SQL warehouses. Display Name will auto-fill.
                </p>
              </div>
            )}
            
            {warehouseIdSource === 'manual' && (
              <div className="space-y-2">
                <Input
                  value={formData.warehouse_id}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const warehouseId = e.target.value;
                    setFormData({ 
                      ...formData, 
                      warehouse_id: warehouseId,
                      warehouse_id_variable: '',
                      refName: editingKey ? formData.refName : generateRefName(warehouseId),
                    });
                  }}
                  placeholder="abc123def456"
                />
                <p className="text-xs text-slate-500">
                  Enter the warehouse ID directly. You can find this in the SQL warehouse settings.
                </p>
              </div>
            )}
            
            {warehouseIdSource === 'variable' && (
              <div className="space-y-2">
                {Object.keys(variables).length > 0 ? (
                  <Select
                    value={formData.warehouse_id_variable}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      const varName = e.target.value;
                      setFormData({ 
                        ...formData, 
                        warehouse_id_variable: varName,
                        warehouse_id: '',
                        refName: editingKey ? formData.refName : generateRefName(varName || 'warehouse'),
                      });
                    }}
                    options={[
                      { value: '', label: 'Select a variable...' },
                      ...Object.keys(variables).map(name => ({
                        value: name,
                        label: name,
                      })),
                    ]}
                  />
                ) : (
                  <Input
                    value={formData.warehouse_id_variable}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const varName = e.target.value;
                      setFormData({ 
                        ...formData, 
                        warehouse_id_variable: varName,
                        warehouse_id: '',
                        refName: editingKey ? formData.refName : generateRefName(varName || 'warehouse'),
                      });
                    }}
                    placeholder="warehouse_id"
                  />
                )}
                <p className="text-xs text-slate-500">
                  Reference a variable containing the warehouse ID. The value will be resolved at runtime.
                </p>
              </div>
            )}

            {warehouseIdSource === 'env' && (
              <div className="space-y-2">
                <Input
                  label="Environment Variable"
                  value={formData.warehouse_id_env}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, warehouse_id_env: e.target.value })}
                  placeholder="DATABRICKS_WAREHOUSE_ID"
                  required
                />
                <Input
                  label="Default Value (optional)"
                  value={formData.warehouse_id_env_default}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, warehouse_id_env_default: e.target.value })}
                  placeholder="abc123def456"
                />
                <p className="text-xs text-slate-500">
                  The warehouse ID will be read from this environment variable at runtime. If not set, the default value is used.
                </p>
              </div>
            )}
          </div>
          
          <Input
            label="Display Name"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Main Analytics Warehouse"
            required
          />
          
          <Input
            label="Description"
            value={formData.description}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Primary warehouse for analytics queries"
          />
          
          {/* Authentication Section */}
          <ResourceAuthSection
            formData={formData as any}
            setFormData={(data) => setFormData({ ...formData, ...data })}
            servicePrincipals={config.service_principals || {}}
            variables={config.variables || {}}
            variableNames={Object.keys(config.variables || {})}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={
                !formData.refName || 
                !formData.name || 
                isRefNameDuplicate(formData.refName, config, editingKey)
              }
            >
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Tables Panel
// =============================================================================
type SchemaSource = 'reference' | 'direct';

function TablesPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addTable, updateTable, removeTable } = useConfigStore();
  const tables = config.resources?.tables || {};
  const configuredSchemas = config.schemas || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};
  const { data: catalogs } = useCatalogs();
  
  // Default to 'reference' (Use Configured Schema) initially
  const [schemaSource, setSchemaSource] = useState<SchemaSource>('reference');
  // Track last used schema to retain between adds
  const [lastUsedSchema, setLastUsedSchema] = useState({ schemaRef: '', catalog_name: '', schema_name: '', source: 'reference' as SchemaSource });
  const [formData, setFormData] = useState({
    refName: '',
    schemaRef: '', // Reference to configured schema
    catalog_name: '',
    schema_name: '',
    name: '',
    on_behalf_of_user: false,
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const { data: schemas, loading: schemasLoading } = useSchemas(formData.catalog_name || null);
  const { data: tablesList, loading: tablesLoading } = useTables(
    schemaSource === 'reference' && formData.schemaRef ? getVariableDisplayValue(configuredSchemas[formData.schemaRef]?.catalog_name) || null : formData.catalog_name || null,
    schemaSource === 'reference' && formData.schemaRef ? getVariableDisplayValue(configuredSchemas[formData.schemaRef]?.schema_name) || null : formData.schema_name || null
  );

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const table = tables[key];
    // Detect if using schema reference
    const tableCatalogDisplay = getVariableDisplayValue(table.schema?.catalog_name);
    const tableSchemaDisplay = getVariableDisplayValue(table.schema?.schema_name);
    const isSchemaRef = table.schema && Object.entries(configuredSchemas).some(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === tableCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === tableSchemaDisplay
    );
    const schemaRefKey = isSchemaRef ? Object.entries(configuredSchemas).find(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === tableCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === tableSchemaDisplay
    )?.[0] : '';
    
    setSchemaSource(schemaRefKey ? 'reference' : 'direct');
    setFormData({
      refName: key,
      schemaRef: schemaRefKey || '',
      catalog_name: tableCatalogDisplay,
      schema_name: tableSchemaDisplay,
      name: table.name || '',
      // Parse authentication data (includes on_behalf_of_user)
      ...parseResourceAuth(table, safeStartsWith, safeString, servicePrincipals),
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    const table: TableModel = {
      name: formData.name || undefined,
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    // Apply authentication configuration
    applyResourceAuth(table, formData as any);
    
    if (schemaSource === 'reference' && formData.schemaRef) {
      const ref = configuredSchemas[formData.schemaRef];
      if (ref) {
        table.schema = {
          catalog_name: ref.catalog_name,
          schema_name: ref.schema_name,
        };
      }
    } else if (formData.catalog_name && formData.schema_name) {
      table.schema = {
        catalog_name: formData.catalog_name,
        schema_name: formData.schema_name,
      };
    }
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeTable(editingKey);
        addTable(formData.refName, table);
      } else {
        updateTable(formData.refName, table);
      }
    } else {
      addTable(formData.refName, table);
    }
    
    // Remember last used schema for convenience (including the source type)
    setLastUsedSchema({
      schemaRef: formData.schemaRef,
      catalog_name: formData.catalog_name,
      schema_name: formData.schema_name,
      source: schemaSource,
    });
    
    // Reset form but retain schema selection
    setFormData({ 
      refName: '', 
      schemaRef: formData.schemaRef, 
      catalog_name: formData.catalog_name, 
      schema_name: formData.schema_name, 
      name: '', 
      on_behalf_of_user: false,
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    // Keep schemaSource as is
    onClose();
  };

  const handleDelete = (key: string) => {
    removeTable(key);
  };

  const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
  const isSchemaSelected = schemaSource === 'reference' ? !!formData.schemaRef : (!!formData.catalog_name && !!formData.schema_name);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Table2 className="w-5 h-5 text-cyan-400" />
          <h3 className="text-lg font-semibold text-slate-100">Tables</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { 
          setFormData({ 
            refName: '', 
            schemaRef: lastUsedSchema.schemaRef, 
            catalog_name: lastUsedSchema.catalog_name, 
            schema_name: lastUsedSchema.schema_name, 
            name: '', 
            on_behalf_of_user: false,
            authMethod: 'default',
            servicePrincipalRef: '',
            clientIdSource: 'variable',
            clientSecretSource: 'variable',
            workspaceHostSource: 'variable',
            patSource: 'variable',
            client_id: '',
            client_secret: '',
            workspace_host: '',
            pat: '',
            clientIdVariable: '',
            clientSecretVariable: '',
            workspaceHostVariable: '',
            patVariable: '',
          }); 
          // Use last used schema source (defaults to 'reference')
          setSchemaSource(lastUsedSchema.source);
          setEditingKey(null); 
          setShowForm(true); 
        }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Table
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(tables).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(tables).map(([key, table]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <Table2 className="w-4 h-4 text-cyan-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {table.schema ? `${getVariableDisplayValue(table.schema.catalog_name)}.${getVariableDisplayValue(table.schema.schema_name)}${table.name ? `.${table.name}` : '.*'}` : table.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {table.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                {!table.on_behalf_of_user && table.service_principal && (
                  <Badge variant="info" title="Service Principal">
                    <Key className="w-3 h-3 mr-1" />
                    SP
                  </Badge>
                )}
                {!table.on_behalf_of_user && (table.client_id || table.client_secret) && (
                  <Badge variant="warning" title="OAuth2 / M2M">
                    <Key className="w-3 h-3 mr-1" />
                    OAuth
                  </Badge>
                )}
                {!table.on_behalf_of_user && table.pat && (
                  <Badge variant="default" title="Personal Access Token">
                    <Key className="w-3 h-3 mr-1" />
                    PAT
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(tables).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No tables configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Table</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Sales Data"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Schema Source Toggle */}
          {hasConfiguredSchemas && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Schema Source</label>
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 w-full">
                <button
                  type="button"
                  onClick={() => { setSchemaSource('reference'); setFormData({ ...formData, catalog_name: '', schema_name: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'reference'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Configured
                </button>
                <button
                  type="button"
                  onClick={() => { setSchemaSource('direct'); setFormData({ ...formData, schemaRef: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'direct'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
          )}
          
          {schemaSource === 'reference' && hasConfiguredSchemas ? (
            <Select
              label="Schema Reference"
              value={formData.schemaRef}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const schemaKey = e.target.value;
                const schema = configuredSchemas[schemaKey];
                const refName = schema ? generateRefName(`${getVariableDisplayValue(schema.catalog_name)}_${getVariableDisplayValue(schema.schema_name)}_tables`) : '';
                setFormData({ 
                  ...formData, 
                  schemaRef: schemaKey, 
                  name: '',
                  refName: formData.refName || refName,
                });
              }}
              options={[
                { value: '', label: 'Select a configured schema...' },
                ...Object.entries(configuredSchemas).map(([key, s]) => ({
                  value: key,
                  label: `${key} (${getVariableDisplayValue(s.catalog_name)}.${getVariableDisplayValue(s.schema_name)})`,
                })),
              ]}
              hint="Reference a schema defined in the Schemas section"
            />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Catalog"
                value={formData.catalog_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, catalog_name: e.target.value, schema_name: '', name: '' })}
                options={[
                  { value: '', label: 'Select catalog...' },
                  ...(catalogs || []).map((c) => ({ value: c.name, label: c.name })),
                ]}
              />
              <Select
                label="Schema"
                value={formData.schema_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const schemaName = e.target.value;
                  const refName = schemaName ? generateRefName(`${formData.catalog_name}_${schemaName}_tables`) : '';
                  setFormData({ 
                    ...formData, 
                    schema_name: schemaName, 
                    name: '',
                    refName: formData.refName || refName,
                  });
                }}
                options={[
                  { value: '', label: schemasLoading ? 'Loading schemas...' : 'Select schema...' },
                  ...(schemas || []).map((s) => ({ value: s.name, label: s.name })),
                ]}
                disabled={!formData.catalog_name || schemasLoading}
              />
            </div>
          )}
          
          {/* Show selected schema info when using reference */}
          {schemaSource === 'reference' && formData.schemaRef && configuredSchemas[formData.schemaRef] && (
            <div className="p-2 bg-slate-900/50 rounded text-xs text-slate-400">
              Using schema: <span className="text-slate-300">{getVariableDisplayValue(configuredSchemas[formData.schemaRef].catalog_name)}.{getVariableDisplayValue(configuredSchemas[formData.schemaRef].schema_name)}</span>
            </div>
          )}
          
          <Select
            label="Table"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const tableName = e.target.value;
              // Use functional update to ensure we have the latest state
              setFormData(prev => {
                // Generate refName based on table name or schema if "all tables"
                let newRefName = '';
                if (tableName) {
                  newRefName = generateRefName(tableName);
                } else if (schemaSource === 'reference' && prev.schemaRef) {
                  const schema = configuredSchemas[prev.schemaRef];
                  if (schema) {
                    newRefName = generateRefName(`${schema.catalog_name}_${schema.schema_name}_tables`);
                  }
                } else if (prev.catalog_name && prev.schema_name) {
                  newRefName = generateRefName(`${prev.catalog_name}_${prev.schema_name}_tables`);
                }
                
                // Only preserve refName if editing existing entry or user has manually typed something
                // For new entries, always update the refName when table selection changes
                const shouldPreserveRefName = editingKey && prev.refName;
                
                return { 
                  ...prev, 
                  name: tableName,
                  refName: shouldPreserveRefName ? prev.refName : newRefName,
                };
              });
            }}
            options={[
              { value: '', label: tablesLoading ? 'Loading tables...' : 'All tables (*)' },
              ...(tablesList || []).map((t) => ({ value: t.name, label: t.name })),
            ]}
            disabled={!isSchemaSelected || tablesLoading}
            hint="Leave empty for all tables in schema"
          />
          
          {/* Authentication Section */}
          <ResourceAuthSection
            formData={formData}
            setFormData={setFormData as any}
            variables={variables}
            servicePrincipals={servicePrincipals}
            variableNames={Object.keys(variables)}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!formData.refName || !isSchemaSelected || isRefNameDuplicate(formData.refName, config, editingKey)}>
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Volumes Panel
// =============================================================================
function VolumesPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addVolume, updateVolume, removeVolume } = useConfigStore();
  const volumes = config.resources?.volumes || {};
  const configuredSchemas = config.schemas || {};
  const { data: catalogs } = useCatalogs();
  
  // Default to 'reference' (Use Configured Schema) initially
  const [schemaSource, setSchemaSource] = useState<SchemaSource>('reference');
  // Track last used schema to retain between adds
  const [lastUsedSchema, setLastUsedSchema] = useState({ schemaRef: '', catalog_name: '', schema_name: '', source: 'reference' as SchemaSource });
  const [formData, setFormData] = useState({
    refName: '',
    schemaRef: '',
    catalog_name: '',
    schema_name: '',
    name: '',
    on_behalf_of_user: false,
  });

  const { data: schemas, loading: schemasLoading } = useSchemas(formData.catalog_name || null);
  const { data: volumesList, loading: volumesLoading } = useVolumes(
    schemaSource === 'reference' && formData.schemaRef ? getVariableDisplayValue(configuredSchemas[formData.schemaRef]?.catalog_name) || null : formData.catalog_name || null,
    schemaSource === 'reference' && formData.schemaRef ? getVariableDisplayValue(configuredSchemas[formData.schemaRef]?.schema_name) || null : formData.schema_name || null
  );

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const volume = volumes[key];
    const volumeCatalogDisplay = getVariableDisplayValue(volume.schema?.catalog_name);
    const volumeSchemaDisplay = getVariableDisplayValue(volume.schema?.schema_name);
    const isSchemaRef = volume.schema && Object.entries(configuredSchemas).some(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === volumeCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === volumeSchemaDisplay
    );
    const schemaRefKey = isSchemaRef ? Object.entries(configuredSchemas).find(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === volumeCatalogDisplay && 
        getVariableDisplayValue(s.schema_name) === volumeSchemaDisplay
    )?.[0] : '';
    
    setSchemaSource(schemaRefKey ? 'reference' : 'direct');
    setFormData({
      refName: key,
      schemaRef: schemaRefKey || '',
      catalog_name: volumeCatalogDisplay,
      schema_name: volumeSchemaDisplay,
      name: volume.name || '',
      on_behalf_of_user: volume.on_behalf_of_user || false,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    const volume: VolumeModel = {
      name: formData.name,
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    if (schemaSource === 'reference' && formData.schemaRef) {
      const ref = configuredSchemas[formData.schemaRef];
      if (ref) {
        volume.schema = {
          catalog_name: ref.catalog_name,
          schema_name: ref.schema_name,
        };
      }
    } else if (formData.catalog_name && formData.schema_name) {
      volume.schema = {
        catalog_name: formData.catalog_name,
        schema_name: formData.schema_name,
      };
    }
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeVolume(editingKey);
        addVolume(formData.refName, volume);
      } else {
        updateVolume(formData.refName, volume);
      }
    } else {
      addVolume(formData.refName, volume);
    }
    
    // Remember last used schema for convenience (including the source type)
    setLastUsedSchema({
      schemaRef: formData.schemaRef,
      catalog_name: formData.catalog_name,
      schema_name: formData.schema_name,
      source: schemaSource,
    });
    
    // Reset form but retain schema selection
    setFormData({ 
      refName: '', 
      schemaRef: formData.schemaRef, 
      catalog_name: formData.catalog_name, 
      schema_name: formData.schema_name, 
      name: '', 
      on_behalf_of_user: false 
    });
    // Keep schemaSource as is
    onClose();
  };

  const handleDelete = (key: string) => {
    removeVolume(key);
  };

  const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
  const isSchemaSelected = schemaSource === 'reference' ? !!formData.schemaRef : (!!formData.catalog_name && !!formData.schema_name);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <FolderOpen className="w-5 h-5 text-amber-400" />
          <h3 className="text-lg font-semibold text-slate-100">Volumes</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { 
          setFormData({ 
            refName: '', 
            schemaRef: lastUsedSchema.schemaRef, 
            catalog_name: lastUsedSchema.catalog_name, 
            schema_name: lastUsedSchema.schema_name, 
            name: '', 
            on_behalf_of_user: false 
          }); 
          // Use last used schema source (defaults to 'reference')
          setSchemaSource(lastUsedSchema.source);
          setEditingKey(null); 
          setShowForm(true); 
        }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Volume
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(volumes).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(volumes).map(([key, volume]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <FolderOpen className="w-4 h-4 text-amber-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {volume.schema ? `${getVariableDisplayValue(volume.schema.catalog_name)}.${getVariableDisplayValue(volume.schema.schema_name)}.${volume.name}` : volume.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {volume.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(volumes).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No volumes configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Volume</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Data Volume"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Schema Source Toggle */}
          {hasConfiguredSchemas && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Schema Source</label>
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 w-full">
                <button
                  type="button"
                  onClick={() => { setSchemaSource('reference'); setFormData({ ...formData, catalog_name: '', schema_name: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'reference'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Configured
                </button>
                <button
                  type="button"
                  onClick={() => { setSchemaSource('direct'); setFormData({ ...formData, schemaRef: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'direct'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
          )}
          
          {schemaSource === 'reference' && hasConfiguredSchemas ? (
            <Select
              label="Schema Reference"
              value={formData.schemaRef}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const schemaKey = e.target.value;
                setFormData({ ...formData, schemaRef: schemaKey, name: '' });
              }}
              options={[
                { value: '', label: 'Select a configured schema...' },
                ...Object.entries(configuredSchemas).map(([key, s]) => ({
                  value: key,
                  label: `${key} (${getVariableDisplayValue(s.catalog_name)}.${getVariableDisplayValue(s.schema_name)})`,
                })),
              ]}
              hint="Reference a schema defined in the Schemas section"
            />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Catalog"
                value={formData.catalog_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, catalog_name: e.target.value, schema_name: '', name: '' })}
                options={[
                  { value: '', label: 'Select catalog...' },
                  ...(catalogs || []).map((c) => ({ value: c.name, label: c.name })),
                ]}
              />
              <Select
                label="Schema"
                value={formData.schema_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, schema_name: e.target.value, name: '' })}
                options={[
                  { value: '', label: schemasLoading ? 'Loading schemas...' : 'Select schema...' },
                  ...(schemas || []).map((s) => ({ value: s.name, label: s.name })),
                ]}
                disabled={!formData.catalog_name || schemasLoading}
              />
            </div>
          )}
          
          {/* Show selected schema info when using reference */}
          {schemaSource === 'reference' && formData.schemaRef && configuredSchemas[formData.schemaRef] && (
            <div className="p-2 bg-slate-900/50 rounded text-xs text-slate-400">
              Using schema: <span className="text-slate-300">{getVariableDisplayValue(configuredSchemas[formData.schemaRef].catalog_name)}.{getVariableDisplayValue(configuredSchemas[formData.schemaRef].schema_name)}</span>
            </div>
          )}
          
          <Select
            label="Volume"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const volumeName = e.target.value;
              setFormData({ 
                ...formData, 
                name: volumeName,
                refName: formData.refName || generateRefName(volumeName),
              });
            }}
            options={[
              { value: '', label: volumesLoading ? 'Loading volumes...' : 'Select volume...' },
              ...(volumesList || []).map((v) => ({ value: v.name, label: v.name })),
            ]}
            disabled={!isSchemaSelected || volumesLoading}
          />
          
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.on_behalf_of_user}
              onChange={(e) => setFormData({ ...formData, on_behalf_of_user: e.target.checked })}
              className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
            />
            <UserCheck className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-slate-300">On Behalf of User</span>
          </label>
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!formData.refName || !formData.name || !isSchemaSelected || isRefNameDuplicate(formData.refName, config, editingKey)}>
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Functions Panel
// =============================================================================
function FunctionsPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addFunction, updateFunction, removeFunction } = useConfigStore();
  const functions = config.resources?.functions || {};
  const configuredSchemas = config.schemas || {};
  const { data: catalogs } = useCatalogs();
  
  // Default to 'reference' (Use Configured Schema) initially
  const [schemaSource, setSchemaSource] = useState<SchemaSource>('reference');
  // Track last used schema to retain between adds
  const [lastUsedSchema, setLastUsedSchema] = useState({ schemaRef: '', catalog_name: '', schema_name: '', source: 'reference' as SchemaSource });
  const [formData, setFormData] = useState({
    refName: '',
    schemaRef: '',
    catalog_name: '',
    schema_name: '',
    name: '',
    on_behalf_of_user: false,
  });

  // Get current schema info for filtering - always have fallback to formData values
  // Prioritize: 1) configured schema (if schemaRef is set), 2) formData values
  // formData.catalog_name and formData.schema_name are always populated when editing
  const getEffectiveCatalog = (): string => {
    // If using a schema reference and it exists in configured schemas, use it
    if (schemaSource === 'reference' && formData.schemaRef && configuredSchemas[formData.schemaRef]) {
      return getVariableDisplayValue(configuredSchemas[formData.schemaRef].catalog_name);
    }
    // Fall back to direct form values (always populated when editing)
    return formData.catalog_name;
  };
  
  const getEffectiveSchema = (): string => {
    // If using a schema reference and it exists in configured schemas, use it
    if (schemaSource === 'reference' && formData.schemaRef && configuredSchemas[formData.schemaRef]) {
      return getVariableDisplayValue(configuredSchemas[formData.schemaRef].schema_name);
    }
    // Fall back to direct form values (always populated when editing)
    return formData.schema_name;
  };
  
  const currentCatalog = getEffectiveCatalog();
  const currentSchema = getEffectiveSchema();
  
  // Use currentCatalog for schemas fetch when in reference mode (to properly load schema list)
  const { data: schemas, loading: schemasLoading } = useSchemas(currentCatalog || null);
  
  // Fetch functions for the current catalog/schema - these should always be populated when editing
  const { data: functionsList, loading: functionsLoading, refetch: refetchFunctions } = useFunctions(
    currentCatalog || null,
    currentSchema || null
  );
  
  // Debug: Log when editing to verify catalog/schema values
  useEffect(() => {
    if (editingKey && showForm) {
      console.log('[FunctionsPanel] Editing function:', editingKey);
      console.log('[FunctionsPanel] schemaSource:', schemaSource);
      console.log('[FunctionsPanel] formData:', formData);
      console.log('[FunctionsPanel] currentCatalog:', currentCatalog);
      console.log('[FunctionsPanel] currentSchema:', currentSchema);
      console.log('[FunctionsPanel] functionsList:', functionsList);
      
      // If we have catalog and schema but no functions list, try refetching
      if (currentCatalog && currentSchema && !functionsList && !functionsLoading) {
        console.log('[FunctionsPanel] Triggering refetch...');
        refetchFunctions();
      }
    }
  }, [editingKey, showForm, schemaSource, formData, currentCatalog, currentSchema, functionsList, functionsLoading, refetchFunctions]);
  
  // Filter out functions that have already been added from the same schema
  const alreadyAddedFunctions = Object.values(functions)
    .filter(f => f.schema?.catalog_name === currentCatalog && f.schema?.schema_name === currentSchema)
    .map(f => f.name)
    .filter(Boolean);
  
  const availableFunctions = (functionsList || []).filter(f => 
    // When editing, include the current function being edited
    editingKey ? !alreadyAddedFunctions.includes(f.name) || f.name === functions[editingKey]?.name : !alreadyAddedFunctions.includes(f.name)
  );

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const func = functions[key];
    const funcCatalog = getVariableDisplayValue(func.schema?.catalog_name);
    const funcSchema = getVariableDisplayValue(func.schema?.schema_name);
    
    const isSchemaRef = func.schema && Object.entries(configuredSchemas).some(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === funcCatalog && 
        getVariableDisplayValue(s.schema_name) === funcSchema
    );
    const schemaRefKey = isSchemaRef ? Object.entries(configuredSchemas).find(
      ([, s]) => getVariableDisplayValue(s.catalog_name) === funcCatalog && 
        getVariableDisplayValue(s.schema_name) === funcSchema
    )?.[0] : '';
    
    // Always set both schema source and form data together
    // Ensure catalog_name and schema_name are always populated for function lookup
    const newSchemaSource = schemaRefKey ? 'reference' : 'direct';
    setSchemaSource(newSchemaSource);
    setFormData({
      refName: key,
      schemaRef: schemaRefKey || '',
      // Always populate catalog_name and schema_name from the function being edited
      // This ensures useFunctions can look up functions even if schemaRef lookup fails
      catalog_name: funcCatalog,
      schema_name: funcSchema,
      name: func.name || '',
      on_behalf_of_user: func.on_behalf_of_user || false,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    const func: FunctionModel = {
      name: formData.name || undefined,
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    if (schemaSource === 'reference' && formData.schemaRef) {
      const ref = configuredSchemas[formData.schemaRef];
      if (ref) {
        func.schema = {
          catalog_name: ref.catalog_name,
          schema_name: ref.schema_name,
        };
      }
    } else if (formData.catalog_name && formData.schema_name) {
      func.schema = {
        catalog_name: formData.catalog_name,
        schema_name: formData.schema_name,
      };
    }
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeFunction(editingKey);
        addFunction(formData.refName, func);
      } else {
        updateFunction(formData.refName, func);
      }
    } else {
      addFunction(formData.refName, func);
    }
    
    // Remember last used schema for convenience (including the source type)
    setLastUsedSchema({
      schemaRef: formData.schemaRef,
      catalog_name: formData.catalog_name,
      schema_name: formData.schema_name,
      source: schemaSource,
    });
    
    // Reset form but retain schema selection
    setFormData({ 
      refName: '', 
      schemaRef: formData.schemaRef, 
      catalog_name: formData.catalog_name, 
      schema_name: formData.schema_name, 
      name: '', 
      on_behalf_of_user: false 
    });
    // Keep schemaSource as is
    onClose();
  };

  const handleDelete = (key: string) => {
    safeDelete('Function', key, () => removeFunction(key));
  };

  const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
  const isSchemaSelected = schemaSource === 'reference' ? !!formData.schemaRef : (!!formData.catalog_name && !!formData.schema_name);

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Code2 className="w-5 h-5 text-pink-400" />
          <h3 className="text-lg font-semibold text-slate-100">Functions</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { 
          setFormData({ 
            refName: '', 
            schemaRef: lastUsedSchema.schemaRef, 
            catalog_name: lastUsedSchema.catalog_name, 
            schema_name: lastUsedSchema.schema_name, 
            name: '', 
            on_behalf_of_user: false 
          }); 
          // Use last used schema source (defaults to 'reference')
          setSchemaSource(lastUsedSchema.source);
          setEditingKey(null); 
          setShowForm(true); 
        }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Function
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(functions).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(functions).map(([key, func]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <Code2 className="w-4 h-4 text-pink-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {func.schema ? `${getVariableDisplayValue(func.schema.catalog_name)}.${getVariableDisplayValue(func.schema.schema_name)}${func.name ? `.${func.name}` : '.*'}` : func.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {func.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(functions).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No functions configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Function</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="UC Functions"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Schema Source Toggle */}
          {hasConfiguredSchemas && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-slate-300">Schema Source</label>
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5 w-full">
                <button
                  type="button"
                  onClick={() => { setSchemaSource('reference'); setFormData({ ...formData, catalog_name: '', schema_name: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'reference'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Configured
                </button>
                <button
                  type="button"
                  onClick={() => { setSchemaSource('direct'); setFormData({ ...formData, schemaRef: '' }); }}
                  className={`flex-1 px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                    schemaSource === 'direct'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
          )}
          
          {schemaSource === 'reference' && hasConfiguredSchemas ? (
            <Select
              label="Schema Reference"
              value={formData.schemaRef}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                const schemaRefValue = e.target.value;
                const schema = schemaRefValue ? configuredSchemas[schemaRefValue] : null;
                // Generate default refName based on schema (for "all functions" case)
                const refName = schema ? generateRefName(`${schema.catalog_name}_${schema.schema_name}_functions`) : '';
                setFormData({ 
                  ...formData, 
                  schemaRef: schemaRefValue, 
                  name: '',
                  refName: formData.refName || refName,
                });
              }}
              options={[
                { value: '', label: 'Select a configured schema...' },
                ...Object.entries(configuredSchemas).map(([key, s]) => ({
                  value: key,
                  label: `${key} (${getVariableDisplayValue(s.catalog_name)}.${getVariableDisplayValue(s.schema_name)})`,
                })),
              ]}
              hint="Reference a schema defined in the Schemas section"
            />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Catalog"
                value={formData.catalog_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, catalog_name: e.target.value, schema_name: '', name: '' })}
                options={[
                  { value: '', label: 'Select catalog...' },
                  ...(catalogs || []).map((c) => ({ value: c.name, label: c.name })),
                ]}
              />
              <Select
                label="Schema"
                value={formData.schema_name}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const schemaName = e.target.value;
                  // Generate default refName based on schema (for "all functions" case)
                  const refName = schemaName ? generateRefName(`${formData.catalog_name}_${schemaName}_functions`) : '';
                  setFormData({ 
                    ...formData, 
                    schema_name: schemaName, 
                    name: '',
                    refName: formData.refName || refName,
                  });
                }}
                options={[
                  { value: '', label: schemasLoading ? 'Loading schemas...' : 'Select schema...' },
                  ...(schemas || []).map((s) => ({ value: s.name, label: s.name })),
                ]}
                disabled={!formData.catalog_name || schemasLoading}
              />
            </div>
          )}
          
          {/* Show selected schema info when using reference */}
          {schemaSource === 'reference' && formData.schemaRef && configuredSchemas[formData.schemaRef] && (
            <div className="p-2 bg-slate-900/50 rounded text-xs text-slate-400">
              Using schema: <span className="text-slate-300">{getVariableDisplayValue(configuredSchemas[formData.schemaRef].catalog_name)}.{getVariableDisplayValue(configuredSchemas[formData.schemaRef].schema_name)}</span>
            </div>
          )}
          
          <Select
            label="Function"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const funcName = e.target.value;
              // Use functional update to ensure we have the latest state
              setFormData(prev => {
                // Generate refName based on function name or schema if "all functions"
                let newRefName = '';
                if (funcName) {
                  newRefName = generateRefName(funcName);
                } else if (schemaSource === 'reference' && prev.schemaRef) {
                  const schema = configuredSchemas[prev.schemaRef];
                  if (schema) {
                    newRefName = generateRefName(`${schema.catalog_name}_${schema.schema_name}_functions`);
                  }
                } else if (prev.catalog_name && prev.schema_name) {
                  newRefName = generateRefName(`${prev.catalog_name}_${prev.schema_name}_functions`);
                }
                
                // Only preserve refName if editing existing entry
                const shouldPreserveRefName = editingKey && prev.refName;
                
                return { 
                  ...prev, 
                  name: funcName,
                  refName: shouldPreserveRefName ? prev.refName : newRefName,
                };
              });
            }}
            options={[
              { value: '', label: functionsLoading ? 'Loading functions...' : 'All functions (*)' },
              ...availableFunctions.map((f) => ({ value: f.name, label: f.name })),
            ]}
            disabled={!isSchemaSelected || functionsLoading}
            hint="Leave empty for all functions in schema"
          />
          
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.on_behalf_of_user}
              onChange={(e) => setFormData({ ...formData, on_behalf_of_user: e.target.checked })}
              className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
            />
            <UserCheck className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-slate-300">On Behalf of User</span>
          </label>
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!formData.refName || !isSchemaSelected || isRefNameDuplicate(formData.refName, config, editingKey)}>
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Connections Panel
// =============================================================================
function ConnectionsPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addConnection, updateConnection, removeConnection } = useConfigStore();
  const connections = config.resources?.connections || {};
  const servicePrincipals = config.service_principals || {};
  const { data: ucConnections, loading } = useUCConnections();
  
  const [formData, setFormData] = useState({
    refName: '',
    name: '',
    on_behalf_of_user: false,
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const conn = connections[key];
    
    // Parse authentication data
    const authData = parseResourceAuth(conn, safeStartsWith, safeString, servicePrincipals);
    
    setFormData({
      refName: key,
      name: conn.name,
      ...authData,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    const connection: ConnectionModel = {
      name: formData.name,
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    // Apply authentication configuration
    applyResourceAuth(connection, formData as any);
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeConnection(editingKey);
        addConnection(formData.refName, connection);
      } else {
        updateConnection(formData.refName, connection);
      }
    } else {
      addConnection(formData.refName, connection);
    }
    
    setFormData({ 
      refName: '', 
      name: '', 
      on_behalf_of_user: false,
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    onClose();
  };

  const handleDelete = (key: string) => {
    safeDelete('Connection', key, () => removeConnection(key));
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Link className="w-5 h-5 text-indigo-400" />
          <h3 className="text-lg font-semibold text-slate-100">Connections</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setFormData({ refName: '', name: '', on_behalf_of_user: false, authMethod: 'default', servicePrincipalRef: '', clientIdSource: 'variable', clientSecretSource: 'variable', workspaceHostSource: 'variable', patSource: 'variable', client_id: '', client_secret: '', workspace_host: '', pat: '', clientIdVariable: '', clientSecretVariable: '', workspaceHostVariable: '', patVariable: '' }); setEditingKey(null); setShowForm(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Connection
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(connections).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(connections).map(([key, conn]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <Link className="w-4 h-4 text-indigo-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    UC Connection: {conn.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {conn.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(connections).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No connections configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Connection</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="External API"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          <Select
            label="Unity Catalog Connection"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              setFormData({ 
                ...formData, 
                name: e.target.value,
                refName: formData.refName || generateRefName(e.target.value),
              });
            }}
            options={[
              { value: '', label: loading ? 'Loading connections...' : 'Select a connection...' },
              ...(ucConnections || []).map((c) => ({
                value: c.name,
                label: `${c.name}${c.connection_type ? ` (${c.connection_type})` : ''}`,
              })),
            ]}
            hint="Select from available Unity Catalog connections"
            required
          />
          
          {/* Authentication Section */}
          <ResourceAuthSection
            formData={formData as any}
            setFormData={(data) => setFormData({ ...formData, ...data })}
            servicePrincipals={config.service_principals || {}}
            variables={config.variables || {}}
            variableNames={Object.keys(config.variables || {})}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!formData.refName || !formData.name || isRefNameDuplicate(formData.refName, config, editingKey)}>
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Databases Panel (Lakebase/PostgreSQL)
// =============================================================================
type CredentialSource = 'manual' | 'variable';

interface DatabaseFormData {
  refName: string;
  name: string;
  type: 'postgres' | 'lakebase';
  instanceSource: 'existing' | 'manual';
  instance_name: string;
  hostSource: CredentialSource;  // PostgreSQL hostname source
  host: string;  // PostgreSQL hostname (manual)
  hostVariable: string;  // PostgreSQL hostname (variable)
  description: string;
  capacity: 'CU_1' | 'CU_2';
  max_pool_size: number;
  timeout_seconds: number;
  authMethod: 'oauth' | 'user' | 'service_principal';
  servicePrincipalRef: string;  // Reference to configured service principal
  clientIdSource: CredentialSource;
  clientSecretSource: CredentialSource;
  workspaceHostSource: CredentialSource;
  client_id: string;
  client_secret: string;
  workspace_host: string;
  clientIdVariable: string;
  clientSecretVariable: string;
  workspaceHostVariable: string;
  userSource: CredentialSource;
  passwordSource: CredentialSource;
  user: string;
  password: string;
  userVariable: string;
  passwordVariable: string;
  on_behalf_of_user: boolean;
}

const defaultDatabaseForm: DatabaseFormData = {
  refName: '',
  name: '',
  type: 'lakebase',
  instanceSource: 'existing',
  instance_name: '',
  hostSource: 'manual',
  host: '',
  hostVariable: '',
  description: '',
  capacity: 'CU_2',
  max_pool_size: 10,
  timeout_seconds: 10,
  authMethod: 'service_principal',
  servicePrincipalRef: '',
  clientIdSource: 'variable',
  clientSecretSource: 'variable',
  workspaceHostSource: 'variable',
  client_id: '',
  client_secret: '',
  workspace_host: '',
  clientIdVariable: '',
  clientSecretVariable: '',
  workspaceHostVariable: '',
  userSource: 'manual',
  passwordSource: 'variable',
  user: '',
  password: '',
  userVariable: '',
  passwordVariable: '',
  on_behalf_of_user: false,
};

const databaseTypeOptions = [
  { value: 'lakebase', label: 'Lakebase (Databricks-managed PostgreSQL)' },
  { value: 'postgres', label: 'PostgreSQL (External)' },
];

const authMethodOptions = [
  { value: 'service_principal', label: 'Configured Service Principal' },
  { value: 'oauth', label: 'Manual OAuth2 Credentials' },
  { value: 'user', label: 'User/Password' },
];

// Helper to format variable reference for YAML
const formatVariableRef = (variableName: string): string => {
  return `*${variableName}`;
};

// Helper to get display name for variable
const getVariableDisplayName = (variable: VariableModel): string => {
  if ('env' in variable) return `env: ${variable.env}`;
  if ('scope' in variable && 'secret' in variable) return `secret: ${variable.scope}/${variable.secret}`;
  if ('value' in variable) return `value: ${String(variable.value)}`;
  if ('options' in variable) return `composite (${variable.options.length} options)`;
  return 'unknown';
};

// Credential input component with variable selection - defined outside to prevent re-creation on render
interface CredentialInputProps {
  label: string;
  source: CredentialSource;
  onSourceChange: (source: CredentialSource) => void;
  manualValue: string;
  onManualChange: (value: string) => void;
  variableValue: string;
  onVariableChange: (value: string) => void;
  placeholder?: string;
  isPassword?: boolean;
  hint?: string;
  variableNames: string[];
  variables: Record<string, VariableModel>;
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
  isPassword = false,
  hint,
  variableNames,
  variables,
}: CredentialInputProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-slate-300">{label}</label>
        <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
          <button
            type="button"
            onClick={() => onSourceChange('variable')}
            className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 flex items-center gap-1 ${
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
              label: `${name} (${getVariableDisplayName(variables[name] as VariableModel)})`,
            })),
          ]}
          hint={variableNames.length === 0 ? 'Define variables in the Variables section first' : hint}
        />
      ) : (
        <Input
          value={manualValue}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onManualChange(e.target.value)}
          placeholder={placeholder}
          type={isPassword ? 'password' : 'text'}
          hint={hint}
        />
      )}
    </div>
  );
}

function DatabasesPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addDatabase, updateDatabase, removeDatabase } = useConfigStore();
  const databases = config.resources?.databases || {};
  const variables = config.variables || {};
  const variableNames = Object.keys(variables);
  
  const { data: lakebaseInstances, loading: loadingInstances, refetch: refetchInstances } = useDatabases();

  // Status mapper for Lakebase instances (same pattern as SQL warehouses)
  const getDatabaseStatus = (state: string | undefined): StatusType => {
    switch (state?.toUpperCase()) {
      case 'AVAILABLE':
      case 'RUNNING':
        return 'ready';
      case 'CREATING':
      case 'STARTING':
      case 'STOPPING':
      case 'PROVISIONING':
      case 'UPDATING':
        return 'transitioning';
      case 'STOPPED':
      case 'FAILED':
      case 'DELETED':
      case 'DELETING':
        return 'stopped';
      default:
        return 'unknown';
    }
  };

  const databaseOptions: StatusSelectOption[] = [
    { value: '', label: loadingInstances ? 'Loading...' : 'Select an instance...' },
    ...(lakebaseInstances || []).map((inst) => ({
      value: inst.name,
      label: inst.name,
      status: getDatabaseStatus(inst.state),
    })),
  ];
  
  const [formData, setFormData] = useState<DatabaseFormData>(defaultDatabaseForm);

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const db = databases[key];
    if (db) {
      const isVariableRef = (val?: unknown): boolean => safeStartsWith(val, '*');
      const getVarSlice = (val?: unknown): string => {
        const str = safeString(val);
        return str.startsWith('*') ? str.slice(1) : '';
      };
      
      setFormData({
        refName: key,
        name: db.name || db.instance_name || '',  // name is optional, falls back to instance_name for Lakebase
        // Infer type from instance_name (Lakebase) or host (PostgreSQL)
        type: db._uiType || (db.instance_name ? 'lakebase' : 'postgres'),
        instanceSource: 'existing',
        instance_name: db.instance_name || '',
        hostSource: isVariableRef(db.host) ? 'variable' : 'manual',
        host: isVariableRef(db.host) ? '' : safeString(db.host),
        hostVariable: getVarSlice(db.host),
        description: db.description || '',
        capacity: db.capacity || 'CU_2',
        max_pool_size: db.max_pool_size || 10,
        timeout_seconds: db.timeout_seconds || 10,
        authMethod: db.service_principal ? 'service_principal' : (db.client_id ? 'oauth' : 'user'),
        servicePrincipalRef: safeStartsWith(db.service_principal, '*') ? safeString(db.service_principal).slice(1) : '',
        clientIdSource: isVariableRef(db.client_id) ? 'variable' : 'manual',
        clientSecretSource: isVariableRef(db.client_secret) ? 'variable' : 'manual',
        workspaceHostSource: isVariableRef(db.workspace_host) ? 'variable' : 'manual',
        client_id: isVariableRef(db.client_id) ? '' : safeString(db.client_id),
        client_secret: isVariableRef(db.client_secret) ? '' : safeString(db.client_secret),
        workspace_host: isVariableRef(db.workspace_host) ? '' : safeString(db.workspace_host),
        clientIdVariable: getVarSlice(db.client_id),
        clientSecretVariable: getVarSlice(db.client_secret),
        workspaceHostVariable: getVarSlice(db.workspace_host),
        userSource: isVariableRef(db.user) ? 'variable' : 'manual',
        passwordSource: isVariableRef(db.password) ? 'variable' : 'manual',
        user: isVariableRef(db.user) ? '' : safeString(db.user),
        password: isVariableRef(db.password) ? '' : safeString(db.password),
        userVariable: getVarSlice(db.user),
        passwordVariable: getVarSlice(db.password),
        on_behalf_of_user: db.on_behalf_of_user || false,
      });
      setEditingKey(key);
      setShowForm(true);
    }
  };

  const handleDelete = (key: string) => {
    safeDelete('Database', key, () => removeDatabase(key));
  };

  const getCredentialValue = (source: CredentialSource, manualValue: string, variableName: string): string => {
    if (source === 'variable' && variableName) {
      return formatVariableRef(variableName);
    }
    return manualValue;
  };

  const handleSave = () => {
    // NOTE: type field removed in dao-ai 0.1.2 - type is inferred from instance_name vs host
    // instance_name provided → Lakebase, host provided → PostgreSQL
    const db: DatabaseModel = {
      name: formData.name,
      // _uiType is for UI display only, not included in YAML output
      _uiType: formData.type,
      instance_name: formData.type === 'lakebase' ? (formData.instance_name || undefined) : undefined,
      host: formData.type === 'postgres' ? (getCredentialValue(formData.hostSource, formData.host, formData.hostVariable) || undefined) : undefined,
      description: formData.description || undefined,
      capacity: formData.capacity,
      max_pool_size: formData.max_pool_size,
      timeout_seconds: formData.timeout_seconds,
      // OBO only supported for Lakebase
      on_behalf_of_user: formData.type === 'lakebase' ? (formData.on_behalf_of_user || undefined) : undefined,
    };
    
    if (formData.authMethod === 'service_principal') {
      // Use configured service principal reference
      if (formData.servicePrincipalRef) {
        db.service_principal = `*${formData.servicePrincipalRef}`;
      }
    } else if (formData.authMethod === 'oauth') {
      const clientId = getCredentialValue(formData.clientIdSource, formData.client_id, formData.clientIdVariable);
      const clientSecret = getCredentialValue(formData.clientSecretSource, formData.client_secret, formData.clientSecretVariable);
      const workspaceHost = getCredentialValue(formData.workspaceHostSource, formData.workspace_host, formData.workspaceHostVariable);
      
      if (clientId) db.client_id = clientId;
      if (clientSecret) db.client_secret = clientSecret;
      if (workspaceHost) db.workspace_host = workspaceHost;
    } else {
      const user = getCredentialValue(formData.userSource, formData.user, formData.userVariable);
      const password = getCredentialValue(formData.passwordSource, formData.password, formData.passwordVariable);
      
      if (user) db.user = user;
      if (password) db.password = password;
    }
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeDatabase(editingKey);
        addDatabase(formData.refName, db);
      } else {
        updateDatabase(editingKey, db);
      }
    } else {
      addDatabase(formData.refName, db);
    }
    
    setShowForm(false);
    setEditingKey(null);
    setFormData(defaultDatabaseForm);
    onClose();
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Server className="w-5 h-5 text-emerald-400" />
          <h3 className="text-lg font-semibold text-slate-100">Databases (Lakebase/PostgreSQL)</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { setFormData(defaultDatabaseForm); setEditingKey(null); setShowForm(true); }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Database
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(databases).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(databases).map(([key, db]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <Server className="w-4 h-4 text-emerald-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {db.instance_name || db.name || 'Default instance'} • {db.capacity || 'CU_2'}
                    {db.client_id ? ' • OAuth' : db.user ? ' • User auth' : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {db.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(databases).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No databases configured. Add a database for PostgreSQL/Lakebase memory storage.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Database</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Retail Database"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Database Type Selection */}
          <Select
            label="Database Type"
            value={formData.type}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const newType = e.target.value as 'postgres' | 'lakebase';
              setFormData({ 
                ...formData, 
                type: newType,
                // Clear OBO when switching to PostgreSQL (not supported)
                on_behalf_of_user: newType === 'postgres' ? false : formData.on_behalf_of_user
              });
            }}
            options={databaseTypeOptions}
            hint={formData.type === 'lakebase' ? 'Databricks-managed Lakebase supports ambient/OBO authentication' : 'External PostgreSQL requires explicit credentials'}
          />
          
          {/* Lakebase Instance Selection - Only for Lakebase type */}
          {formData.type === 'lakebase' && (
            <div className="space-y-3 p-3 bg-slate-900/50 rounded border border-slate-600">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-300 font-medium flex items-center">
                  <CloudCog className="w-4 h-4 mr-2 text-emerald-400" />
                  Lakebase Instance
                </p>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, instanceSource: 'existing' })}
                    className={`px-2 py-1 text-xs rounded ${formData.instanceSource === 'existing' ? 'bg-emerald-500/30 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}
                  >
                    Use Existing
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, instanceSource: 'manual' })}
                    className={`px-2 py-1 text-xs rounded ${formData.instanceSource === 'manual' ? 'bg-emerald-500/30 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}
                  >
                    Manual
                  </button>
                </div>
              </div>
              
              {formData.instanceSource === 'existing' ? (
                <div className="flex items-center space-x-2">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Select Lakebase Instance</label>
                    <StatusSelect
                      value={formData.instance_name}
                      onChange={(value) => {
                        setFormData({ 
                          ...formData, 
                          instance_name: value,
                          name: value || formData.name,
                          refName: editingKey ? formData.refName : generateRefName(value),
                        });
                      }}
                      options={databaseOptions}
                      placeholder="Select an instance..."
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refetchInstances()}
                    disabled={loadingInstances}
                    className="mt-6"
                  >
                    {loadingInstances ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </Button>
                </div>
              ) : (
                <Input
                  label="Instance Name"
                  value={formData.instance_name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const instanceName = e.target.value;
                    setFormData({ 
                      ...formData, 
                      instance_name: instanceName,
                      name: instanceName || formData.name,
                      refName: editingKey ? formData.refName : generateRefName(instanceName),
                    });
                  }}
                  placeholder="my-lakebase-instance"
                  hint="Enter the Lakebase instance name directly"
                />
              )}
            </div>
          )}
          
          {/* PostgreSQL Host - Only for Postgres type */}
          {formData.type === 'postgres' && (
            <CredentialInput
              label="PostgreSQL Host"
              source={formData.hostSource}
              onSourceChange={(s) => setFormData({ ...formData, hostSource: s })}
              manualValue={formData.host}
              onManualChange={(v) => setFormData({ ...formData, host: v })}
              variableValue={formData.hostVariable}
              onVariableChange={(v) => setFormData({ ...formData, hostVariable: v })}
              placeholder="postgres.example.com:5432"
              hint="Hostname and port for your PostgreSQL server"
              variableNames={variableNames}
              variables={variables}
            />
          )}
          
          <Input
            label="Display Name"
            value={formData.name}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
            placeholder="Retail Database"
          />
          
          <Input
            label="Description"
            value={formData.description}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, description: e.target.value })}
            placeholder="Database for agent memory and checkpoints"
          />
          
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Max Pool Size"
              type="number"
              value={formData.max_pool_size}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, max_pool_size: parseInt(e.target.value) || 10 })}
            />
            <Input
              label="Timeout (seconds)"
              type="number"
              value={formData.timeout_seconds}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, timeout_seconds: parseInt(e.target.value) || 10 })}
            />
          </div>
          
          {formData.type === 'lakebase' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-300">Authentication Method</label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.on_behalf_of_user}
                    onChange={(e) => setFormData({ ...formData, on_behalf_of_user: e.target.checked })}
                    className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
                  />
                  <UserCheck className="w-4 h-4 text-blue-400" />
                  <span className="text-sm text-slate-300">On Behalf of User</span>
                </label>
              </div>
              <Select
                value={formData.authMethod}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, authMethod: e.target.value as 'oauth' | 'user' | 'service_principal' })}
                options={authMethodOptions}
                hint="Lakebase supports ambient/OBO authentication"
                disabled={formData.on_behalf_of_user}
              />
              {formData.on_behalf_of_user && (
                <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-blue-300 text-xs">
                  When enabled, the resource will use the calling user's credentials for authentication.
                  Other authentication options are disabled.
                </div>
              )}
            </div>
          ) : (
            <Select
              label="Authentication Method"
              value={formData.authMethod}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, authMethod: e.target.value as 'oauth' | 'user' | 'service_principal' })}
              options={authMethodOptions}
              hint="PostgreSQL requires explicit authentication"
            />
          )}
          
          {formData.type === 'postgres' && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <p className="text-xs text-amber-400">
                <strong>Note:</strong> PostgreSQL databases require explicit authentication (user/password or OAuth2 credentials).
              </p>
            </div>
          )}
          
          {!formData.on_behalf_of_user && formData.authMethod === 'service_principal' ? (
            <div className="space-y-4 p-3 bg-slate-900/50 rounded border border-slate-600">
              <p className="text-xs text-slate-400 font-medium">Select Configured Service Principal</p>
              
              <Select
                label="Service Principal"
                value={formData.servicePrincipalRef}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, servicePrincipalRef: e.target.value })}
                options={[
                  { value: '', label: 'Select a service principal...' },
                  ...Object.keys(config.service_principals || {}).map((sp) => ({
                    value: sp,
                    label: sp,
                  })),
                ]}
                hint="Reference a pre-configured service principal"
              />
              
              {Object.keys(config.service_principals || {}).length === 0 && (
                <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-xs">
                  No service principals configured. Add one in the Service Principals tab first.
                </div>
              )}
            </div>
          ) : !formData.on_behalf_of_user && formData.authMethod === 'oauth' ? (
            <div className="space-y-4 p-3 bg-slate-900/50 rounded border border-slate-600">
              <p className="text-xs text-slate-400 font-medium">OAuth2 / Service Principal Credentials</p>
              
              <CredentialInput
                label="Client ID"
                source={formData.clientIdSource}
                onSourceChange={(s) => setFormData({ ...formData, clientIdSource: s })}
                manualValue={formData.client_id}
                onManualChange={(v) => setFormData({ ...formData, client_id: v })}
                variableValue={formData.clientIdVariable}
                onVariableChange={(v) => setFormData({ ...formData, clientIdVariable: v })}
                placeholder="your-service-principal-client-id"
                variableNames={variableNames}
                variables={variables}
              />
              
              <CredentialInput
                label="Client Secret"
                source={formData.clientSecretSource}
                onSourceChange={(s) => setFormData({ ...formData, clientSecretSource: s })}
                manualValue={formData.client_secret}
                onManualChange={(v) => setFormData({ ...formData, client_secret: v })}
                variableValue={formData.clientSecretVariable}
                onVariableChange={(v) => setFormData({ ...formData, clientSecretVariable: v })}
                placeholder="your-client-secret"
                isPassword
                variableNames={variableNames}
                variables={variables}
              />
              
              <CredentialInput
                label="Workspace Host (Optional)"
                source={formData.workspaceHostSource}
                onSourceChange={(s) => setFormData({ ...formData, workspaceHostSource: s })}
                manualValue={formData.workspace_host}
                onManualChange={(v) => setFormData({ ...formData, workspace_host: v })}
                variableValue={formData.workspaceHostVariable}
                onVariableChange={(v) => setFormData({ ...formData, workspaceHostVariable: v })}
                placeholder="https://your-workspace.cloud.databricks.com"
                hint="Only required if connecting from outside the workspace"
                variableNames={variableNames}
                variables={variables}
              />
            </div>
          ) : !formData.on_behalf_of_user && formData.authMethod === 'user' ? (
            <div className="space-y-4 p-3 bg-slate-900/50 rounded border border-slate-600">
              <p className="text-xs text-slate-400 font-medium">User/Password Credentials</p>
              
              <CredentialInput
                label="Username"
                source={formData.userSource}
                onSourceChange={(s) => setFormData({ ...formData, userSource: s })}
                manualValue={formData.user}
                onManualChange={(v) => setFormData({ ...formData, user: v })}
                variableValue={formData.userVariable}
                onVariableChange={(v) => setFormData({ ...formData, userVariable: v })}
                placeholder="postgres"
                variableNames={variableNames}
                variables={variables}
              />
              
              <CredentialInput
                label="Password"
                source={formData.passwordSource}
                onSourceChange={(s) => setFormData({ ...formData, passwordSource: s })}
                manualValue={formData.password}
                onManualChange={(v) => setFormData({ ...formData, password: v })}
                variableValue={formData.passwordVariable}
                onVariableChange={(v) => setFormData({ ...formData, passwordVariable: v })}
                placeholder="your-password"
                isPassword
                variableNames={variableNames}
                variables={variables}
              />
            </div>
          ) : null}
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={
                !formData.refName || 
                !formData.name || 
                (formData.type === 'lakebase' && !formData.instance_name) ||
                (formData.type === 'postgres' && formData.hostSource === 'manual' && !formData.host) ||
                (formData.type === 'postgres' && formData.hostSource === 'variable' && !formData.hostVariable) ||
                isRefNameDuplicate(formData.refName, config, editingKey)
              }
            >
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Vector Stores Panel
// =============================================================================
interface VectorStoreFormData {
  refName: string;
  // Configuration mode: 'use_existing' (just reference an existing index) or 'provision' (create new from source table)
  configMode: 'use_existing' | 'provision';
  // Endpoint (optional - auto-detected if not specified)
  endpointSource: 'select' | 'manual';
  endpoint_name: string;
  endpoint_type: 'STANDARD' | 'OPTIMIZED_STORAGE';
  // Index - schema source (uses SchemaSource type defined earlier)
  // Required for 'use_existing' mode, optional (auto-generated from source_table) for 'provision' mode
  indexSchemaSource: SchemaSource;
  indexSchemaRefName: string;
  index_catalog: string;
  index_schema: string;
  indexNameSource: 'select' | 'manual';
  index_name: string;
  // Source Table - schema source (required for 'provision' mode only)
  sourceSchemaSource: SchemaSource;
  sourceSchemaRefName: string;
  source_catalog: string;
  source_schema: string;
  source_table: string;
  // Fields
  primary_key: string;  // Optional - auto-detected from table
  embedding_source_column: string;  // Required for 'provision' mode only
  columns: string[];  // Optional
  doc_uri: string;  // Optional
  // Embedding model (optional - defaults to databricks-gte-large-en)
  embedding_model: string;
  // Optional volume paths (VolumePathModel)
  // Source path - schema source (similar to table/function schema selection)
  sourcePathEnabled: boolean;
  sourcePathSchemaSource: SchemaSource;  // 'reference' or 'direct'
  sourcePathSchemaRef: string;  // Reference to configured schema
  sourcePathVolumeCatalog: string;  // For direct schema selection
  sourcePathVolumeSchema: string;  // For direct schema selection
  sourcePathVolumeName: string;  // Volume name within the selected schema
  sourcePathPath: string;  // Path within the volume
  // Checkpoint path - schema source (similar to table/function schema selection)
  checkpointPathEnabled: boolean;
  checkpointPathSchemaSource: SchemaSource;  // 'reference' or 'direct'
  checkpointPathSchemaRef: string;  // Reference to configured schema
  checkpointPathVolumeCatalog: string;  // For direct schema selection
  checkpointPathVolumeSchema: string;  // For direct schema selection
  checkpointPathVolumeName: string;  // Volume name within the selected schema
  checkpointPathPath: string;  // Path within the volume
  on_behalf_of_user: boolean;
  // Authentication fields
  authMethod: 'default' | 'service_principal' | 'oauth' | 'pat';
  servicePrincipalRef: string;
  clientIdSource: 'variable' | 'manual';
  clientSecretSource: 'variable' | 'manual';
  workspaceHostSource: 'variable' | 'manual';
  patSource: 'variable' | 'manual';
  client_id: string;
  client_secret: string;
  workspace_host: string;
  pat: string;
  clientIdVariable: string;
  clientSecretVariable: string;
  workspaceHostVariable: string;
  patVariable: string;
}

const defaultVectorStoreForm: VectorStoreFormData = {
  refName: '',
  configMode: 'use_existing',  // Default to simpler mode
  endpointSource: 'select',  // Default to selecting from list
  endpoint_name: '',
  endpoint_type: 'STANDARD',
  indexSchemaSource: 'direct',
  indexSchemaRefName: '',
  index_catalog: '',
  index_schema: '',
  indexNameSource: 'select',
  index_name: '',
  sourceSchemaSource: 'direct',
  sourceSchemaRefName: '',
  source_catalog: '',
  source_schema: '',
  source_table: '',
  primary_key: '',
  embedding_source_column: '',
  columns: [],
  doc_uri: '',
  embedding_model: 'databricks-gte-large-en',
  sourcePathEnabled: false,
  sourcePathSchemaSource: 'direct',
  sourcePathSchemaRef: '',
  sourcePathVolumeCatalog: '',
  sourcePathVolumeSchema: '',
  sourcePathVolumeName: '',
  sourcePathPath: '',
  checkpointPathEnabled: false,
  checkpointPathSchemaSource: 'direct',
  checkpointPathSchemaRef: '',
  checkpointPathVolumeCatalog: '',
  checkpointPathVolumeSchema: '',
  checkpointPathVolumeName: '',
  checkpointPathPath: '',
  on_behalf_of_user: false,
  // Authentication fields
  authMethod: 'default',
  servicePrincipalRef: '',
  clientIdSource: 'variable',
  clientSecretSource: 'variable',
  workspaceHostSource: 'variable',
  patSource: 'variable',
  client_id: '',
  client_secret: '',
  workspace_host: '',
  pat: '',
  clientIdVariable: '',
  clientSecretVariable: '',
  workspaceHostVariable: '',
  patVariable: '',
};

// Volume Paths Section Component
interface VolumePathsSectionProps {
  formData: VectorStoreFormData;
  setFormData: React.Dispatch<React.SetStateAction<VectorStoreFormData>>;
  configuredSchemas: Record<string, SchemaModel>;
  configuredSchemaOptions: { value: string; label: string }[];
  catalogs: { name: string }[] | null;
  sourcePathSchemas: { name: string }[] | null;
  sourcePathVolumes: { name: string }[] | null;
  sourcePathVolumesLoading: boolean;
  checkpointPathSchemas: { name: string }[] | null;
  checkpointPathVolumes: { name: string }[] | null;
  checkpointPathVolumesLoading: boolean;
}

function VolumePathsSection({
  formData,
  setFormData,
  configuredSchemas,
  configuredSchemaOptions,
  catalogs,
  sourcePathSchemas,
  sourcePathVolumes,
  sourcePathVolumesLoading,
  checkpointPathSchemas,
  checkpointPathVolumes,
  checkpointPathVolumesLoading,
}: VolumePathsSectionProps) {
  const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
  
  return (
    <div className="space-y-4 p-3 bg-slate-900/50 rounded border border-slate-600">
      <p className="text-sm text-slate-300 font-medium">Volume Paths <span className="text-slate-500 font-normal">(Optional)</span></p>
      
      {/* Source Path */}
      <div className="space-y-3 p-3 bg-slate-800/30 rounded border border-slate-700">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-300">Source Path</label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.sourcePathEnabled}
              onChange={(e) => setFormData(prev => ({ 
                ...prev, 
                sourcePathEnabled: e.target.checked,
                sourcePathSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
              }))}
              className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-xs text-slate-400">Enable</span>
          </label>
        </div>
        
        {formData.sourcePathEnabled && (
          <>
            {/* Schema Source Toggle */}
            <div className="flex items-center justify-between">
              <label className="text-xs text-slate-400">Schema</label>
              <div className="flex items-center space-x-2">
                {hasConfiguredSchemas && (
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ 
                      ...prev, 
                      sourcePathSchemaSource: 'reference',
                      sourcePathVolumeCatalog: '',
                      sourcePathVolumeSchema: '',
                      sourcePathVolumeName: '',
                    }))}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.sourcePathSchemaSource === 'reference' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Configured
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ 
                    ...prev, 
                    sourcePathSchemaSource: 'direct',
                    sourcePathSchemaRef: '',
                    sourcePathVolumeName: '',
                  }))}
                  className={`px-2 py-1 text-xs rounded ${
                    formData.sourcePathSchemaSource === 'direct' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
            
            {/* Schema Selection */}
            {formData.sourcePathSchemaSource === 'reference' ? (
              <Select
                value={formData.sourcePathSchemaRef}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const schemaRef = e.target.value;
                  const schema = configuredSchemas[schemaRef];
                  setFormData(prev => ({ 
                    ...prev, 
                    sourcePathSchemaRef: schemaRef,
                    sourcePathVolumeCatalog: getVariableDisplayValue(schema?.catalog_name),
                    sourcePathVolumeSchema: getVariableDisplayValue(schema?.schema_name),
                    sourcePathVolumeName: '',
                  }));
                }}
                options={[
                  { value: '', label: 'Select configured schema...' },
                  ...configuredSchemaOptions,
                ]}
                hint="Select a previously configured schema"
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={formData.sourcePathVolumeCatalog}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ 
                    ...prev, 
                    sourcePathVolumeCatalog: e.target.value,
                    sourcePathVolumeSchema: '',
                    sourcePathVolumeName: '',
                  }))}
                  options={[
                    { value: '', label: 'Catalog...' },
                    ...(catalogs || []).map(c => ({ value: c.name, label: c.name })),
                  ]}
                />
                <Select
                  value={formData.sourcePathVolumeSchema}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ 
                    ...prev, 
                    sourcePathVolumeSchema: e.target.value,
                    sourcePathVolumeName: '',
                  }))}
                  options={[
                    { value: '', label: 'Schema...' },
                    ...(sourcePathSchemas || []).map(s => ({ value: s.name, label: s.name })),
                  ]}
                  disabled={!formData.sourcePathVolumeCatalog}
                />
              </div>
            )}
            
            {/* Volume Selection */}
            <Select
              label="Volume"
              value={formData.sourcePathVolumeName}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ ...prev, sourcePathVolumeName: e.target.value }))}
              options={[
                { value: '', label: sourcePathVolumesLoading ? 'Loading volumes...' : 'Select volume...' },
                ...(sourcePathVolumes || []).map(v => ({ value: v.name, label: v.name })),
              ]}
              disabled={!formData.sourcePathVolumeSchema || sourcePathVolumesLoading}
              hint="Select a volume from the schema"
            />
            
            {/* Path Input */}
            <Input
              label="Path"
              value={formData.sourcePathPath}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData(prev => ({ ...prev, sourcePathPath: e.target.value }))}
              placeholder="/path/to/source/data"
              hint="Path within the volume for source data files"
            />
          </>
        )}
      </div>
      
      {/* Checkpoint Path */}
      <div className="space-y-3 p-3 bg-slate-800/30 rounded border border-slate-700">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-300">Checkpoint Path</label>
          <label className="flex items-center space-x-2 cursor-pointer">
            <input
              type="checkbox"
              checked={formData.checkpointPathEnabled}
              onChange={(e) => setFormData(prev => ({ 
                ...prev, 
                checkpointPathEnabled: e.target.checked,
                checkpointPathSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
              }))}
              className="rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-xs text-slate-400">Enable</span>
          </label>
        </div>
        
        {formData.checkpointPathEnabled && (
          <>
            {/* Schema Source Toggle */}
            <div className="flex items-center justify-between">
              <label className="text-xs text-slate-400">Schema</label>
              <div className="flex items-center space-x-2">
                {hasConfiguredSchemas && (
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ 
                      ...prev, 
                      checkpointPathSchemaSource: 'reference',
                      checkpointPathVolumeCatalog: '',
                      checkpointPathVolumeSchema: '',
                      checkpointPathVolumeName: '',
                    }))}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.checkpointPathSchemaSource === 'reference' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Configured
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setFormData(prev => ({ 
                    ...prev, 
                    checkpointPathSchemaSource: 'direct',
                    checkpointPathSchemaRef: '',
                    checkpointPathVolumeName: '',
                  }))}
                  className={`px-2 py-1 text-xs rounded ${
                    formData.checkpointPathSchemaSource === 'direct' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  Select
                </button>
              </div>
            </div>
            
            {/* Schema Selection */}
            {formData.checkpointPathSchemaSource === 'reference' ? (
              <Select
                value={formData.checkpointPathSchemaRef}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const schemaRef = e.target.value;
                  const schema = configuredSchemas[schemaRef];
                  setFormData(prev => ({ 
                    ...prev, 
                    checkpointPathSchemaRef: schemaRef,
                    checkpointPathVolumeCatalog: getVariableDisplayValue(schema?.catalog_name),
                    checkpointPathVolumeSchema: getVariableDisplayValue(schema?.schema_name),
                    checkpointPathVolumeName: '',
                  }));
                }}
                options={[
                  { value: '', label: 'Select configured schema...' },
                  ...configuredSchemaOptions,
                ]}
                hint="Select a previously configured schema"
              />
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={formData.checkpointPathVolumeCatalog}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ 
                    ...prev, 
                    checkpointPathVolumeCatalog: e.target.value,
                    checkpointPathVolumeSchema: '',
                    checkpointPathVolumeName: '',
                  }))}
                  options={[
                    { value: '', label: 'Catalog...' },
                    ...(catalogs || []).map(c => ({ value: c.name, label: c.name })),
                  ]}
                />
                <Select
                  value={formData.checkpointPathVolumeSchema}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ 
                    ...prev, 
                    checkpointPathVolumeSchema: e.target.value,
                    checkpointPathVolumeName: '',
                  }))}
                  options={[
                    { value: '', label: 'Schema...' },
                    ...(checkpointPathSchemas || []).map(s => ({ value: s.name, label: s.name })),
                  ]}
                  disabled={!formData.checkpointPathVolumeCatalog}
                />
              </div>
            )}
            
            {/* Volume Selection */}
            <Select
              label="Volume"
              value={formData.checkpointPathVolumeName}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData(prev => ({ ...prev, checkpointPathVolumeName: e.target.value }))}
              options={[
                { value: '', label: checkpointPathVolumesLoading ? 'Loading volumes...' : 'Select volume...' },
                ...(checkpointPathVolumes || []).map(v => ({ value: v.name, label: v.name })),
              ]}
              disabled={!formData.checkpointPathVolumeSchema || checkpointPathVolumesLoading}
              hint="Select a volume from the schema"
            />
            
            {/* Path Input */}
            <Input
              label="Path"
              value={formData.checkpointPathPath}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData(prev => ({ ...prev, checkpointPathPath: e.target.value }))}
              placeholder="/path/to/checkpoints"
              hint="Path within the volume for vector index checkpoints"
            />
          </>
        )}
      </div>
    </div>
  );
}

function VectorStoresPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addVectorStore, updateVectorStore, removeVectorStore } = useConfigStore();
  const vectorStores = config.resources?.vector_stores || {};
  const configuredLLMs = config.resources?.llms || {};
  const configuredSchemas = config.schemas || {};
  const configuredVolumes = config.resources?.volumes || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};
  
  // Fetch data from Databricks
  const { data: vsEndpoints, loading: endpointsLoading, refetch: refetchEndpoints } = useVectorSearchEndpoints();
  const { data: catalogs } = useCatalogs();
  
  const [formData, setFormData] = useState<VectorStoreFormData>(defaultVectorStoreForm);
  const [columnsInput, setColumnsInput] = useState('');
  
  
  // Schema selection for index and source table
  const { data: indexSchemas } = useSchemas(formData.index_catalog || null);
  const { data: sourceSchemas } = useSchemas(formData.source_catalog || null);
  const { data: sourceTables, loading: tablesLoading } = useTables(
    formData.source_catalog || null,
    formData.source_schema || null
  );
  
  // Tables for index schema (used for index name selection)
  const { data: indexTables, loading: indexTablesLoading } = useTables(
    formData.index_catalog || null,
    formData.index_schema || null
  );
  
  // Fetch table columns when a source table is selected
  const { data: tableColumns, loading: columnsLoading, refetch: refetchColumns } = useTableColumns(
    formData.source_catalog || null,
    formData.source_schema || null,
    formData.source_table || null
  );
  
  // Build column options from table columns
  const columnOptions = (tableColumns || []).map(col => ({
    value: col.name,
    label: `${col.name}${col.type_text ? ` (${col.type_text})` : ''}`,
  }));
  
  // Auto-select all columns when table columns are loaded
  useEffect(() => {
    // Only auto-select if we have columns loaded and no columns are currently selected
    if (tableColumns && tableColumns.length > 0 && !columnsInput) {
      const allColumnNames = tableColumns.map(col => col.name).join(', ');
      setColumnsInput(allColumnNames);
    }
  }, [tableColumns]);
  
  // Track if we've already done the initial endpoint source detection
  const [initialEndpointSourceSet, setInitialEndpointSourceSet] = useState(false);
  
  // Update endpointSource when vsEndpoints first loads (for imports where endpoints might load after form data is set)
  // Only run once per edit session to avoid overriding user's manual selection
  useEffect(() => {
    if (vsEndpoints && formData.endpoint_name && !initialEndpointSourceSet && editingKey) {
      // Check if the endpoint exists in the loaded list
      const endpointExists = vsEndpoints.some(ep => ep.name === formData.endpoint_name);
      if (endpointExists && formData.endpointSource === 'manual') {
        setFormData(prev => ({ ...prev, endpointSource: 'select' }));
      }
      setInitialEndpointSourceSet(true);
    }
  }, [vsEndpoints, formData.endpoint_name, initialEndpointSourceSet, editingKey]);
  
  // Reset the flag when starting a new edit or closing the form
  useEffect(() => {
    if (!showForm) {
      setInitialEndpointSourceSet(false);
    }
  }, [showForm]);
  
  // Vector search indexes for selected endpoint (used in "Create New" mode) - currently unused but may be useful for future enhancements
  const _vsIndexesResult = useVectorSearchIndexes(formData.endpoint_name || null);
  void _vsIndexesResult; // Suppress unused warning
  
  // Volume path selection - schemas and volumes for source path
  const { data: sourcePathSchemas } = useSchemas(formData.sourcePathVolumeCatalog || null);
  const { data: sourcePathVolumes, loading: sourcePathVolumesLoading } = useVolumes(
    formData.sourcePathVolumeCatalog || null,
    formData.sourcePathVolumeSchema || null
  );
  
  // Volume path selection - schemas and volumes for checkpoint path
  const { data: checkpointPathSchemas } = useSchemas(formData.checkpointPathVolumeCatalog || null);
  const { data: checkpointPathVolumes, loading: checkpointPathVolumesLoading } = useVolumes(
    formData.checkpointPathVolumeCatalog || null,
    formData.checkpointPathVolumeSchema || null
  );

  // Build configured schema options
  const configuredSchemaOptions = Object.entries(configuredSchemas).map(([key, schema]) => ({
    value: key,
    label: `${key} (${schema.catalog_name}.${schema.schema_name})`,
  }));
  
  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const vs = vectorStores[key];
    if (vs) {
      // Check if the index schema matches a configured schema
      const indexSchemaRef = Object.entries(configuredSchemas).find(
        ([_, schema]) => 
          schema.catalog_name === vs.index?.schema?.catalog_name && 
          schema.schema_name === vs.index?.schema?.schema_name
      );
      // Check if the source table schema matches a configured schema
      const sourceSchemaRef = Object.entries(configuredSchemas).find(
        ([_, schema]) => 
          schema.catalog_name === vs.source_table?.schema?.catalog_name && 
          schema.schema_name === vs.source_table?.schema?.schema_name
      );
      
      // Parse source_path VolumePathModel
      const sourcePath = vs.source_path as any;
      let sourcePathEnabled = false;
      let sourcePathSchemaSource: SchemaSource = 'direct';
      let sourcePathSchemaRef = '';
      let sourcePathVolumeCatalog = '';
      let sourcePathVolumeSchema = '';
      let sourcePathVolumeName = '';
      let sourcePathPath = '';
      if (sourcePath?.volume) {
        sourcePathEnabled = true;
        sourcePathPath = sourcePath.path || '';
        // Get volume schema info
        let volumeCatalog = '';
        let volumeSchema = '';
        let volumeName = '';
        
        if (typeof sourcePath.volume === 'string') {
          // It's a reference - find the volume to get schema info
          const volStr = safeString(sourcePath.volume);
          const refName = volStr.startsWith('*') ? volStr.slice(1) : volStr;
          const referencedVolume = configuredVolumes[refName];
          if (referencedVolume) {
            volumeCatalog = getVariableDisplayValue(referencedVolume.schema?.catalog_name);
            volumeSchema = getVariableDisplayValue(referencedVolume.schema?.schema_name);
            volumeName = referencedVolume.name;
          }
        } else {
          volumeCatalog = getVariableDisplayValue(sourcePath.volume?.schema?.catalog_name);
          volumeSchema = getVariableDisplayValue(sourcePath.volume?.schema?.schema_name);
          volumeName = sourcePath.volume?.name || '';
        }
        
        // Check if the schema matches a configured schema
        const schemaRef = Object.entries(configuredSchemas).find(
          ([_, s]) => getVariableDisplayValue(s.catalog_name) === volumeCatalog && getVariableDisplayValue(s.schema_name) === volumeSchema
        );
        if (schemaRef) {
          sourcePathSchemaSource = 'reference';
          sourcePathSchemaRef = schemaRef[0];
        } else {
          sourcePathSchemaSource = 'direct';
        }
        sourcePathVolumeCatalog = volumeCatalog;
        sourcePathVolumeSchema = volumeSchema;
        sourcePathVolumeName = volumeName;
      }
      
      // Parse checkpoint_path VolumePathModel
      const checkpointPath = vs.checkpoint_path as any;
      let checkpointPathEnabled = false;
      let checkpointPathSchemaSource: SchemaSource = 'direct';
      let checkpointPathSchemaRef = '';
      let checkpointPathVolumeCatalog = '';
      let checkpointPathVolumeSchema = '';
      let checkpointPathVolumeName = '';
      let checkpointPathPath = '';
      if (checkpointPath?.volume) {
        checkpointPathEnabled = true;
        checkpointPathPath = checkpointPath.path || '';
        let volumeCatalog = '';
        let volumeSchema = '';
        let volumeName = '';
        
        if (typeof checkpointPath.volume === 'string') {
          const volStr = safeString(checkpointPath.volume);
          const refName = volStr.startsWith('*') ? volStr.slice(1) : volStr;
          const referencedVolume = configuredVolumes[refName];
          if (referencedVolume) {
            volumeCatalog = getVariableDisplayValue(referencedVolume.schema?.catalog_name);
            volumeSchema = getVariableDisplayValue(referencedVolume.schema?.schema_name);
            volumeName = referencedVolume.name;
          }
        } else {
          volumeCatalog = getVariableDisplayValue(checkpointPath.volume?.schema?.catalog_name);
          volumeSchema = getVariableDisplayValue(checkpointPath.volume?.schema?.schema_name);
          volumeName = checkpointPath.volume?.name || '';
        }
        
        const schemaRef = Object.entries(configuredSchemas).find(
          ([_, s]) => getVariableDisplayValue(s.catalog_name) === volumeCatalog && getVariableDisplayValue(s.schema_name) === volumeSchema
        );
        if (schemaRef) {
          checkpointPathSchemaSource = 'reference';
          checkpointPathSchemaRef = schemaRef[0];
        } else {
          checkpointPathSchemaSource = 'direct';
        }
        checkpointPathVolumeCatalog = volumeCatalog;
        checkpointPathVolumeSchema = volumeSchema;
        checkpointPathVolumeName = volumeName;
      }
      
      // Determine config mode based on presence of source_table
      // If source_table exists, it's provisioning mode; otherwise use_existing
      const configMode: 'use_existing' | 'provision' = vs.source_table ? 'provision' : 'use_existing';
      
      // Check if the endpoint exists in the available endpoints list
      const endpointName = vs.endpoint?.name || '';
      const endpointExistsInList = endpointName && vsEndpoints?.some(ep => ep.name === endpointName);
      
      setFormData({
        refName: key,
        configMode,
        endpointSource: endpointName && !endpointExistsInList ? 'manual' : 'select',
        endpoint_name: endpointName,
        endpoint_type: vs.endpoint?.type || 'STANDARD',
        indexSchemaSource: indexSchemaRef ? 'reference' : 'direct',
        indexSchemaRefName: indexSchemaRef ? indexSchemaRef[0] : '',
        index_catalog: getVariableDisplayValue(vs.index?.schema?.catalog_name),
        index_schema: getVariableDisplayValue(vs.index?.schema?.schema_name),
        indexNameSource: 'select', // Default to select, will switch to manual if needed
        index_name: vs.index?.name || '',
        sourceSchemaSource: sourceSchemaRef ? 'reference' : 'direct',
        sourceSchemaRefName: sourceSchemaRef ? sourceSchemaRef[0] : '',
        source_catalog: getVariableDisplayValue(vs.source_table?.schema?.catalog_name),
        source_schema: getVariableDisplayValue(vs.source_table?.schema?.schema_name),
        source_table: vs.source_table?.name || '',
        primary_key: vs.primary_key || '',
        embedding_source_column: vs.embedding_source_column || '',
        columns: vs.columns || [],
        doc_uri: vs.doc_uri || '',
        embedding_model: vs.embedding_model?.name || 'databricks-gte-large-en',
        sourcePathEnabled,
        sourcePathSchemaSource,
        sourcePathSchemaRef,
        sourcePathVolumeCatalog,
        sourcePathVolumeSchema,
        sourcePathVolumeName,
        sourcePathPath,
        checkpointPathEnabled,
        checkpointPathSchemaSource,
        checkpointPathSchemaRef,
        checkpointPathVolumeCatalog,
        checkpointPathVolumeSchema,
        checkpointPathVolumeName,
        checkpointPathPath,
        // Parse authentication data (includes on_behalf_of_user)
        ...parseResourceAuth(vs, safeStartsWith, safeString, servicePrincipals),
      });
      setColumnsInput((vs.columns || []).join(', '));
      setEditingKey(key);
      setShowForm(true);
    }
  };

  const handleDelete = (key: string) => {
    safeDelete('Vector Store', key, () => removeVectorStore(key));
  };

  const handleSave = () => {
    // Parse columns from input
    const columns = columnsInput.split(',').map(c => c.trim()).filter(c => c);
    
    // Initialize model with common fields
    const vs: VectorStoreModel = {
      on_behalf_of_user: formData.on_behalf_of_user || undefined,
    };
    
    // Apply authentication configuration
    applyResourceAuth(vs, formData as any);
    
    if (formData.configMode === 'use_existing') {
      // Use Existing Index mode - only index is required
      vs.index = {
        schema: {
          catalog_name: formData.index_catalog,
          schema_name: formData.index_schema,
        },
        name: formData.index_name,
      };
      // Optional fields for use_existing mode
      if (formData.primary_key) {
        vs.primary_key = formData.primary_key;
      }
      if (columns.length > 0) {
        vs.columns = columns;
      }
    } else {
      // Provision mode - source_table and embedding_source_column are required
      vs.embedding_source_column = formData.embedding_source_column;
      vs.primary_key = formData.primary_key || undefined;
      vs.columns = columns.length > 0 ? columns : undefined;
      vs.doc_uri = formData.doc_uri || undefined;
      
      // Source table is required for provisioning
      if (formData.source_table && formData.source_catalog && formData.source_schema) {
        vs.source_table = {
          schema: {
            catalog_name: formData.source_catalog,
            schema_name: formData.source_schema,
          },
          name: formData.source_table,
        };
      }
      
      // Add endpoint only if specified (optional - auto-detected if not provided)
      if (formData.endpoint_name) {
        vs.endpoint = {
          name: formData.endpoint_name,
          type: formData.endpoint_type,
        };
      }
      
      // Add index only if specified (optional - auto-generated from source_table if not provided)
      if (formData.index_name || formData.index_catalog || formData.index_schema) {
        vs.index = {
          schema: {
            catalog_name: formData.index_catalog || formData.source_catalog,
            schema_name: formData.index_schema || formData.source_schema,
          },
          name: formData.index_name || `${formData.source_table}_index`,
        };
      }
      
      // Add embedding model if specified
      if (formData.embedding_model) {
        vs.embedding_model = { name: formData.embedding_model };
      }
    
      // Add optional path fields as VolumePathModel (provision mode only)
      if (formData.sourcePathEnabled && formData.sourcePathVolumeName) {
        const sourcePathModel: any = {
          volume: {
            // If using a configured schema reference, include it for YAML generation
            ...(formData.sourcePathSchemaSource === 'reference' && formData.sourcePathSchemaRef
              ? { _schemaRef: formData.sourcePathSchemaRef }
              : { schema: {
                  catalog_name: formData.sourcePathVolumeCatalog,
                  schema_name: formData.sourcePathVolumeSchema,
                }
              }
            ),
            name: formData.sourcePathVolumeName,
          },
        };
        if (formData.sourcePathPath) {
          sourcePathModel.path = formData.sourcePathPath;
        }
        vs.source_path = sourcePathModel;
      }
      
      if (formData.checkpointPathEnabled && formData.checkpointPathVolumeName) {
        const checkpointPathModel: any = {
          volume: {
            // If using a configured schema reference, include it for YAML generation
            ...(formData.checkpointPathSchemaSource === 'reference' && formData.checkpointPathSchemaRef
              ? { _schemaRef: formData.checkpointPathSchemaRef }
              : { schema: {
                  catalog_name: formData.checkpointPathVolumeCatalog,
                  schema_name: formData.checkpointPathVolumeSchema,
                }
              }
            ),
            name: formData.checkpointPathVolumeName,
          },
        };
        if (formData.checkpointPathPath) {
          checkpointPathModel.path = formData.checkpointPathPath;
        }
        vs.checkpoint_path = checkpointPathModel;
      }
    }
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeVectorStore(editingKey);
        addVectorStore(formData.refName, vs);
      } else {
        updateVectorStore(editingKey, vs);
      }
    } else {
      addVectorStore(formData.refName, vs);
    }
    
    setShowForm(false);
    setEditingKey(null);
    setFormData(defaultVectorStoreForm);
    setColumnsInput('');
    onClose();
  };

  // Build endpoint options with status indicators
  const endpointOptions: StatusSelectOption[] = [
    { value: '', label: endpointsLoading ? 'Loading...' : 'Select an endpoint...' },
    ...(vsEndpoints || []).map((ep) => {
      const state = ep.endpoint_status?.state;
      let status: StatusType = 'unknown';
      if (state === 'ONLINE') status = 'ready';
      else if (state === 'PROVISIONING' || state === 'SCALING') status = 'transitioning';
      else if (state === 'OFFLINE' || state === 'FAILED') status = 'stopped';
      return {
        value: ep.name,
        label: ep.name,
        status,
      };
    }),
  ];

  // Build embedding model options (from configured LLMs or common embedding models)
  const embeddingModelOptions = [
    { value: '', label: 'Select embedding model...' },
    { value: 'databricks-gte-large-en', label: 'GTE Large (Embeddings)' },
    { value: 'databricks-bge-large-en', label: 'BGE Large (Embeddings)' },
    ...Object.entries(configuredLLMs).map(([key, llm]) => ({
      value: llm.name,
      label: `${key} (${llm.name})`,
    })),
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <Layers className="w-5 h-5 text-violet-400" />
          <h3 className="text-lg font-semibold text-slate-100">Vector Stores</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { 
          // Default to 'reference' mode if there are configured schemas
          const hasConfiguredSchemas = Object.keys(configuredSchemas).length > 0;
          setFormData({
            ...defaultVectorStoreForm,
            indexSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
            sourceSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
            sourcePathSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
            checkpointPathSchemaSource: hasConfiguredSchemas ? 'reference' : 'direct',
          }); 
          setColumnsInput(''); 
          setEditingKey(null); 
          setShowForm(true); 
        }}>
          <Plus className="w-4 h-4 mr-1" />
          Add Vector Store
        </Button>
      </div>

      {/* Existing Resources */}
      {Object.keys(vectorStores).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(vectorStores).map(([key, vs]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <Layers className="w-4 h-4 text-violet-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    {vs.endpoint?.name || 'No endpoint'} • {vs.index?.name || 'No index'}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {vs.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                {!vs.on_behalf_of_user && vs.service_principal && (
                  <Badge variant="info" title="Service Principal">
                    <Key className="w-3 h-3 mr-1" />
                    SP
                  </Badge>
                )}
                {!vs.on_behalf_of_user && (vs.client_id || vs.client_secret) && (
                  <Badge variant="warning" title="OAuth2 / M2M">
                    <Key className="w-3 h-3 mr-1" />
                    OAuth
                  </Badge>
                )}
                {!vs.on_behalf_of_user && vs.pat && (
                  <Badge variant="default" title="Personal Access Token">
                    <Key className="w-3 h-3 mr-1" />
                    PAT
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(vectorStores).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No vector stores configured. Add a vector store to enable semantic search.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Vector Store</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="Products Vector Store"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* Configuration Mode Toggle */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300">Configuration Mode</label>
              <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setFormData({ 
                    ...formData, 
                    configMode: 'use_existing',
                    // Don't clear fields - just switch mode, preserving values
                  })}
                  className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                    formData.configMode === 'use_existing'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Use Existing
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ 
                    ...formData, 
                    configMode: 'provision',
                    // Set default embedding model if not already set
                    embedding_model: formData.embedding_model || 'databricks-gte-large-en',
                  })}
                  className={`px-3 py-1 text-xs rounded-md font-medium transition-all duration-150 ${
                    formData.configMode === 'provision'
                      ? 'bg-violet-500/20 text-violet-400 border border-violet-500/40'
                      : 'text-slate-400 border border-transparent hover:text-slate-300'
                  }`}
                >
                  Provision New
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-500">
              {formData.configMode === 'use_existing' 
                ? 'Reference an existing vector search index'
                : 'Create a new index from a source table'
              }
            </p>
          </div>
          
          {/* Vector Search Endpoint (Optional - only for provision mode) */}
          {formData.configMode === 'provision' && (
          <div className="space-y-3 p-3 bg-slate-900/50 rounded border border-slate-600">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 font-medium">Vector Search Endpoint <span className="text-slate-500 font-normal">(Optional)</span></p>
                <p className="text-xs text-slate-500">Auto-detected if not specified</p>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, endpointSource: 'select' })}
                  className={`text-xs px-2 py-1 rounded ${formData.endpointSource === 'select' ? 'bg-blue-500/30 text-blue-300' : 'text-slate-400 hover:text-white'}`}
                >
                  Select
                </button>
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, endpointSource: 'manual' })}
                  className={`text-xs px-2 py-1 rounded ${formData.endpointSource === 'manual' ? 'bg-blue-500/30 text-blue-300' : 'text-slate-400 hover:text-white'}`}
                >
                  Manual
                </button>
                {formData.endpointSource === 'select' && (
                  <button
                    type="button"
                    onClick={() => refetchEndpoints()}
                    className="text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                    disabled={endpointsLoading}
                  >
                    <RefreshCw className={`w-3 h-3 ${endpointsLoading ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                )}
              </div>
            </div>
            
            {formData.endpointSource === 'select' ? (
              <StatusSelect
                options={endpointOptions}
                value={formData.endpoint_name}
                onChange={(value) => {
                  const selectedEndpoint = vsEndpoints?.find(ep => ep.name === value);
                  const detectedType = selectedEndpoint?.endpoint_type === 'OPTIMIZED_STORAGE' 
                    ? 'OPTIMIZED_STORAGE' 
                    : 'STANDARD';
                  
                  setFormData({ 
                    ...formData, 
                    endpoint_name: value,
                    endpoint_type: value ? detectedType : formData.endpoint_type,
                  });
                }}
                placeholder="Select an endpoint (or leave empty for auto-detection)..."
              />
            ) : (
              <Input
                label=""
                placeholder="Enter endpoint name..."
                value={formData.endpoint_name}
                onChange={(e) => setFormData({ ...formData, endpoint_name: e.target.value })}
              />
            )}
            
            <Select
              label="Endpoint Type"
              value={formData.endpoint_type}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, endpoint_type: e.target.value as 'STANDARD' | 'OPTIMIZED_STORAGE' })}
              options={[
                { value: 'STANDARD', label: 'Standard' },
                { value: 'OPTIMIZED_STORAGE', label: 'Optimized Storage' },
              ]}
              hint={formData.endpointSource === 'select' && formData.endpoint_name ? 'Auto-detected from selected endpoint' : 'Only used if endpoint is specified'}
              disabled={formData.endpointSource === 'select' && !!formData.endpoint_name}
            />
          </div>
          )}
          
          {/* Index Configuration - Required for use_existing, Optional for provision */}
          <div className="space-y-3 p-3 bg-slate-900/50 rounded border border-slate-600">
            <div>
              <p className="text-sm text-slate-300 font-medium">
                Vector Search Index 
                {formData.configMode === 'use_existing' && <span className="text-red-400 font-normal ml-1">(Required)</span>}
                {formData.configMode === 'provision' && <span className="text-slate-500 font-normal ml-1">(Optional - auto-generated)</span>}
              </p>
              <p className="text-xs text-slate-500">
                {formData.configMode === 'use_existing' 
                  ? 'Select the existing vector search index to use'
                  : 'Optionally specify a custom index name, or leave empty to auto-generate from source table'
                }
              </p>
            </div>
            
            {/* Schema Source Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-300">Index Schema</label>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, indexSchemaSource: 'reference' })}
                    className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                      formData.indexSchemaSource === 'reference' ? 'bg-purple-500/30 text-purple-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>Configured</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, indexSchemaSource: 'direct' })}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.indexSchemaSource === 'direct' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Select
                  </button>
                </div>
              </div>
              
              {formData.indexSchemaSource === 'reference' ? (
                <div className="space-y-2">
                  <Select
                    value={formData.indexSchemaRefName}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      const schemaKey = e.target.value;
                      const schema = configuredSchemas[schemaKey];
                      setFormData({
                        ...formData,
                        indexSchemaRefName: schemaKey,
                        index_catalog: getVariableDisplayValue(schema?.catalog_name),
                        index_schema: getVariableDisplayValue(schema?.schema_name),
                      });
                    }}
                    options={[
                      { value: '', label: 'Select configured schema...' },
                      ...configuredSchemaOptions,
                    ]}
                  />
                  {configuredSchemaOptions.length === 0 && (
                    <p className="text-xs text-amber-400">
                      No schemas configured. Add one in Schemas section or switch to "Select".
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Catalog"
                    value={formData.index_catalog}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, index_catalog: e.target.value, index_schema: '', indexSchemaRefName: '' })}
                    options={[
                      { value: '', label: 'Select catalog...' },
                      ...(catalogs || []).map((c) => ({ value: c.name, label: c.name })),
                    ]}
                  />
                  <Select
                    label="Schema"
                    value={formData.index_schema}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, index_schema: e.target.value, indexSchemaRefName: '' })}
                    options={[
                      { value: '', label: 'Select schema...' },
                      ...(indexSchemas || []).map((s) => ({ value: s.name, label: s.name })),
                    ]}
                    disabled={!formData.index_catalog}
                  />
                </div>
              )}
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-300">Index Name</label>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, indexNameSource: 'select' })}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.indexNameSource === 'select' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Select
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, indexNameSource: 'manual' })}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.indexNameSource === 'manual' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Manual
                  </button>
                </div>
              </div>
              
              {formData.indexNameSource === 'select' ? (
                <Select
                  value={formData.index_name}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const indexName = e.target.value;
                    setFormData(prev => ({
                      ...prev,
                      index_name: indexName,
                      refName: editingKey ? prev.refName : (indexName ? generateRefName(indexName) : prev.refName),
                    }));
                  }}
                  options={[
                    { value: '', label: indexTablesLoading ? 'Loading tables...' : 'Select a table...' },
                    ...(indexTables || []).map((t) => ({ value: t.name, label: t.name })),
                  ]}
                  disabled={(!formData.index_catalog || !formData.index_schema) || indexTablesLoading}
                  hint="Select a table from the index schema"
                />
              ) : (
                <Input
                  value={formData.index_name}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, index_name: e.target.value })}
                  placeholder="products_index"
                  hint="Enter a custom index name"
                />
              )}
            </div>
          </div>
          
          {/* Provisioning-specific fields - only shown in provision mode */}
          {formData.configMode === 'provision' && (
            <>
            {/* Source Table - REQUIRED for provisioning */}
            <div className="space-y-3 p-3 bg-slate-900/50 rounded border border-slate-600">
              <div>
                <p className="text-sm text-slate-300 font-medium">Source Table <span className="text-red-400 font-normal">(Required)</span></p>
                <p className="text-xs text-slate-500">The table containing data to be indexed</p>
              </div>
            
            {/* Schema Source Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-300">Source Schema</label>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, sourceSchemaSource: 'reference' })}
                    className={`px-2 py-1 text-xs rounded flex items-center space-x-1 ${
                      formData.sourceSchemaSource === 'reference' ? 'bg-purple-500/30 text-purple-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>Configured</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, sourceSchemaSource: 'direct' })}
                    className={`px-2 py-1 text-xs rounded ${
                      formData.sourceSchemaSource === 'direct' ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    Select
                  </button>
                </div>
              </div>
              
              {formData.sourceSchemaSource === 'reference' ? (
                <div className="space-y-2">
                  <Select
                    value={formData.sourceSchemaRefName}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      const schemaKey = e.target.value;
                      const schema = configuredSchemas[schemaKey];
                      // Clear table and column selections when schema changes
                      setFormData({
                        ...formData,
                        sourceSchemaRefName: schemaKey,
                        source_catalog: getVariableDisplayValue(schema?.catalog_name),
                        source_schema: getVariableDisplayValue(schema?.schema_name),
                        source_table: '',
                        embedding_source_column: '',
                        primary_key: '',
                        doc_uri: '',
                        columns: [],
                      });
                      setColumnsInput('');
                    }}
                    options={[
                      { value: '', label: 'Select configured schema...' },
                      ...configuredSchemaOptions,
                    ]}
                  />
                  {configuredSchemaOptions.length === 0 && (
                    <p className="text-xs text-amber-400">
                      No schemas configured. Add one in Schemas section or switch to "Select".
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Select
                    label="Catalog"
                    value={formData.source_catalog}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      // Clear schema, table, and column selections when catalog changes
                      setFormData({ 
                        ...formData, 
                        source_catalog: e.target.value, 
                        source_schema: '', 
                        source_table: '', 
                        sourceSchemaRefName: '',
                        embedding_source_column: '',
                        primary_key: '',
                        doc_uri: '',
                        columns: [],
                      });
                      setColumnsInput('');
                    }}
                    options={[
                      { value: '', label: 'Select catalog...' },
                      ...(catalogs || []).map((c) => ({ value: c.name, label: c.name })),
                    ]}
                  />
                  <Select
                    label="Schema"
                    value={formData.source_schema}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                      // Clear table and column selections when schema changes
                      setFormData({ 
                        ...formData, 
                        source_schema: e.target.value, 
                        source_table: '', 
                        sourceSchemaRefName: '',
                        embedding_source_column: '',
                        primary_key: '',
                        doc_uri: '',
                        columns: [],
                      });
                      setColumnsInput('');
                    }}
                    options={[
                      { value: '', label: 'Select schema...' },
                      ...(sourceSchemas || []).map((s) => ({ value: s.name, label: s.name })),
                    ]}
                    disabled={!formData.source_catalog}
                  />
                </div>
              )}
            </div>
            
            {/* Table Selection */}
            <div className="flex items-center space-x-2">
              <div className="flex-1">
                <Select
                  label="Table"
                  value={formData.source_table}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    // Clear column selections when table changes
                    setFormData({ 
                      ...formData, 
                      source_table: e.target.value,
                      embedding_source_column: '',
                      primary_key: '',
                      doc_uri: '',
                      columns: [],
                    });
                    setColumnsInput('');
                  }}
                  options={[
                    { value: '', label: tablesLoading ? 'Loading...' : 'Select table...' },
                    ...(sourceTables || []).map((t) => ({ value: t.name, label: t.name })),
                  ]}
                  disabled={(!formData.source_schema && !formData.sourceSchemaRefName) || tablesLoading}
                />
              </div>
              {formData.source_table && (
                <button
                  type="button"
                  onClick={() => refetchColumns()}
                  className="mt-6 text-xs text-slate-400 hover:text-white flex items-center space-x-1"
                  disabled={columnsLoading}
                >
                  <RefreshCw className={`w-3 h-3 ${columnsLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh Columns</span>
                </button>
              )}
            </div>
            
            {/* Columns to Sync - grouped with Source Table */}
            {formData.source_table && (
              <div className="space-y-2 mt-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-slate-300 font-medium">Columns to Sync</p>
                    <p className="text-xs text-slate-500">Select columns to include in the vector index</p>
                  </div>
                  {columnsLoading && (
                    <span className="text-xs text-slate-400 flex items-center space-x-1">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Loading...</span>
                    </span>
                  )}
                </div>
                {columnOptions.length > 0 ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 bg-slate-800/50 rounded border border-slate-700">
                      {columnOptions.map((col) => {
                        const isSelected = columnsInput.split(',').map(c => c.trim()).includes(col.value);
                        return (
                          <button
                            key={col.value}
                            type="button"
                            onClick={() => {
                              const currentCols = columnsInput.split(',').map(c => c.trim()).filter(c => c);
                              if (isSelected) {
                                setColumnsInput(currentCols.filter(c => c !== col.value).join(', '));
                              } else {
                                setColumnsInput([...currentCols, col.value].join(', '));
                              }
                            }}
                            className={`px-2 py-1 text-xs rounded transition-colors ${
                              isSelected 
                                ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50' 
                                : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                            }`}
                          >
                            {col.value}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500">
                        Selected: {columnsInput.split(',').filter(c => c.trim()).length || 0} of {columnOptions.length}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setColumnsInput(columnOptions.map(c => c.value).join(', '))}
                          className="text-xs text-blue-400 hover:text-blue-300"
                        >
                          Select All
                        </button>
                        <button
                          type="button"
                          onClick={() => setColumnsInput('')}
                          className="text-xs text-slate-400 hover:text-slate-300"
                        >
                          Clear All
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Input
                    label=""
                    value={columnsInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setColumnsInput(e.target.value)}
                    placeholder="id, name, description, category"
                    hint="Enter comma-separated column names"
                  />
                )}
              </div>
            )}
          </div>
          
          {/* Embedding and Column Configuration */}
          <div className="space-y-3 p-3 bg-slate-900/50 rounded border border-slate-600">
            <div className="flex items-center justify-between">
              <p className="text-sm text-slate-300 font-medium">Embedding Configuration</p>
              {columnsLoading && (
                <span className="text-xs text-slate-400 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Loading columns...</span>
                </span>
              )}
            </div>
            <Select
              label="Embedding Model"
              value={formData.embedding_model}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, embedding_model: e.target.value })}
              options={embeddingModelOptions}
              hint="Model used to create embeddings"
            />
            <Select
              label="Embedding Source Column"
              value={formData.embedding_source_column}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, embedding_source_column: e.target.value })}
              options={[
                { value: '', label: columnsLoading ? 'Loading columns...' : (columnOptions.length > 0 ? 'Select column...' : 'Select a table first...') },
                ...columnOptions,
              ]}
              hint="Column containing text to embed (typically text/string columns)"
              disabled={!formData.source_table || columnsLoading}
            />
            <Select
              label="Primary Key"
              value={formData.primary_key}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, primary_key: e.target.value })}
              options={[
                { value: '', label: columnsLoading ? 'Loading columns...' : (columnOptions.length > 0 ? 'Select primary key column...' : 'Select a table first...') },
                ...columnOptions,
              ]}
              hint="Primary key column for the source table"
              disabled={!formData.source_table || columnsLoading}
            />
          </div>
          
          <Select
            label="Document URI Column (Optional)"
            value={formData.doc_uri}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, doc_uri: e.target.value })}
            options={[
              { value: '', label: columnOptions.length > 0 ? 'None (no document URIs)' : 'Select a table first...' },
              ...columnOptions,
            ]}
            hint="Column containing document URIs for linking"
            disabled={!formData.source_table || columnsLoading}
          />
          
          {/* Optional Volume Paths */}
          <VolumePathsSection
            formData={formData}
            setFormData={setFormData}
            configuredSchemas={configuredSchemas}
            configuredSchemaOptions={configuredSchemaOptions}
            catalogs={catalogs}
            sourcePathSchemas={sourcePathSchemas}
            sourcePathVolumes={sourcePathVolumes}
            sourcePathVolumesLoading={sourcePathVolumesLoading}
            checkpointPathSchemas={checkpointPathSchemas}
            checkpointPathVolumes={checkpointPathVolumes}
            checkpointPathVolumesLoading={checkpointPathVolumesLoading}
          />
          </>
          )}
          
          {/* Authentication Section - applies to both modes */}
          <ResourceAuthSection
            formData={formData}
            setFormData={setFormData as any}
            variables={variables}
            servicePrincipals={servicePrincipals}
            variableNames={Object.keys(variables)}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={
                !formData.refName || 
                isRefNameDuplicate(formData.refName, config, editingKey) ||
                // Mode-specific validation
                (formData.configMode === 'use_existing' 
                  ? !formData.index_name || !formData.index_catalog || !formData.index_schema
                  : !formData.source_table || !formData.embedding_source_column
                )
              }
            >
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// =============================================================================
// Databricks Apps Panel
// =============================================================================

type AppNameSource = 'select' | 'manual';

function DatabricksAppsPanel({ showForm, setShowForm, editingKey, setEditingKey, onClose }: PanelProps) {
  const { config, addDatabricksApp, updateDatabricksApp, removeDatabricksApp } = useConfigStore();
  const apps = config.resources?.apps || {};
  const variables = config.variables || {};
  const servicePrincipals = config.service_principals || {};
  
  const [nameSource, setNameSource] = useState<AppNameSource>('select');
  const [formData, setFormData] = useState({
    refName: '',
    name: '',
    on_behalf_of_user: false,
    // Authentication fields
    authMethod: 'default' as 'default' | 'service_principal' | 'oauth' | 'pat',
    servicePrincipalRef: '',
    clientIdSource: 'variable' as 'variable' | 'manual',
    clientSecretSource: 'variable' as 'variable' | 'manual',
    workspaceHostSource: 'variable' as 'variable' | 'manual',
    patSource: 'variable' as 'variable' | 'manual',
    client_id: '',
    client_secret: '',
    workspace_host: '',
    pat: '',
    clientIdVariable: '',
    clientSecretVariable: '',
    workspaceHostVariable: '',
    patVariable: '',
  });

  const handleEdit = (key: string) => {
    scrollToAsset(key);
    const app = apps[key];
    
    // Parse authentication data
    const authData = parseResourceAuth(app, safeStartsWith, safeString, servicePrincipals);
    
    setFormData({
      refName: key,
      name: app.name,
      ...authData,
    });
    setEditingKey(key);
    setShowForm(true);
  };

  const handleSave = () => {
    const app: DatabricksAppModel = {
      name: formData.name,
      on_behalf_of_user: formData.on_behalf_of_user,
    };
    
    // Apply authentication configuration
    applyResourceAuth(app, formData as any);
    
    if (editingKey) {
      if (editingKey !== formData.refName) {
        removeDatabricksApp(editingKey);
        addDatabricksApp(formData.refName, app);
      } else {
        updateDatabricksApp(formData.refName, app);
      }
    } else {
      addDatabricksApp(formData.refName, app);
    }
    
    setFormData({ 
      refName: '', 
      name: '', 
      on_behalf_of_user: false,
      authMethod: 'default',
      servicePrincipalRef: '',
      clientIdSource: 'variable',
      clientSecretSource: 'variable',
      workspaceHostSource: 'variable',
      patSource: 'variable',
      client_id: '',
      client_secret: '',
      workspace_host: '',
      pat: '',
      clientIdVariable: '',
      clientSecretVariable: '',
      workspaceHostVariable: '',
      patVariable: '',
    });
    onClose();
  };

  const handleDelete = (key: string) => {
    safeDelete('Databricks App', key, () => removeDatabricksApp(key));
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <AppWindow className="w-5 h-5 text-purple-400" />
          <h3 className="text-lg font-semibold text-slate-100">Databricks Apps</h3>
        </div>
        <Button variant="secondary" size="sm" onClick={() => { 
          setFormData({ 
            refName: '', 
            name: '', 
            on_behalf_of_user: false, 
            authMethod: 'default', 
            servicePrincipalRef: '', 
            clientIdSource: 'variable', 
            clientSecretSource: 'variable', 
            workspaceHostSource: 'variable', 
            patSource: 'variable', 
            client_id: '', 
            client_secret: '', 
            workspace_host: '', 
            pat: '', 
            clientIdVariable: '', 
            clientSecretVariable: '', 
            workspaceHostVariable: '', 
            patVariable: '' 
          }); 
          setEditingKey(null); 
          setShowForm(true); 
        }}>
          <Plus className="w-4 h-4 mr-1" />
          Add App
        </Button>
      </div>

      {/* Info Card */}
      <div className="mb-4 p-3 bg-purple-900/20 border border-purple-500/30 rounded-lg">
        <div className="flex items-start space-x-2">
          <Info className="w-4 h-4 text-purple-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-purple-300/80">
            Databricks Apps allow your agents to interact with deployed applications. Configure the app instance name 
            to enable app-to-app communication. The URL is automatically retrieved from the workspace at runtime.
          </p>
        </div>
      </div>

      {/* Existing Resources */}
      {Object.keys(apps).length > 0 && (
        <div className="space-y-2 mb-4">
          {Object.entries(apps).map(([key, app]) => (
            <div 
              key={key} 
              className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700 cursor-pointer hover:bg-slate-800/70 transition-colors"
              onClick={() => handleEdit(key)}
            >
              <div className="flex items-center space-x-3">
                <AppWindow className="w-4 h-4 text-purple-400" />
                <div>
                  <p className="font-medium text-slate-200">{key}</p>
                  <p className="text-xs text-slate-500">
                    App: {app.name}
                  </p>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                {app.on_behalf_of_user && (
                  <Badge variant="success" title="On Behalf of User">
                    <User className="w-3 h-3 mr-1" />
                    OBO
                  </Badge>
                )}
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleEdit(key); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDelete(key); }}>
                  <Trash2 className="w-4 h-4 text-red-400" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {Object.keys(apps).length === 0 && !showForm && (
        <p className="text-slate-500 text-sm">No Databricks Apps configured.</p>
      )}

      {/* Form */}
      {showForm && (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-lg border border-slate-700 space-y-4">
          <h4 className="font-medium text-slate-200">{editingKey ? 'Edit' : 'New'} Databricks App</h4>
          
          <Input
            label="Reference Name"
            value={formData.refName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, refName: normalizeRefNameWhileTyping(e.target.value) })}
            placeholder="my_databricks_app"
            hint="Type naturally - spaces become underscores"
            required
          />
          
          {/* App Name Source Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-300">
                App Instance Name <span className="text-red-400">*</span>
              </label>
              <div className="inline-flex rounded-md bg-slate-900/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setNameSource('select')}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-all ${
                    nameSource === 'select'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                      : 'text-slate-400 hover:text-slate-300'
                  }`}
                >
                  <Database className="w-3 h-3 inline mr-1" />
                  Select
                </button>
                <button
                  type="button"
                  onClick={() => setNameSource('manual')}
                  className={`px-2 py-0.5 text-xs rounded font-medium transition-all ${
                    nameSource === 'manual'
                      ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40'
                      : 'text-slate-400 hover:text-slate-300'
                  }`}
                >
                  <Pencil className="w-3 h-3 inline mr-1" />
                  Manual
                </button>
              </div>
            </div>
            
            {nameSource === 'select' ? (
              <DatabricksAppSelect
                label=""
                value={formData.name}
                onChange={(value) => {
                  setFormData({ 
                    ...formData, 
                    name: value,
                    refName: formData.refName || generateRefName(value),
                  });
                }}
                placeholder="Select a Databricks App"
                hint="Select an app from your workspace. The URL is retrieved automatically at runtime."
                required
              />
            ) : (
              <Input
                value={formData.name}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setFormData({ 
                    ...formData, 
                    name: e.target.value,
                    refName: formData.refName || generateRefName(e.target.value),
                  });
                }}
                placeholder="my-databricks-app"
                hint="Enter the unique name of the Databricks App in your workspace."
              />
            )}
          </div>
          
          {/* Authentication Section (includes On Behalf of User option) */}
          <ResourceAuthSection
            formData={formData as any}
            setFormData={(data) => setFormData({ ...formData, ...data })}
            servicePrincipals={servicePrincipals}
            variables={variables}
            variableNames={Object.keys(variables)}
          />
          
          {/* Duplicate reference name warning */}
          {formData.refName && isRefNameDuplicate(formData.refName, config, editingKey) && (
            <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              A resource with reference name "{formData.refName}" already exists. Please choose a unique name.
            </div>
          )}
          
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button 
              onClick={handleSave} 
              disabled={
                !formData.refName || 
                !formData.name || 
                isRefNameDuplicate(formData.refName, config, editingKey)
              }
            >
              {editingKey ? 'Update' : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default ResourcesSection;

