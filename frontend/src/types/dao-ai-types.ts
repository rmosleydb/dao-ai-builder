// Core types based on dao-ai schema
export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARNING" | "ERROR";

// Variable types for dao-ai configuration
export type VariableType = "primitive" | "env" | "secret" | "composite";

export interface PrimitiveVariableModel {
  type: "primitive";
  value: string | number | boolean;
}

export interface EnvironmentVariableModel {
  type: "env";
  env: string;
  default_value?: string | number | boolean;
}

export interface SecretVariableModel {
  type: "secret";
  scope: string;
  secret: string;
  default_value?: string | number | boolean;
}

export interface CompositeVariableModel {
  type: "composite";
  options: (EnvironmentVariableModel | SecretVariableModel | PrimitiveVariableModel)[];
  default_value?: string | number | boolean;
}

export type VariableModel =
  | PrimitiveVariableModel
  | EnvironmentVariableModel
  | SecretVariableModel
  | CompositeVariableModel;

// Variable value type - can be a VariableModel or primitive value
export type VariableValue = VariableModel | string | number | boolean;

export interface ServicePrincipalModel {
  client_id: VariableValue;
  client_secret: VariableValue;
}

export interface SchemaModel {
  catalog_name: VariableValue;
  schema_name: VariableValue;
  permissions?: PermissionModel[];
}

export interface LLMModel {
  name: string;
  description?: string;
  temperature?: number;
  max_tokens?: number;
  on_behalf_of_user?: boolean;
  use_responses_api?: boolean;  // Use Responses API for ResponsesAgent endpoints
  fallbacks?: (string | LLMModel)[];
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

// VectorStoreModel supports two configuration modes:
// 1. Use Existing Index: Provide only 'index' to reference a pre-built vector search index
// 2. Provision New Index: Provide 'source_table' and 'embedding_source_column' to create a new index
export interface VectorStoreModel {
  on_behalf_of_user?: boolean;
  // Required for use_existing mode, optional (auto-generated) for provision mode
  index?: IndexModel;
  // Required for provision mode only
  source_table?: TableModel;
  embedding_source_column?: string;  // Required for provision mode, omitted for use_existing
  embedding_model?: LLMModel;        // Optional, defaults to databricks-gte-large-en for provision mode
  endpoint?: VectorSearchEndpoint;   // Optional, auto-discovered for provision mode
  // Optional for both modes
  source_path?: VolumePathModel;
  checkpoint_path?: VolumePathModel;
  primary_key?: string;
  columns?: string[];
  doc_uri?: string;
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

export interface IndexModel {
  on_behalf_of_user?: boolean;
  schema?: SchemaModel;
  name: string;
}

export interface VectorSearchEndpoint {
  name: string;
  type?: "STANDARD" | "OPTIMIZED_STORAGE";
}

export interface TableModel {
  on_behalf_of_user?: boolean;
  schema?: SchemaModel;
  name?: string;
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

export interface VolumePathModel {
  volume?: VolumeModel;
  path?: string;
}

export interface VolumeModel {
  on_behalf_of_user?: boolean;
  schema?: SchemaModel;
  name: string;
}

export interface GenieRoomModel {
  on_behalf_of_user?: boolean;
  name?: string;  // Optional - auto-populated from GenieSpace.title if not provided
  description?: string;
  space_id?: VariableValue;  // Optional - can configure by name only. Can be string or variable reference (env, secret, etc.)
  warehouse?: WarehouseModel | string;  // NOTE: computed @property in Python, not serialized to YAML
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

export interface FunctionModel {
  on_behalf_of_user?: boolean;
  schema?: SchemaModel;
  name?: string;
}

export interface WarehouseModel {
  on_behalf_of_user?: boolean;
  name?: string;  // Optional - can configure by name only (resolved via warehouse API)
  description?: string;
  warehouse_id?: VariableValue;  // Optional - can configure by name only
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

// Genie Caching Models
export interface GenieLRUCacheParametersModel {
  capacity?: number;  // Default: 1000
  time_to_live_seconds?: number | null;  // Default: 86400 (1 day), null = never expires
  warehouse: WarehouseModel | string;  // Can be inline or reference
}

export interface GenieContextAwareCacheParametersModel {
  time_to_live_seconds?: number | null;  // Default: 86400 (1 day), null = never expires
  similarity_threshold?: number;  // Default: 0.85 - Minimum similarity for question matching
  context_similarity_threshold?: number;  // Default: 0.80 - Minimum similarity for context matching
  question_weight?: number | null;  // Default: 0.6 - Weight for question similarity (0-1)
  context_weight?: number | null;  // Default: computed as 1 - question_weight
  embedding_model?: string | LLMModel;  // Default: "databricks-gte-large-en"
  embedding_dims?: number | null;  // Auto-detected if null
  database: DatabaseModel | string;  // Can be inline or reference
  warehouse: WarehouseModel | string;  // Can be inline or reference
  table_name?: string;  // Default: "genie_context_aware_cache"
  context_window_size?: number;  // Default: 4 - Number of previous turns to include for context
  max_context_tokens?: number;  // Default: 2000 - Maximum context length to prevent extremely long embeddings
  // Prompt history fields
  prompt_history_table?: string;  // Default: "genie_prompt_history"
  max_prompt_history_length?: number;  // Default: 50
  use_genie_api_for_history?: boolean;  // Default: false
  prompt_history_ttl_seconds?: number | null;  // Optional TTL for prompt history (null = use cache TTL)
  // IVFFlat index tuning for pg_vector similarity search
  ivfflat_lists?: number | null;  // Number of IVF lists (null = auto-computed as max(100, sqrt(row_count)))
  ivfflat_probes?: number | null;  // Number of lists to probe per query (null = auto-computed as max(10, sqrt(lists)))
  ivfflat_candidates?: number;  // Top-K candidates before Python-side reranking (default: 20)
}

// In-Memory Semantic Cache for Genie (no database required)
// New in dao-ai 0.1.21 - useful for single-instance deployments
export interface GenieInMemoryContextAwareCacheParametersModel {
  time_to_live_seconds?: number | null;  // Default: 604800 (1 week), null = never expires
  similarity_threshold?: number;  // Default: 0.85 - Minimum similarity for question matching
  context_similarity_threshold?: number;  // Default: 0.80 - Minimum similarity for context matching
  question_weight?: number | null;  // Default: 0.6 - Weight for question similarity (0-1)
  context_weight?: number | null;  // Default: computed as 1 - question_weight
  embedding_model?: string | LLMModel;  // Default: "databricks-gte-large-en"
  embedding_dims?: number | null;  // Auto-detected if null
  warehouse: WarehouseModel | string;  // Can be inline or reference - required for re-executing cached SQL
  capacity?: number | null;  // Default: 10000 - Max cache entries with LRU eviction, null = unlimited
  context_window_size?: number;  // Default: 3 - Number of previous turns to include for context
  max_context_tokens?: number;  // Default: 2000 - Maximum context length to prevent extremely long embeddings
}

// Database type is inferred from fields:
// - instance_name provided → Lakebase
// - host provided → PostgreSQL
// NOTE: type field removed in dao-ai 0.1.2, type is inferred from instance_name vs host
export type DatabaseType = "postgres" | "lakebase";

export interface DatabaseModel {
  on_behalf_of_user?: boolean;
  name?: string;  // Optional - auto-populated from instance_name for Lakebase
  // NOTE: type field is for UI only, not included in YAML output (inferred from instance_name vs host)
  _uiType?: DatabaseType;
  instance_name?: string;  // Lakebase instance name
  description?: string;
  host?: VariableValue;  // PostgreSQL hostname (can be variable or string)
  database?: VariableValue;  // Database name (default: "databricks_postgres")
  port?: VariableValue;  // Port number (default: 5432)
  connection_kwargs?: Record<string, any>;
  max_pool_size?: number;
  timeout_seconds?: number;
  capacity?: "CU_1" | "CU_2";
  node_count?: number;
  user?: VariableValue;
  password?: VariableValue;
  service_principal?: ServicePrincipalModel | string;  // Can be inline or reference
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

export interface ConnectionModel {
  on_behalf_of_user?: boolean;
  name: string;
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

// Databricks App Model - represents a Databricks App resource
export interface DatabricksAppModel {
  on_behalf_of_user?: boolean;
  name: string;  // The unique instance name of the Databricks App (URL is retrieved dynamically)
  // Authentication fields
  service_principal?: ServicePrincipalModel | string;
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  pat?: VariableValue;
}

export interface RetrieverModel {
  vector_store: VectorStoreModel;
  columns?: string[];
  search_parameters?: SearchParametersModel;
  rerank?: RerankParametersModel | boolean;  // FlashRank/Databricks reranking only
  instructed?: InstructedRetrieverModel;
}

// Router for selecting standard vs instructed execution mode
export interface RouterModel {
  model?: LLMModel | string;  // Reference to LLM resource
  default_mode?: "standard" | "instructed";
  auto_bypass?: boolean;  // Skip Instruction Reranker and Verifier for standard mode
}

// Query decomposition settings for instructed retrieval
export interface DecompositionModel {
  model?: LLMModel | string;  // Reference to LLM resource (fast model recommended)
  max_subqueries?: number;  // Default: 3
  rrf_k?: number;  // Default: 60
  examples?: InstructedRetrieverExample[];
  normalize_filter_case?: "uppercase" | "lowercase";
}

// Instructed retrieval with query decomposition, reranking, routing, and verification
// In dao-ai 0.1.24+, columns is the single source of truth for schema context.
// Each pipeline component (decomposition, routing, verification, reranking)
// generates the specific context it needs from the structured column metadata.
export interface InstructedRetrieverModel {
  columns: ColumnInfo[];  // Required - structured column metadata for all pipeline components
  constraints?: string[];
  decomposition?: DecompositionModel;  // Query decomposition and RRF merging
  rerank?: InstructionAwareRerankModel;  // LLM-based instruction-aware reranking
  router?: RouterModel;  // Query routing between standard/instructed modes
  verifier?: VerifierModel;  // Result validation with retry support
}

// Column metadata for dynamic schema generation in instructed retrieval
export interface ColumnInfo {
  name: string;
  type?: "string" | "number" | "boolean" | "datetime";
  operators?: string[];  // Default: ["", "NOT", "<", "<=", ">", ">=", "LIKE", "NOT LIKE"]
  description?: string;  // Human-readable description for LLM context (e.g. "Brand/manufacturer (MILWAUKEE, DEWALT, etc.)")
}

// Few-shot example for instructed retrieval
export interface InstructedRetrieverExample {
  query: string;
  filters: Record<string, any>;
}

// Verifier for result validation with retry support
export interface VerifierModel {
  model?: LLMModel | string;  // Reference to LLM resource
  on_failure?: "warn" | "retry" | "warn_and_retry";
  max_retries?: number;  // Default: 1
}

export interface SearchParametersModel {
  num_results?: number;
  filters?: Record<string, any>;
  query_type?: string;
}

export interface RerankParametersModel {
  model?: string;  // FlashRank model name (optional - use columns for Databricks reranking)
  top_n?: number;
  cache_dir?: string;
  columns?: string[];
}

// LLM-based instruction-aware reranking (runs after FlashRank)
export interface InstructionAwareRerankModel {
  model?: LLMModel | string;  // Reference to LLM resource
  instructions?: string;  // Custom reranking instructions
  top_n?: number;
}

export type ToolFunctionType = "python" | "factory" | "unity_catalog" | "mcp" | "inline";

export interface PythonFunctionModel {
  type: "python";
  name: string;
  human_in_the_loop?: HumanInTheLoopModel;
}

// Inline function model for defining tool code directly in YAML configuration
// New in dao-ai 0.1.21
export interface InlineFunctionModel {
  type: "inline";
  code: string;  // Python code defining a tool function decorated with @tool
  human_in_the_loop?: HumanInTheLoopModel;
}

export interface FactoryFunctionModel {
  type: "factory";
  name: string;
  args?: Record<string, any>;
  human_in_the_loop?: HumanInTheLoopModel;
}

export interface UnityCatalogFunctionModel {
  type: "unity_catalog";
  resource?: FunctionModel | string; // Reference to FunctionModel in resources.functions
  partial_args?: Record<string, any>;
  human_in_the_loop?: HumanInTheLoopModel;
}

export interface McpFunctionModel {
  type: "mcp";
  // NOTE: 'name' is NOT part of McpFunctionModel - it's in the parent ToolModel
  transport?: "streamable_http" | "stdio";
  command?: string;
  url?: VariableValue;
  headers?: Record<string, any>;
  args?: string[];
  pat?: VariableValue;
  service_principal?: ServicePrincipalModel | string;  // Can be inline or reference
  client_id?: VariableValue;
  client_secret?: VariableValue;
  workspace_host?: VariableValue;
  app?: DatabricksAppModel | string;  // Can be inline or reference to configured app
  connection?: ConnectionModel | string;  // Can be inline or reference
  functions?: SchemaModel;
  genie_room?: GenieRoomModel | string;  // Can be inline or reference
  sql?: boolean;
  vector_search?: VectorStoreModel | string;  // Can be inline or reference
  human_in_the_loop?: HumanInTheLoopModel;
  // Tool filtering - supports glob patterns (* for any chars, ? for single char)
  include_tools?: string[];  // Only include tools matching these patterns
  exclude_tools?: string[];  // Exclude tools matching these patterns (takes precedence over include)
}

export type ToolFunctionModel =
  | PythonFunctionModel
  | FactoryFunctionModel
  | InlineFunctionModel
  | UnityCatalogFunctionModel
  | McpFunctionModel
  | string;

export interface ToolModel {
  name: string;
  function: ToolFunctionModel;
}

export type HumanInTheLoopDecision = "approve" | "edit" | "reject";

export interface HumanInTheLoopModel {
  review_prompt?: string;
  allowed_decisions?: HumanInTheLoopDecision[];
}

export type GuardrailMode = 'llm_judge' | 'scorer';

export interface GuardrailModel {
  name: string;
  // LLM Judge mode fields (provide model + prompt)
  model?: LLMModel;
  prompt?: string;
  // Scorer mode fields (provide scorer, optionally scorer_args + hub)
  scorer?: string;
  scorer_args?: Record<string, any>;
  hub?: string;
  // Common fields
  num_retries?: number;
  fail_on_error?: boolean;
  max_context_length?: number;
  apply_to?: 'input' | 'output' | 'both';
}

export interface MiddlewareModel {
  name: string;
  args?: Record<string, any>;
}

export interface ResponseFormatModel {
  use_tool?: boolean | null;
  response_schema?: string;
}

export interface AgentModel {
  name: string;
  description?: string;
  model: LLMModel;
  tools?: ToolModel[];
  guardrails?: GuardrailModel[];
  prompt?: string | PromptModel;
  handoff_prompt?: string;
  middleware?: MiddlewareModel[];
  response_format?: ResponseFormatModel | string;
}

export interface PromptModel {
  schema?: SchemaModel;
  name: string;
  description?: string;
  default_template?: string;
  alias?: string;
  version?: number;
  tags?: Record<string, any>;
  auto_register?: boolean;  // Whether to automatically register the prompt in MLflow
}

export interface PermissionModel {
  principals?: string[];
  privileges: string[];
}

export interface AppPermissionModel {
  principals: string[];
  entitlements: string[];
}

export interface SupervisorModel {
  model: LLMModel;
  tools?: ToolModel[];
  prompt?: string | PromptModel;
  middleware?: MiddlewareModel[];
}

export interface HandoffRouteModel {
  agent: AgentModel | string;
  is_deterministic?: boolean;
}

export interface SwarmModel {
  default_agent?: AgentModel | string;
  handoffs?: Record<string, (AgentModel | string | HandoffRouteModel)[] | null>;
  middleware?: MiddlewareModel[];
}

export type MemorySchemaName = 'user_profile' | 'preference' | 'episode';

export interface MemoryExtractionModel {
  schemas?: MemorySchemaName[];
  instructions?: string;
  auto_inject?: boolean;
  auto_inject_limit?: number;
  background_extraction?: boolean;
  extraction_model?: LLMModel | string;
  query_model?: LLMModel | string;
}

export interface MemoryModel {
  refName?: string;  // Reference name for YAML anchor (e.g., &memory)
  checkpointer?: CheckpointerModel;
  store?: StoreModel;
  extraction?: MemoryExtractionModel;
}

export interface CheckpointerModel {
  name: string;
  // NOTE: type field removed in dao-ai 0.1.2
  // Storage type is inferred: database provided → postgres, no database → memory
  database?: DatabaseModel;
}

export interface StoreModel {
  name: string;
  embedding_model?: LLMModel;
  // NOTE: type field removed in dao-ai 0.1.2
  // Storage type is inferred: database provided → postgres, no database → memory
  dims?: number;
  database?: DatabaseModel;
  namespace?: string;
}

export interface OrchestrationModel {
  supervisor?: SupervisorModel;
  swarm?: SwarmModel;
  memory?: MemoryModel;
}

export interface RegisteredModelModel {
  schema?: SchemaModel;
  name: string;
}

export interface TraceLocationModel {
  schema: SchemaModel;
  warehouse: WarehouseModel | string;
}

export interface MonitoringModel {
  sample_rate?: number;
  scorers?: (string | GuardrailModel)[];
  guidelines?: GuidelineModel[];
  guidelines_sample_rate?: number;
}

export interface AppModel {
  name: string;
  description?: string;
  log_level?: LogLevel;
  service_principal?: ServicePrincipalModel | string;  // Can be inline or reference
  registered_model: RegisteredModelModel;
  endpoint_name?: string;
  trace_location?: TraceLocationModel;
  monitoring?: MonitoringModel;
  tags?: Record<string, any>;
  scale_to_zero?: boolean;
  environment_vars?: Record<string, any>;
  budget_policy_id?: string;
  python_version?: string;  // Python version for the deployment environment
  workload_size?: "Small" | "Medium" | "Large";
  deployment_target?: "model_serving" | "apps";
  permissions?: AppPermissionModel[];
  agents: AgentModel[];
  orchestration?: OrchestrationModel;
  alias?: string;
  initialization_hooks?: (string | PythonFunctionModel | FactoryFunctionModel)[];
  shutdown_hooks?: (string | PythonFunctionModel | FactoryFunctionModel)[];
  input_example?: ChatPayload;
  chat_history?: ChatHistoryModel;
  code_paths?: string[];
  pip_requirements?: string[];
}

export interface ChatPayload {
  input?: Message[];
  messages?: Message[];
  custom_inputs?: Record<string, any>;
}

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatHistoryModel {
  model: LLMModel;
  max_tokens?: number;
  max_tokens_before_summary?: number;
  max_messages_before_summary?: number;
}

export interface EvaluationModel {
  model: LLMModel;
  table: TableModel;
  num_evals: number;
  replace?: boolean;
  agent_description?: string;
  question_guidelines?: string;
  custom_inputs?: Record<string, any>;
  guidelines?: GuidelineModel[];
}

export interface GuidelineModel {
  name: string;
  guidelines: string[];
}

export interface DatasetModel {
  table?: TableModel;
  ddl?: string | VolumeModel;
  data?: string | VolumePathModel;
  format?: "csv" | "delta" | "json" | "parquet" | "orc" | "sql" | "excel";
  read_options?: Record<string, any>;
  table_schema?: string;
  parameters?: Record<string, any>;
}

export interface UnityCatalogFunctionSqlModel {
  function: UnityCatalogFunctionModel;
  ddl: string;
  parameters?: Record<string, any>;
  test?: UnityCatalogFunctionSqlTestModel;
}

export interface UnityCatalogFunctionSqlTestModel {
  parameters?: Record<string, any>;
}

export interface ResourcesModel {
  llms?: Record<string, LLMModel>;
  vector_stores?: Record<string, VectorStoreModel>;
  genie_rooms?: Record<string, GenieRoomModel>;
  tables?: Record<string, TableModel>;
  volumes?: Record<string, VolumeModel>;
  functions?: Record<string, FunctionModel>;
  warehouses?: Record<string, WarehouseModel>;
  databases?: Record<string, DatabaseModel>;
  connections?: Record<string, ConnectionModel>;
  apps?: Record<string, DatabricksAppModel>;
}

export interface AppConfig {
  version?: string;
  variables?: Record<string, any>;
  schemas?: Record<string, SchemaModel>;
  service_principals?: Record<string, ServicePrincipalModel>;
  resources?: ResourcesModel;
  retrievers?: Record<string, RetrieverModel>;
  tools?: Record<string, ToolModel>;
  guardrails?: Record<string, GuardrailModel>;
  middleware?: Record<string, MiddlewareModel>;
  memory?: MemoryModel;
  prompts?: Record<string, PromptModel>;
  agents?: Record<string, AgentModel>;
  app?: AppModel;
  evaluation?: EvaluationModel;
  optimizations?: {
    training_datasets?: Record<string, any>;
    prompt_optimizations?: Record<string, any>;
  };
  datasets?: DatasetModel[];
  unity_catalog_functions?: UnityCatalogFunctionSqlModel[];
  providers?: Record<string, any>;
}

