import yaml from 'js-yaml';
import { AppConfig, VariableModel, DatabaseModel, OrchestrationModel, ToolFunctionModel, HumanInTheLoopModel } from '@/types/dao-ai-types';
import { getYamlReferences, getOriginalAnchorName, getRequiredMergeAnchors, getRequiredAliasAnchors, setSectionAnchor, getSectionAnchor, clearSectionAnchors } from './yaml-references';

/**
 * Safely check if a value is a string that starts with a prefix.
 * Handles the case where YAML anchors are resolved to objects instead of strings.
 */
function safeStartsWith(value: unknown, prefix: string): boolean {
  return typeof value === 'string' && value.startsWith(prefix);
}

// Module-level storage for defined variables and schemas during YAML generation
// This allows formatCredential and other functions to detect when values match defined resources
let _definedVariables: Record<string, unknown> = {};
let _definedSchemas: Record<string, unknown> = {};

/**
 * Deep compare two values to check if they're structurally equal.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  
  if (aKeys.length !== bKeys.length) return false;
  
  return aKeys.every(key => deepEqual(aObj[key], bObj[key]));
}

/**
 * Find if a value matches any defined variable.
 * Returns the variable name if found, null otherwise.
 */
function findMatchingVariable(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  
  for (const [varName, varDef] of Object.entries(_definedVariables)) {
    // Compare the value against the variable definition
    // Variables are stored in different formats, so we need to check multiple possibilities
    const varObj = varDef as Record<string, unknown>;
    
    // Check if the value matches the variable definition directly
    if (deepEqual(value, varObj)) {
      return varName;
    }
    
    // Check if the value matches the formatted version of the variable
    // (e.g., comparing against { options: [...] } structure)
    if (deepEqual(value, formatVariable(varDef as VariableModel))) {
      return varName;
    }
  }
  
  return null;
}

/**
 * Get a displayable value from a VariableValue (which could be string, number, boolean, or object).
 */
function getVariableDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  if (typeof value === 'boolean') return value.toString();
  
  // Handle object types (env, secret, composite variables)
  const obj = value as Record<string, unknown>;
  if (obj.env) return String(obj.env);
  if (obj.secret) return String(obj.secret);
  if (obj.value !== undefined) return String(obj.value);
  
  // If it's a complex object, try to stringify it
  return JSON.stringify(value);
}

/**
 * Post-process YAML to add quotes around wildcard patterns in tool filters.
 * This ensures glob patterns like "get_*" are consistently quoted for clarity and safety.
 */
function quoteWildcardPatterns(yamlString: string): string {
  // Split into lines for processing
  const lines = yamlString.split('\n');
  const result: string[] = [];
  let inToolFilter = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if we're entering/exiting a tool filter section
    if (/^\s+(?:include|exclude)_tools:\s*$/.test(line)) {
      inToolFilter = true;
      result.push(line);
      continue;
    }
    
    // Check if we've exited the tool filter (non-list-item line at same or lower indentation)
    if (inToolFilter && line.trim() && !line.match(/^\s+-\s+/)) {
      inToolFilter = false;
    }
    
    // If we're in a tool filter section and this is a list item
    if (inToolFilter && /^\s+-\s+/.test(line)) {
      // Match: "  - pattern  # optional comment"
      const match = line.match(/^(\s+-\s+)(['"]?)([^'"\n#]+)\2(\s*(?:#.*)?)$/);
      if (match) {
        const [, prefix, existingQuote, pattern, suffix] = match;
        const trimmedPattern = pattern.trim();
        
        // Check if pattern contains wildcards
        if (/[*?[\]!]/.test(trimmedPattern)) {
          // Always use double quotes for consistency, even if already single-quoted
          if (existingQuote !== '"') {
            result.push(`${prefix}"${trimmedPattern}"${suffix}`);
            continue;
          }
        }
      }
    }
    
    result.push(line);
  }
  
  return result.join('\n');
}

/**
 * Post-process YAML to ensure all values in operators: lists are double-quoted.
 * js-yaml leaves plain-safe scalars like "<" and "<=" unquoted, while quoting
 * ">" and ">=" (because ">" is a YAML folded-scalar indicator). This function
 * normalizes them so every operator value is consistently double-quoted.
 */
function quoteOperatorValues(yamlString: string): string {
  const lines = yamlString.split('\n');
  const result: string[] = [];
  let inOperatorsList = false;
  let operatorsIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect "operators:" followed by a block list (no inline value)
    const operatorsMatch = line.match(/^(\s+)operators:\s*$/);
    if (operatorsMatch) {
      inOperatorsList = true;
      operatorsIndent = operatorsMatch[1].length;
      result.push(line);
      continue;
    }

    if (inOperatorsList) {
      // Still inside the list if this is a list item indented deeper than the key
      if (/^\s+-\s/.test(line)) {
        const itemIndent = line.search(/\S/);
        if (itemIndent > operatorsIndent) {
          // Match unquoted or single-quoted list items: "  - value"
          const itemMatch = line.match(/^(\s+-\s+)(['"]?)(.*)$/);
          if (itemMatch) {
            const [, prefix, existingQuote, rest] = itemMatch;
            if (existingQuote === '"') {
              // Already double-quoted, keep as-is
              result.push(line);
            } else if (existingQuote === "'") {
              // Single-quoted – convert to double quotes
              const value = rest.replace(/'(\s*(?:#.*)?)$/, '');
              const suffix = rest.slice(value.length).replace(/^'/, '');
              result.push(`${prefix}"${value}"${suffix}`);
            } else {
              // Unquoted – add double quotes
              const trimmed = rest.trimEnd();
              const trailing = rest.slice(trimmed.length);
              result.push(`${prefix}"${trimmed}"${trailing}`);
            }
            continue;
          }
        } else {
          inOperatorsList = false;
        }
      } else if (line.trim() !== '') {
        // Non-list, non-empty line means we've left the operators block
        inOperatorsList = false;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Find if a schema value matches any defined schema.
 * Returns the schema name if found, null otherwise.
 */
function findMatchingSchema(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  
  const valueObj = value as Record<string, unknown>;
  
  // Schema comparison - match on catalog_name and schema_name
  for (const [schemaName, schemaDef] of Object.entries(_definedSchemas)) {
    const schemaObj = schemaDef as Record<string, unknown>;
    
    // Compare catalog_name and schema_name
    const catalogMatch = 
      getVariableDisplayValue(valueObj.catalog_name) === getVariableDisplayValue(schemaObj.catalog_name);
    const schemaNameMatch = 
      getVariableDisplayValue(valueObj.schema_name) === getVariableDisplayValue(schemaObj.schema_name);
    
    if (catalogMatch && schemaNameMatch) {
      return schemaName;
    }
  }
  
  return null;
}

/**
 * Add YAML anchors (&anchor_name) to resource definitions.
 * This allows resources to be referenced later using aliases (*anchor_name).
 * 
 * Pattern: "  key_name:" becomes "  key_name: &key_name"
 * 
 * Only adds anchors to DIRECT children of each section, not nested keys.
 * Uses a two-pass approach to avoid state tracking issues with nested sections.
 */
function addYamlAnchors(yamlString: string): string {
  // Top-level sections where we want to add anchors to their direct children
  const topLevelAnchorSections = [
    'variables',
    'schemas',
    'service_principals',
    'retrievers',
    'tools',
    'guardrails',
    'middleware',
    'prompts',
    'agents',
  ];
  
  // Sections where the anchor should be on the section key itself (not children)
  // These are single-object sections that can be referenced
  const sectionLevelAnchorSections = [
    'memory',
  ];
  
  // Sections nested under 'resources:' that need anchors
  const resourceAnchorSections = [
    'llms',
    'vector_stores',
    'genie_rooms',
    'tables',
    'volumes',
    'functions',
    'warehouses',
    'connections',
    'databases',
    'apps',
  ];
  
  // Sections that should NOT have anchors
  const noAnchorSections = [
    'app',
  ];
  
  const lines = yamlString.split('\n');
  
  // First pass: Find all section boundaries
  interface SectionInfo {
    name: string;
    startLine: number;
    indent: number;
    childIndent: number;
    endLine: number;
  }
  
  const sections: SectionInfo[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sectionMatch = line.match(/^(\s*)(\w[\w_-]*):\s*$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[2];
      const sectionIndent = sectionMatch[1].length;
      
      // Check if this is a top-level anchor section
      if (sectionIndent === 0 && topLevelAnchorSections.includes(sectionName)) {
        sections.push({
          name: sectionName,
          startLine: i,
          indent: sectionIndent,
          childIndent: sectionIndent + 2,
          endLine: -1, // Will be set later
        });
      }
      // Check if this is 'resources:' section - we'll look for nested sections
      else if (sectionIndent === 0 && sectionName === 'resources') {
        // Look for nested resource sections
        for (let j = i + 1; j < lines.length; j++) {
          const nestedLine = lines[j];
          const nestedMatch = nestedLine.match(/^(\s*)(\w[\w_-]*):\s*$/);
          if (nestedMatch) {
            const nestedName = nestedMatch[2];
            const nestedIndent = nestedMatch[1].length;
            
            // If we hit another top-level section, stop
            if (nestedIndent === 0) break;
            
            // Check if this is a resource section at indent 2
            if (nestedIndent === 2 && resourceAnchorSections.includes(nestedName)) {
              sections.push({
                name: nestedName,
                startLine: j,
                indent: nestedIndent,
                childIndent: nestedIndent + 2,
                endLine: -1,
              });
            }
          }
        }
      }
    }
  }
  
  // Calculate end lines for each section
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    // Find where this section ends (next line at same or less indentation)
    for (let j = section.startLine + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const lineIndent = line.search(/\S/);
      if (lineIndent !== -1 && lineIndent <= section.indent) {
        section.endLine = j;
        break;
      }
    }
    if (section.endLine === -1) {
      section.endLine = lines.length;
    }
  }
  
  // First, add anchors to section-level anchor sections (like memory:)
  // These get the anchor on the section key itself, not on children
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match top-level section keys (no indentation)
    const sectionMatch = line.match(/^(\w[\w_-]*):\s*$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1];
      if (sectionLevelAnchorSections.includes(sectionName) && !line.includes('&')) {
        // Check for custom anchor from config (e.g., memory.refName)
        const sectionAnchor = getSectionAnchor(sectionName);
        // Then check for original anchor name from imported YAML
        const originalAnchor = getOriginalAnchorName(sectionName);
        // Use: custom anchor > original anchor > section name
        const anchorName = sectionAnchor || originalAnchor || sectionName;
        lines[i] = `${sectionName}: &${anchorName}`;
      }
    }
  }
  
  // Second pass: Add anchors to direct children of each section
  for (const section of sections) {
    // Skip if this section is in noAnchorSections
    if (noAnchorSections.includes(section.name)) continue;
    
    // Determine the path prefix for this section
    // For top-level sections (indent 0), use section name directly
    // For nested resource sections (indent 2), prefix with "resources."
    const pathPrefix = section.indent === 0 ? section.name : `resources.${section.name}`;
    
    for (let i = section.startLine + 1; i < section.endLine; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      
      const lineIndent = line.search(/\S/);
      
      // Only process lines at exactly the child indent level
      if (lineIndent !== section.childIndent) continue;
      
      // Check if this line is a direct child key (ends with : and no value)
      const childKeyMatch = line.match(new RegExp(`^( {${section.childIndent}})(\\w[\\w_-]*):\\s*$`));
      if (childKeyMatch) {
        const indent = childKeyMatch[1];
        const keyName = childKeyMatch[2];
        
        // Add anchor if not already present
        if (!line.includes('&')) {
          // Check if there's an original anchor name from imported YAML
          const fullPath = `${pathPrefix}.${keyName}`;
          const originalAnchor = getOriginalAnchorName(fullPath);
          
          // Get anchors that are REQUIRED by merge keys (<<: *anchor) or alias references (*anchor)
          // These must be present even for normally skipped sections
          const requiredMergeAnchors = getRequiredMergeAnchors();
          const requiredAliasAnchors = getRequiredAliasAnchors();
          
          // Check if the key name OR the original anchor name (if different) is required
          const isRequiredByMerge = requiredMergeAnchors.includes(keyName) || 
            (originalAnchor && requiredMergeAnchors.includes(originalAnchor));
          const isRequiredByAlias = requiredAliasAnchors.includes(keyName) || 
            (originalAnchor && requiredAliasAnchors.includes(originalAnchor));
          
          // Resource sections that rarely need anchors (they're source data, not references)
          // Only add anchor if it was in the original YAML OR required by a merge key OR required by an alias
          const noAutoAnchorSections = ['tables', 'volumes'];
          
          if (originalAnchor) {
            // Preserve the original anchor from imported YAML
            lines[i] = `${indent}${keyName}: &${originalAnchor}`;
          } else if (isRequiredByMerge || isRequiredByAlias) {
            // This anchor is required by a merge key or alias reference - MUST add it
            lines[i] = `${indent}${keyName}: &${keyName}`;
          } else if (noAutoAnchorSections.includes(section.name)) {
            // Don't auto-add anchors to tables/volumes - they're rarely referenced
            // Leave the line as-is (no anchor)
          } else {
            // For other sections (tools, agents, schemas, functions, etc.), add anchor using key name
            lines[i] = `${indent}${keyName}: &${keyName}`;
          }
        }
      }
    }
  }
  
  return lines.join('\n');
}

/**
 * Convert reference markers to YAML aliases.
 * Replaces "__REF__key_name" with "*key_name" (unquoted).
 * Replaces "__MERGE__: key_name" with "<<: *key_name" for YAML merge.
 * Handles both quoted and unquoted occurrences.
 */
function convertReferencesToAliases(yamlString: string): string {
  // Replace YAML merge markers (e.g., __MERGE__: "func_name") with <<: *func_name
  let result = yamlString.replace(/__MERGE__: "(\w+)"/g, '<<: *$1');
  result = result.replace(/__MERGE__: (\w+)/g, '<<: *$1');
  
  // Replace quoted reference markers with unquoted aliases
  result = result.replace(/"__REF__(\w+)"/g, '*$1');
  // Replace unquoted reference markers (e.g., in arrays: - __REF__name)
  result = result.replace(/- __REF__(\w+)/g, '- *$1');
  // Replace any remaining unquoted occurrences
  result = result.replace(/__REF__(\w+)/g, '*$1');
  // Replace prompt reference markers with unquoted aliases (same as __REF__ but separate marker)
  result = result.replace(/"__PROMPT_REF__(\w+)"/g, '*$1');
  result = result.replace(/__PROMPT_REF__(\w+)/g, '*$1');
  return result;
}

/**
 * Create a reference marker for a resource that will be converted to a YAML alias.
 * Use this when you want to reference a previously defined resource.
 */
function createReference(refName: string): string {
  return `__REF__${refName}`;
}

/**
 * Format environment variables for YAML output.
 * Converts variable references to __REF__ markers so they get properly 
 * converted to unquoted YAML aliases.
 * 
 * Handles:
 * 1. String references starting with * (e.g., "*client_id")
 * 2. Object values that match a defined variable (resolved YAML references)
 */
function formatEnvironmentVars(envVars: Record<string, any>, definedVariables: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('*')) {
      // This is a string variable reference - use __REF__ marker
      result[key] = createReference(value.slice(1));
    } else if (typeof value === 'object' && value !== null) {
      // This might be a resolved variable reference - find matching variable key
      const matchedVar = Object.entries(definedVariables).find(
        ([, v]) => JSON.stringify(v) === JSON.stringify(value)
      );
      if (matchedVar) {
        result[key] = createReference(matchedVar[0]);
      } else {
        // Object doesn't match any variable - stringify it
        result[key] = String(value);
      }
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

/**
 * Check if a value was originally a reference in the imported YAML.
 * Returns the reference name if found, null otherwise.
 * 
 * Uses multiple strategies:
 * 1. Path-based matching using stored alias usage
 * 2. Value-based matching for known patterns
 * 
 * @param path - The YAML path to check (e.g., "tools.genie_tool.function.args.genie_room")
 * @param value - The resolved value to check
 */
function findOriginalReference(path: string, value: any): string | null {
  const refs = getYamlReferences();
  if (!refs) return null;
  
  // Normalize path for comparison
  const normalizedPath = path.toLowerCase().replace(/-/g, '_');
  const pathParts = path.split('.');
  
  // Strategy 1: Exact path match in aliasUsage (highest priority)
  for (const [anchorName, usagePaths] of Object.entries(refs.aliasUsage)) {
    for (const usagePath of usagePaths) {
      const normalizedUsagePath = usagePath.toLowerCase().replace(/-/g, '_');
      
      // Exact match
      if (normalizedPath === normalizedUsagePath) {
        if (refs.anchorPaths[anchorName]) {
          return anchorName;
        }
      }
    }
  }
  
  // Strategy 2: For array items, try matching without the index
  // e.g., "agents.genie.tools.0" should match "agents.genie.tools.0" stored usage
  const lastPart = pathParts[pathParts.length - 1];
  if (/^\d+$/.test(lastPart)) {
    // This is an array index - look for exact matches including the index
    for (const [anchorName, usagePaths] of Object.entries(refs.aliasUsage)) {
      for (const usagePath of usagePaths) {
        const normalizedUsagePath = usagePath.toLowerCase().replace(/-/g, '_');
        // Check if the usage path matches our path
        if (normalizedPath === normalizedUsagePath) {
          return anchorName;
        }
        // Also check if usage path ends with our path (for nested cases)
        if (normalizedUsagePath.endsWith(normalizedPath)) {
          return anchorName;
        }
      }
    }
  }
  
  // Strategy 3: Match by checking if the anchor's definition path matches what we're referencing
  // This is useful for tools where the tool key might differ from tool.name
  if (value && typeof value === 'object') {
    // If this looks like a tool reference (has name and function properties)
    if ('name' in value && 'function' in value) {
      // Find the anchor that defines this tool by checking if the value matches
      for (const [anchorName, anchorPath] of Object.entries(refs.anchorPaths)) {
        // Check if this anchor is in the tools section
        if (anchorPath.startsWith('tools.')) {
          // This anchor is a tool - check if it's the one we want
          // The anchorName (e.g., "genie_tool") is what we want to reference
          // Check if any usage of this anchor is in a similar context
          const usages = refs.aliasUsage[anchorName] || [];
          for (const usagePath of usages) {
            // Check if the context matches (e.g., both are agent tool references)
            const usagePathParts = usagePath.split('.');
            const currentPathParts = path.split('.');
            // Match if both are in agents.X.tools context
            if (usagePathParts.includes('tools') && currentPathParts.includes('tools')) {
              const usageAgentIdx = usagePathParts.indexOf('agents');
              const currentAgentIdx = currentPathParts.indexOf('agents');
              if (usageAgentIdx !== -1 && currentAgentIdx !== -1) {
                // Both are agent tool references - check if same agent
                const usageAgent = usagePathParts[usageAgentIdx + 1];
                const currentAgent = currentPathParts[currentAgentIdx + 1];
                if (usageAgent === currentAgent) {
                  return anchorName;
                }
              }
            }
          }
        }
      }
    }
  }
  
  // Strategy 4: Check pathSuffixToAnchor for quick lookups (use last 2 path parts)
  const lastTwoKeys = pathParts.slice(-2).join('.');
  if (refs.pathSuffixToAnchor) {
    const normalizedLastTwo = lastTwoKeys.toLowerCase().replace(/-/g, '_');
    for (const [suffix, anchorName] of Object.entries(refs.pathSuffixToAnchor)) {
      const normalizedSuffix = suffix.toLowerCase().replace(/-/g, '_');
      if (normalizedLastTwo === normalizedSuffix || normalizedLastTwo.endsWith('.' + normalizedSuffix)) {
        if (refs.anchorPaths[anchorName]) {
          return anchorName;
        }
      }
    }
  }
  
  // Strategy 5: Value-based matching for schema objects
  if (value && typeof value === 'object') {
    // For schema objects, try to match by catalog_name + schema_name
    if (value.catalog_name && value.schema_name) {
      for (const [anchorName, anchorPath] of Object.entries(refs.anchorPaths)) {
        if (anchorPath.includes('schema')) {
          // This might be a schema reference
          return anchorName;
        }
      }
    }
  }
  
  return null;
}

/**
 * Recursively process an object and replace values with references where appropriate.
 * This is the main function for ensuring all references are preserved.
 * 
 * @param obj - The object to process
 * @param basePath - The base YAML path for this object
 * @param definedResources - Map of defined resources that can be referenced
 * @returns The processed object with references
 */
export function processObjectWithReferences(
  obj: any, 
  basePath: string, 
  definedResources: Record<string, Record<string, any>>
): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  
  // Check if this entire object should be a reference
  const objRef = findOriginalReference(basePath, obj);
  if (objRef) {
    return createReference(objRef);
  }
  
  // If it's an array, process each element
  if (Array.isArray(obj)) {
    return obj.map((item, idx) => processObjectWithReferences(item, `${basePath}.${idx}`, definedResources));
  }
  
  // Process each key in the object
  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = basePath ? `${basePath}.${key}` : key;
    
    // Check if this specific value should be a reference
    const valueRef = findOriginalReference(keyPath, value);
    if (valueRef) {
      result[key] = createReference(valueRef);
    } else if (typeof value === 'object' && value !== null) {
      // Recursively process nested objects
      result[key] = processObjectWithReferences(value, keyPath, definedResources);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Format a model reference - either as a YAML alias if it matches a defined LLM,
 * or as an inline object if it's a custom definition.
 * 
 * @param model - The model object or string
 * @param definedLLMs - Map of defined LLM keys to LLM objects
 * @param basePath - The path in the YAML structure (e.g., "agents.my_agent.model") for reference lookup
 */
function formatModelReference(model: any, definedLLMs: Record<string, any>, basePath?: string): any {
  if (typeof model === 'string') {
    // If it's a string, check if it's a defined LLM reference
    if (definedLLMs[model]) {
      return createReference(model);
    }
    return model;
  }
  
  if (model && typeof model === 'object' && model.name) {
    // FIRST: Check if we have an original reference for this path
    // This is critical to preserve the correct reference when multiple LLMs have the same name
    if (basePath) {
      const originalRef = findOriginalReference(basePath, model);
      if (originalRef) {
        // Only use this reference if the key still exists in definedLLMs
        // If it doesn't exist, the reference will cause an "undefined alias" error
        // which is the desired behavior for dependency checking
        return createReference(originalRef);
      }
    }
    
    // FALLBACK: Check if this model exactly matches a defined LLM (deep equality)
    // This is safer than just matching by name
    for (const [llmKey, llm] of Object.entries(definedLLMs)) {
      // Deep equality check to avoid false matches
      if (JSON.stringify(llm) === JSON.stringify(model)) {
        return createReference(llmKey);
      }
    }
    
    // Not a reference, return the full model object
    return {
      name: model.name,
      ...(model.description && { description: model.description }),
      ...(model.temperature !== undefined && { temperature: model.temperature }),
      ...(model.max_tokens !== undefined && { max_tokens: model.max_tokens }),
      ...(model.on_behalf_of_user !== undefined && { on_behalf_of_user: model.on_behalf_of_user }),
      ...(model.use_responses_api !== undefined && { use_responses_api: model.use_responses_api }),
      ...(model.fallbacks && model.fallbacks.length > 0 && { fallbacks: model.fallbacks }),
    };
  }
  
  return model;
}

/**
 * Format a schema field value (catalog_name or schema_name).
 * Handles variable references, variable objects, and plain strings.
 * @param value - The field value (can be string, variable reference, or variable object)
 * @param path - Optional YAML path for checking original references
 */
function formatSchemaFieldValue(value: unknown, path?: string): any {
  if (value === null || value === undefined) return undefined;
  
  // Check for original reference first
  if (path) {
    const originalRef = findOriginalReference(path, value);
    if (originalRef) {
      return createReference(originalRef);
    }
  }
  
  // Handle string values
  if (typeof value === 'string') {
    // Variable reference (e.g., *my_variable)
    if (value.startsWith('*')) {
      return createReference(value.slice(1));
    }
    // Plain string
    return value;
  }
  
  // Handle variable objects (EnvironmentVariableModel, SecretVariableModel, etc.)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    
    // Environment variable: { env: "VAR_NAME", default_value?: "xxx" }
    if ('env' in obj && typeof obj.env === 'string') {
      return {
        env: obj.env,
        ...(obj.default_value !== undefined && { default_value: obj.default_value }),
      };
    }
    
    // Secret variable: { scope: "xxx", secret: "yyy" }
    if ('scope' in obj && 'secret' in obj) {
      return {
        scope: obj.scope,
        secret: obj.secret,
        ...(obj.default_value !== undefined && { default_value: obj.default_value }),
      };
    }
    
    // Primitive variable: { value: "xxx" } or { type: "primitive", value: "xxx" }
    if ('value' in obj) {
      return { value: obj.value };
    }
    
    // Composite variable: { options: [...] }
    if ('options' in obj && Array.isArray(obj.options)) {
      return {
        options: (obj.options as any[]).map((opt) => formatSchemaFieldValue(opt)),
        ...(obj.default_value !== undefined && { default_value: obj.default_value }),
      };
    }
  }
  
  // Handle primitive values (number, boolean)
  return value;
}

/**
 * Get the display string value from a schema field for comparison.
 * Returns the actual string value from variable objects.
 */
function getSchemaFieldDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
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

/**
 * Format a schema reference - either as a YAML alias if it matches a defined schema,
 * or as an inline object if it's a custom definition.
 * Now supports VariableValue for catalog_name and schema_name.
 * @param schema - The schema object
 * @param definedSchemas - Map of defined schemas
 * @param path - Optional YAML path for checking original references
 */
function formatSchemaReference(
  schema: { catalog_name: unknown; schema_name: unknown } | undefined, 
  definedSchemas: Record<string, any>,
  path?: string
): any {
  if (!schema) return undefined;
  
  // First, check if this was originally a reference in imported YAML
  if (path) {
    const originalRef = findOriginalReference(path, schema);
    if (originalRef) {
      return createReference(originalRef);
    }
  }
  
  // Get display values for comparison
  const catalogDisplay = getSchemaFieldDisplayValue(schema.catalog_name);
  const schemaDisplay = getSchemaFieldDisplayValue(schema.schema_name);
  
  // Check if this schema matches a defined schema
  for (const [schemaKey, s] of Object.entries(definedSchemas)) {
    const defCatalogDisplay = getSchemaFieldDisplayValue(s.catalog_name);
    const defSchemaDisplay = getSchemaFieldDisplayValue(s.schema_name);
    if (defCatalogDisplay === catalogDisplay && defSchemaDisplay === schemaDisplay) {
      return createReference(schemaKey);
    }
  }
  
  // Not a reference, return the full schema object with formatted field values
  const basePath = path || '';
  return {
    catalog_name: formatSchemaFieldValue(schema.catalog_name, basePath ? `${basePath}.catalog_name` : undefined),
    schema_name: formatSchemaFieldValue(schema.schema_name, basePath ? `${basePath}.schema_name` : undefined),
  };
}

/**
 * Format a VolumePathModel - handles volume references, schema references, and inline definitions.
 * @param volumePath - The VolumePathModel object
 * @param definedVolumes - Map of defined volumes
 */
function formatVolumePath(
  volumePath: { volume?: any; path?: string } | undefined,
  definedVolumes: Record<string, any>
): any {
  if (!volumePath) return undefined;
  
  const result: any = {};
  
  if (volumePath.volume) {
    // Check if volume is a string reference (e.g., "*volume_ref")
    if (typeof volumePath.volume === 'string') {
      if (volumePath.volume.startsWith('*')) {
        // It's a reference - create reference marker
        result.volume = createReference(volumePath.volume.substring(1));
      } else {
        // Plain string - treat as reference name
        result.volume = createReference(volumePath.volume);
      }
    } else {
      // Volume is an object - check if it matches a defined volume
      let foundRef: string | undefined;
      for (const [volumeKey, v] of Object.entries(definedVolumes)) {
        if (v.name === volumePath.volume.name && 
            v.schema?.catalog_name === volumePath.volume.schema?.catalog_name &&
            v.schema?.schema_name === volumePath.volume.schema?.schema_name) {
          foundRef = volumeKey;
          break;
        }
      }
      
      if (foundRef) {
        result.volume = createReference(foundRef);
      } else {
        // Check if volume has a schema reference (_schemaRef) - use *ref format
        if (volumePath.volume._schemaRef) {
          result.volume = {
            schema: createReference(volumePath.volume._schemaRef),
            name: volumePath.volume.name,
          };
        } else {
          // Output inline volume definition with full schema
          result.volume = {
            ...(volumePath.volume.schema && {
              schema: {
                catalog_name: volumePath.volume.schema.catalog_name,
                schema_name: volumePath.volume.schema.schema_name,
              }
            }),
            name: volumePath.volume.name,
          };
        }
      }
    }
  }
  
  if (volumePath.path) {
    result.path = volumePath.path;
  }
  
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Format orchestration configuration for YAML output.
 * Handles swarm handoffs where null means "any agent" and [] means "no handoffs".
 */
function formatOrchestration(orchestration: OrchestrationModel, definedLLMs: Record<string, any>, definedTools: Record<string, any>, definedMiddleware: Record<string, any>, definedAgents: Record<string, any>): any {
  const result: any = {};
  
  if (orchestration.supervisor) {
    // Format supervisor tools as references - tools should be referenced using *tool_name
    let supervisorToolsValue: string[] | undefined;
    if (orchestration.supervisor.tools && orchestration.supervisor.tools.length > 0) {
      supervisorToolsValue = orchestration.supervisor.tools.map((tool) => {
        // Tools are stored as ToolModel objects - find the key by matching
        const toolName = typeof tool === 'string' ? tool : tool.name;
        
        // Strategy 1: Check if toolName is already a valid key in definedTools
        if (definedTools[toolName]) {
          return createReference(toolName);
        }
        
        // Strategy 2: Find the key in definedTools that matches this tool's name
        const matchedByName = Object.entries(definedTools).find(
          ([, t]) => t.name === toolName
        );
        if (matchedByName) {
          return createReference(matchedByName[0]);
        }
        
        // Strategy 3: Find by deep comparison of the full tool object
        const toolObj = typeof tool === 'object' ? tool : null;
        if (toolObj) {
          const matchedByObject = Object.entries(definedTools).find(
            ([, t]) => JSON.stringify(t) === JSON.stringify(toolObj)
          );
          if (matchedByObject) {
            return createReference(matchedByObject[0]);
          }
        }
        
        // Fallback: use the toolName
        return createReference(toolName);
      });
    }
    
    // Format supervisor middleware as references
    let supervisorMiddlewareValue: string[] | undefined;
    if (orchestration.supervisor.middleware && orchestration.supervisor.middleware.length > 0) {
      supervisorMiddlewareValue = orchestration.supervisor.middleware.map((mw: any) => {
        // Strategy 1: If it's already a string reference, use it
        if (typeof mw === 'string') {
          return mw.startsWith('*') ? createReference(mw.slice(1)) : createReference(mw);
        }
        
        // Strategy 2: If it's an object, find the matching key by name
        const middlewareName = typeof mw === 'string' ? mw : mw?.name;
        if (middlewareName) {
          const matchedByName = Object.entries(definedMiddleware).find(
            ([, m]) => (m as any).name === middlewareName
          );
          if (matchedByName) {
            return createReference(matchedByName[0]);
          }
        }
        
        // Strategy 3: Find by deep comparison of the full middleware object
        const middlewareObj = typeof mw === 'object' ? mw : null;
        if (middlewareObj) {
          const matchedByObject = Object.entries(definedMiddleware).find(
            ([, m]) => JSON.stringify(m as any) === JSON.stringify(middlewareObj)
          );
          if (matchedByObject) {
            return createReference(matchedByObject[0]);
          }
        }
        
        // Fallback: use the middleware name
        return createReference(middlewareName || 'middleware');
      });
    }
    
    result.supervisor = {
      model: formatModelReference(orchestration.supervisor.model, definedLLMs, 'orchestration.supervisor.model'),
      ...(supervisorToolsValue && supervisorToolsValue.length > 0 && { 
        tools: supervisorToolsValue 
      }),
      ...(orchestration.supervisor.prompt && { prompt: orchestration.supervisor.prompt }),
      ...(supervisorMiddlewareValue && supervisorMiddlewareValue.length > 0 && {
        middleware: supervisorMiddlewareValue
      }),
    };
  }
  
  if (orchestration.swarm) {
    result.swarm = {};
    
    // Helper to find agent key and create reference
    const findAgentReference = (agent: string | { name: string } | any): any => {
      const agentName = typeof agent === 'string' ? agent : agent?.name;
      if (!agentName) return null;
      
      // Strategy 1: Check if agentName is already a valid key in definedAgents
      if (definedAgents[agentName]) {
        return createReference(agentName);
      }
      
      // Strategy 2: Find the key in definedAgents that matches this agent's name
      const matchedByName = Object.entries(definedAgents).find(
        ([, a]) => (a as any).name === agentName
      );
      if (matchedByName) {
        return createReference(matchedByName[0]);
      }
      
      // Fallback: return the name as-is (shouldn't happen in normal usage)
      return agentName;
    };
    
    // Handle default_agent - create a reference to the agent
    if (orchestration.swarm.default_agent) {
      result.swarm.default_agent = findAgentReference(orchestration.swarm.default_agent);
    }
    
    // Handle handoffs - null means any, [] means none, array means specific
    // Targets can be strings, AgentModels, or HandoffRouteModel objects (with agent + is_deterministic)
    if (orchestration.swarm.handoffs && Object.keys(orchestration.swarm.handoffs).length > 0) {
      result.swarm.handoffs = {};
      Object.entries(orchestration.swarm.handoffs).forEach(([agentName, targets]) => {
        if (targets === null || targets === undefined) {
          // null means can hand off to any agent - use YAML null (~)
          result.swarm.handoffs[agentName] = null;
        } else if (Array.isArray(targets)) {
          if (targets.length === 0) {
            // Empty array means no handoffs (terminal agent)
            result.swarm.handoffs[agentName] = [];
          } else {
            // Specific targets - create references to agents or HandoffRouteModel objects
            result.swarm.handoffs[agentName] = targets.map(t => {
              // Check if this is a HandoffRouteModel (has 'agent' and 'is_deterministic' fields)
              if (typeof t === 'object' && t !== null && 'agent' in t && 'is_deterministic' in t) {
                const handoffRoute = t as { agent: string | { name: string }; is_deterministic: boolean };
                const agentRef = findAgentReference(handoffRoute.agent);
                if (handoffRoute.is_deterministic) {
                  return { agent: agentRef, is_deterministic: true };
                }
                // Non-deterministic HandoffRouteModel: emit as plain agent reference
                return agentRef;
              }
              // Plain string or AgentModel - standard agentic handoff
              return findAgentReference(t);
            });
          }
        }
      });
    }
    
    // Format swarm middleware as references
    if (orchestration.swarm.middleware && orchestration.swarm.middleware.length > 0) {
      const swarmMiddlewareValue = orchestration.swarm.middleware.map((mw: any) => {
        // Strategy 1: If it's already a string reference, use it
        if (typeof mw === 'string') {
          return mw.startsWith('*') ? createReference(mw.slice(1)) : createReference(mw);
        }
        
        // Strategy 2: If it's an object, find the matching key by name
        const middlewareName = typeof mw === 'string' ? mw : mw?.name;
        if (middlewareName) {
          const matchedByName = Object.entries(definedMiddleware).find(
            ([, m]) => (m as any).name === middlewareName
          );
          if (matchedByName) {
            return createReference(matchedByName[0]);
          }
        }
        
        // Strategy 3: Find by deep comparison of the full middleware object
        const middlewareObj = typeof mw === 'object' ? mw : null;
        if (middlewareObj) {
          const matchedByObject = Object.entries(definedMiddleware).find(
            ([, m]) => JSON.stringify(m as any) === JSON.stringify(middlewareObj)
          );
          if (matchedByObject) {
            return createReference(matchedByObject[0]);
          }
        }
        
        // Fallback: use the middleware name
        return createReference(middlewareName || 'middleware');
      });
      
      if (swarmMiddlewareValue.length > 0) {
        result.swarm.middleware = swarmMiddlewareValue;
      }
    }
  }
  
  // Handle memory - can be a string reference like '*memory' or a MemoryModel object
  if (orchestration.memory) {
    const memoryValue = orchestration.memory as unknown;
    if (typeof memoryValue === 'string') {
      // It's already a string reference like '*memory'
      if (memoryValue.startsWith('*')) {
        result.memory = createReference(memoryValue.slice(1));
      } else {
        result.memory = createReference(memoryValue);
      }
    } else {
      // It's a MemoryModel object - check if it was originally a reference
      const memoryRef = findOriginalReference('orchestration.memory', memoryValue);
      if (memoryRef) {
        result.memory = createReference(memoryRef);
      } else {
        // If there's a top-level memory config, reference it
        // This handles the case where memory is defined at the config level
        result.memory = createReference('memory');
      }
    }
  }
  
  return result;
}

/**
 * Format Human In The Loop configuration for YAML output.
 */
function formatHITL(hitl: HumanInTheLoopModel): any {
  return {
    ...(hitl.review_prompt && { review_prompt: hitl.review_prompt }),
    ...(hitl.allowed_decisions && hitl.allowed_decisions.length > 0 && { 
      allowed_decisions: hitl.allowed_decisions 
    }),
  };
}

/**
 * Format a tool function for YAML output.
 * Handles all function types: python, factory, unity_catalog, mcp, and string references.
 * @param func - The tool function model
 * @param toolKey - Optional tool key for looking up original references
 * @param definedConnections - Optional map of defined connections for reference resolution
 * @param definedApps - Optional map of defined Databricks Apps for reference resolution
 */
function formatToolFunction(func: ToolFunctionModel, toolKey?: string, definedConnections?: Record<string, any>, definedApps?: Record<string, any>): any {
  if (typeof func === 'string') {
    return func;
  }

  const result: any = {
    type: func.type,
  };

  // Add name only for function types that actually have it in their schema
  // Note: 
  // - UnityCatalogFunctionModel doesn't have name (uses resource instead)
  // - McpFunctionModel doesn't have name (name is in parent ToolModel)
  // - Only FactoryFunctionModel and some other types have name in the function itself
  if (!('__MERGE__' in func) && func.type !== 'unity_catalog' && func.type !== 'mcp' && 'name' in func) {
    result.name = func.name;
  }

  // Add type-specific fields
  if (func.type === 'factory' && 'args' in func) {
    if (func.args && Object.keys(func.args).length > 0) {
      // Recursively process args to find all references (including nested ones)
      // This handles cases like:
      //   lru_cache_parameters:
      //     warehouse: *shared_endpoint_warehouse
      const basePath = toolKey ? `tools.${toolKey}.function.args` : 'function.args';
      result.args = processObjectWithReferences(func.args, basePath, {});
    }
  }

  // Inline function type (new in dao-ai 0.1.21)
  if (func.type === 'inline') {
    // Remove name - it's not part of InlineFunctionModel (name is in parent ToolModel)
    delete result.name;
    if ('code' in func && func.code) {
      result.code = func.code;
    }
  }

  if (func.type === 'unity_catalog') {
    // New dao-ai 0.1.2 format: use 'resource' field instead of YAML merge (<<: *func_ref)
    // Format: function: { type: unity_catalog, resource: *func_ref, partial_args: {} }
    
    // Remove name - it's not part of UnityCatalogFunctionModel, name is in ToolModel
    delete result.name;
    
    // Handle resource reference
    if ('resource' in func && func.resource) {
      const resource = func.resource;
      if (typeof resource === 'string') {
        // Already a reference string
        if (resource.startsWith('*')) {
          result.resource = createReference(resource.slice(1));
        } else {
          result.resource = createReference(resource);
        }
      } else {
        // Check if it was originally a reference in imported YAML
        const resourcePath = toolKey ? `tools.${toolKey}.function.resource` : 'function.resource';
        const originalRef = findOriginalReference(resourcePath, resource);
        if (originalRef) {
          result.resource = createReference(originalRef);
        } else {
          // Inline FunctionModel - format as inline object
          const inlineResource: Record<string, any> = {};
          if (resource.schema) {
            inlineResource.schema = resource.schema;
          }
          if (resource.name) {
            inlineResource.name = resource.name;
          }
          if (resource.on_behalf_of_user) {
            inlineResource.on_behalf_of_user = resource.on_behalf_of_user;
          }
          result.resource = inlineResource;
        }
      }
    }
    
    // Handle partial_args
    if ('partial_args' in func && func.partial_args && Object.keys(func.partial_args).length > 0) {
      // Check each partial_arg for original references
      const processedPartialArgs: Record<string, any> = {};
      for (const [argKey, argValue] of Object.entries(func.partial_args)) {
        // Check if this arg was originally a reference
        const argRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.partial_args.${argKey}`, argValue) : null;
        if (argRef) {
          processedPartialArgs[argKey] = createReference(argRef);
        } else {
          processedPartialArgs[argKey] = argValue;
        }
      }
      result.partial_args = processedPartialArgs;
    }
  }

  if (func.type === 'mcp') {
    // MCP-specific fields
    if ('transport' in func && func.transport) result.transport = func.transport;
    if ('command' in func && func.command) result.command = func.command;
    if ('url' in func && func.url) result.url = func.url;
    if ('headers' in func && func.headers) result.headers = func.headers;
    if ('args' in func && func.args) result.args = func.args;
    if ('pat' in func && func.pat) result.pat = formatCredential(func.pat as string);
    
    // Service Principal reference (takes precedence over inline credentials)
    if ('service_principal' in func && func.service_principal) {
      const sp = func.service_principal as any;
      if (typeof sp === 'string') {
        if (sp.startsWith('*')) {
          result.service_principal = createReference(sp.slice(1));
        } else {
          result.service_principal = createReference(sp);
        }
      } else {
        // Inline service principal object
        result.service_principal = {
          client_id: formatCredential(sp.client_id),
          client_secret: formatCredential(sp.client_secret),
        };
      }
    } else {
      // Individual credentials (only if no service_principal)
      if ('client_id' in func && func.client_id) result.client_id = formatCredential(func.client_id as string);
      if ('client_secret' in func && func.client_secret) result.client_secret = formatCredential(func.client_secret as string);
      if ('workspace_host' in func && func.workspace_host) result.workspace_host = formatCredential(func.workspace_host as string);
    }
    
    if ('connection' in func && func.connection) {
      // Handle connection reference (string starting with *) or inline object
      const conn = func.connection as any;
      if (typeof conn === 'string' && conn.startsWith('*')) {
        result.connection = createReference(conn.slice(1));
      } else {
        // Check if connection was originally a reference in imported YAML
        const connRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.connection`, conn) : null;
        if (connRef) {
          result.connection = createReference(connRef);
        } else {
          // Try to match by name against defined connections
          // This handles the case where YAML aliases were resolved on import
          const connName = typeof conn === 'object' && conn.name ? conn.name : null;
          if (connName && definedConnections) {
            const matchingConnKey = Object.entries(definedConnections).find(
              ([, c]) => (c as any).name === connName
            )?.[0];
            if (matchingConnKey) {
              result.connection = createReference(matchingConnKey);
            } else {
              result.connection = conn;
            }
          } else {
            result.connection = conn;
          }
        }
      }
    }
    if ('functions' in func && func.functions) {
      const funcsVal = func.functions as any;
      // Handle reference string (starts with *)
      if (typeof funcsVal === 'string' && funcsVal.startsWith('*')) {
        result.functions = createReference(funcsVal.slice(1));
      } else {
        // Check if functions schema matches a defined schema
        const matchingSchema = findMatchingSchema(func.functions);
        if (matchingSchema) {
          result.functions = createReference(matchingSchema);
        } else {
          result.functions = func.functions;
        }
      }
    }
    
    // Check for original references for genie_room
    if ('genie_room' in func && func.genie_room) {
      const genieVal = func.genie_room as any;
      // Handle reference string (starts with *)
      if (typeof genieVal === 'string' && genieVal.startsWith('*')) {
        result.genie_room = createReference(genieVal.slice(1));
      } else {
        const genieRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.genie_room`, func.genie_room) : null;
        result.genie_room = genieRef ? createReference(genieRef) : func.genie_room;
      }
    }
    
    if ('sql' in func && func.sql) result.sql = func.sql;
    
    // Check for app reference (Databricks App)
    if ('app' in func && func.app) {
      const appVal = func.app as any;
      // Handle reference string (starts with *)
      if (typeof appVal === 'string' && appVal.startsWith('*')) {
        result.app = createReference(appVal.slice(1));
      } else {
        // Check if app was originally a reference in imported YAML
        const appRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.app`, appVal) : null;
        if (appRef) {
          result.app = createReference(appRef);
        } else {
          // Try to match by name against defined apps
          // This handles the case where YAML aliases were resolved on import
          const appName = typeof appVal === 'object' && appVal.name ? appVal.name : null;
          if (appName && definedApps) {
            const matchingAppKey = Object.entries(definedApps).find(
              ([, a]) => (a as any).name === appName
            )?.[0];
            if (matchingAppKey) {
              result.app = createReference(matchingAppKey);
            } else {
              result.app = appVal;
            }
          } else {
            result.app = appVal;
          }
        }
      }
    }
    
    // Check for original references for vector_search/retriever
    if ('vector_search' in func && func.vector_search) {
      const vsVal = func.vector_search as any;
      // Handle reference string (starts with *)
      if (typeof vsVal === 'string' && vsVal.startsWith('*')) {
        result.vector_search = createReference(vsVal.slice(1));
      } else {
        const vsRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.vector_search`, func.vector_search) : null;
        if (vsRef) {
          result.vector_search = createReference(vsRef);
        } else if ('retriever' in vsVal) {
          // Also check retriever reference
          const retrieverRef = toolKey ? findOriginalReference(`tools.${toolKey}.function.vector_search.retriever`, vsVal.retriever) : null;
          result.vector_search = {
            ...vsVal,
            retriever: retrieverRef ? createReference(retrieverRef) : vsVal.retriever,
          };
        } else {
          result.vector_search = func.vector_search;
        }
      }
    }
    
    // Tool filtering - include_tools and exclude_tools
    if ('include_tools' in func && func.include_tools && (func.include_tools as string[]).length > 0) {
      result.include_tools = func.include_tools;
    }
    if ('exclude_tools' in func && func.exclude_tools && (func.exclude_tools as string[]).length > 0) {
      result.exclude_tools = func.exclude_tools;
    }
  }

  // Add Human In The Loop if present (applies to all types)
  if ('human_in_the_loop' in func && func.human_in_the_loop) {
    result.human_in_the_loop = formatHITL(func.human_in_the_loop);
  }

  return result;
}

/**
 * Format a DatabaseModel for YAML output.
 * This creates a properly structured database configuration.
 */
function formatDatabaseRef(database: DatabaseModel, basePath?: string): any {
  const db: any = {
    name: database.name,
  };
  
  // NOTE: type field removed in dao-ai 0.1.2
  // Type is inferred from: instance_name → Lakebase, host → PostgreSQL
  
  // Lakebase-specific fields
  if (database.instance_name) db.instance_name = database.instance_name;
  
  // PostgreSQL-specific fields
  if (database.host) {
    db.host = formatCredentialWithPath(database.host, basePath ? `${basePath}.host` : undefined);
  }
  
  // Common fields
  if (database.description) db.description = database.description;
  if (database.capacity) db.capacity = database.capacity;
  if (database.max_pool_size) db.max_pool_size = database.max_pool_size;
  if (database.timeout_seconds) db.timeout_seconds = database.timeout_seconds;
  
  // Service Principal reference (takes precedence over inline credentials)
  if (database.service_principal) {
    if (typeof database.service_principal === 'string') {
      // It's already a reference string like "*my_sp"
      if (database.service_principal.startsWith('*')) {
        db.service_principal = createReference(database.service_principal.slice(1));
      } else {
        db.service_principal = createReference(database.service_principal);
      }
      } else {
        // Check if service_principal was originally a reference
        const spPath = basePath ? `${basePath}.service_principal` : 'service_principal';
        const spRef = findOriginalReference(spPath, database.service_principal);
        if (spRef) {
          db.service_principal = createReference(spRef);
        } else {
          // It's an inline ServicePrincipalModel object
          db.service_principal = {
            client_id: formatCredentialWithPath(database.service_principal.client_id, basePath ? `${basePath}.service_principal.client_id` : undefined),
            client_secret: formatCredentialWithPath(database.service_principal.client_secret, basePath ? `${basePath}.service_principal.client_secret` : undefined),
          };
        }
      }
  } else {
    // OAuth credentials (only if no service_principal)
    // Check if these were originally references to variables
    if (database.client_id) {
      db.client_id = formatCredentialWithPath(database.client_id, basePath ? `${basePath}.client_id` : undefined);
    }
    if (database.client_secret) {
      db.client_secret = formatCredentialWithPath(database.client_secret, basePath ? `${basePath}.client_secret` : undefined);
    }
    if (database.workspace_host) {
      db.workspace_host = formatCredentialWithPath(database.workspace_host, basePath ? `${basePath}.workspace_host` : undefined);
    }
  }
  
  // User credentials
  if (database.user) {
    db.user = formatCredentialWithPath(database.user, basePath ? `${basePath}.user` : undefined);
  }
  if (database.password) {
    db.password = formatCredentialWithPath(database.password, basePath ? `${basePath}.password` : undefined);
  }
  
  // On Behalf of User flag (only for Lakebase - determined by instance_name presence)
  if (database.on_behalf_of_user && database.instance_name) {
    db.on_behalf_of_user = database.on_behalf_of_user;
  }
  
  return db;
}

/**
 * Format a credential with path context for reference lookup.
 * Checks if the value was originally a YAML reference before formatting.
 */
function formatCredentialWithPath(value: unknown, path?: string): any {
  // First check if this was originally a reference
  if (path) {
    const ref = findOriginalReference(path, value);
    if (ref) {
      return createReference(ref);
    }
  }
  
  // Fall back to regular credential formatting
  return formatCredential(value);
}

/**
 * Format authentication fields for a resource.
 * Handles service_principal, client_id, client_secret, workspace_host, and pat.
 * 
 * @param resource - The resource with auth fields
 * @param basePath - The base path for reference lookup
 * @returns Object with formatted auth fields to spread into the resource config
 */
function formatResourceAuth(resource: any, basePath?: string): Record<string, any> {
  const authFields: Record<string, any> = {};
  
  // Service Principal reference (takes precedence over inline credentials)
  if (resource.service_principal) {
    if (typeof resource.service_principal === 'string') {
      // It's already a reference string like "*my_sp"
      if (resource.service_principal.startsWith('*')) {
        authFields.service_principal = createReference(resource.service_principal.slice(1));
      } else {
        authFields.service_principal = createReference(resource.service_principal);
      }
    } else {
      // Check if service_principal was originally a reference
      const spPath = basePath ? `${basePath}.service_principal` : 'service_principal';
      const spRef = findOriginalReference(spPath, resource.service_principal);
      if (spRef) {
        authFields.service_principal = createReference(spRef);
      } else {
        // It's an inline ServicePrincipalModel object
        authFields.service_principal = {
          client_id: formatCredentialWithPath(resource.service_principal.client_id, basePath ? `${basePath}.service_principal.client_id` : undefined),
          client_secret: formatCredentialWithPath(resource.service_principal.client_secret, basePath ? `${basePath}.service_principal.client_secret` : undefined),
        };
      }
    }
  } else {
    // OAuth credentials (only if no service_principal)
    if (resource.client_id) {
      authFields.client_id = formatCredentialWithPath(resource.client_id, basePath ? `${basePath}.client_id` : undefined);
    }
    if (resource.client_secret) {
      authFields.client_secret = formatCredentialWithPath(resource.client_secret, basePath ? `${basePath}.client_secret` : undefined);
    }
    if (resource.workspace_host) {
      authFields.workspace_host = formatCredentialWithPath(resource.workspace_host, basePath ? `${basePath}.workspace_host` : undefined);
    }
    if (resource.pat) {
      authFields.pat = formatCredentialWithPath(resource.pat, basePath ? `${basePath}.pat` : undefined);
    }
  }
  
  return authFields;
}

/**
 * Format a credential that might be a raw value, env variable, secret reference, or variable reference.
 * 
 * According to dao-ai config, AnyVariable can be:
 * - str (plain string) - just output as the string value
 * - EnvironmentVariableModel - { env: "ENV_VAR_NAME" }
 * - SecretVariableModel - { scope: "...", secret: "..." }
 * - PrimitiveVariableModel - { value: "..." }
 * 
 * Input conventions:
 * - *variable_name -> YAML alias reference
 * - env:ENV_VAR_NAME -> EnvironmentVariableModel
 * - secret:scope/key -> SecretVariableModel
 * - plain string -> output as plain string (NOT wrapped in { env: })
 */
function formatCredential(value: unknown): any {
  // Handle non-string values (could be objects from resolved YAML anchors)
  if (typeof value !== 'string') {
    // Check if this object matches a defined variable
    const matchingVar = findMatchingVariable(value);
    if (matchingVar) {
      return createReference(matchingVar);
    }
    return value; // Return as-is if it's already an object
  }
  
  // Handle variable references (e.g., *client_id) - output as YAML alias
  if (value.startsWith('*')) {
    return createReference(value.slice(1));
  }
  
  // Handle environment variable reference format (env:VAR_NAME)
  if (value.startsWith('env:')) {
    return { env: value.slice(4) };
  }
  
  // Handle secret reference format (secret:scope/key)
  if (value.startsWith('secret:')) {
    const parts = value.slice(7).split('/');
    if (parts.length === 2) {
      return { scope: parts[0], secret: parts[1] };
    }
  }
  
  // Plain value - return as-is (plain strings are valid for AnyVariable)
  return value;
}

/**
 * Infer the type of a variable from its structure.
 * YAML imports may not have explicit 'type' field.
 */
function inferVariableType(variable: any): 'primitive' | 'env' | 'secret' | 'composite' {
  // First check for explicit type field
  if (variable.type) {
    return variable.type;
  }
  
  // Infer from structure
  if ('options' in variable && Array.isArray(variable.options)) {
    return 'composite';
  }
  if ('scope' in variable && 'secret' in variable) {
    return 'secret';
  }
  if ('env' in variable) {
    return 'env';
  }
  if ('value' in variable) {
    return 'primitive';
  }
  
  return 'primitive';
}

/**
 * Convert internal VariableModel to YAML-compatible format.
 * Removes the 'type' field and formats according to dao-ai schema.
 */
function formatVariable(variable: VariableModel): any {
  const varType = inferVariableType(variable);
  const varObj = variable as Record<string, any>;
  
  switch (varType) {
    case 'primitive':
      return { value: varObj.value };
    case 'env':
      return {
        env: varObj.env,
        ...(varObj.default_value !== undefined && { default_value: varObj.default_value }),
      };
    case 'secret':
      return {
        scope: varObj.scope,
        secret: varObj.secret,
        ...(varObj.default_value !== undefined && { default_value: varObj.default_value }),
      };
    case 'composite':
      const options = (varObj.options || []) as any[];
      return {
        options: options.map((opt) => formatVariable(opt as VariableModel)),
        ...(varObj.default_value !== undefined && { default_value: varObj.default_value }),
      };
    default:
      return variable;
  }
}

export function generateYAML(config: AppConfig): string {
  const yamlConfig: any = {};
  
  // Version (at the very top)
  if (config.version) {
    yamlConfig.version = config.version;
  }
  
  // Clear and set section-level anchor overrides from config
  clearSectionAnchors();
  
  // Set memory section anchor from config.memory.refName if present
  if (config.memory?.refName) {
    setSectionAnchor('memory', config.memory.refName);
  }
  
  // Store defined variables and schemas for use by formatCredential and other functions to detect matching values
  _definedVariables = config.variables || {};
  _definedSchemas = config.schemas || {};
  
  // Define shared references for use throughout generation
  const definedSchemas = config.schemas || {};

  // Variables (after version, at the top of the config)
  if (config.variables && Object.keys(config.variables).length > 0) {
    yamlConfig.variables = {};
    Object.entries(config.variables).forEach(([key, variable]) => {
      yamlConfig.variables[key] = formatVariable(variable as VariableModel);
    });
  }

  // Service Principals (after variables, before schemas - they are credentials that may reference variables)
  if (config.service_principals && Object.keys(config.service_principals).length > 0) {
    yamlConfig.service_principals = {};
    Object.entries(config.service_principals).forEach(([key, sp]) => {
      yamlConfig.service_principals[key] = {
        client_id: formatCredential(sp.client_id),
        client_secret: formatCredential(sp.client_secret),
      };
    });
  }

  // Schemas
  if (config.schemas && Object.keys(config.schemas).length > 0) {
    yamlConfig.schemas = {};
    Object.entries(config.schemas).forEach(([key, schema]) => {
      yamlConfig.schemas[key] = {
        catalog_name: formatSchemaFieldValue(schema.catalog_name, `schemas.${key}.catalog_name`),
        schema_name: formatSchemaFieldValue(schema.schema_name, `schemas.${key}.schema_name`),
        ...(schema.permissions && { permissions: schema.permissions }),
      };
    });
  }

  // Resources - only add if there's at least one resource configured
  const hasResources = config.resources && (
    (config.resources.llms && Object.keys(config.resources.llms).length > 0) ||
    (config.resources.vector_stores && Object.keys(config.resources.vector_stores).length > 0) ||
    (config.resources.genie_rooms && Object.keys(config.resources.genie_rooms).length > 0) ||
    (config.resources.tables && Object.keys(config.resources.tables).length > 0) ||
    (config.resources.volumes && Object.keys(config.resources.volumes).length > 0) ||
    (config.resources.functions && Object.keys(config.resources.functions).length > 0) ||
    (config.resources.warehouses && Object.keys(config.resources.warehouses).length > 0) ||
    (config.resources.connections && Object.keys(config.resources.connections).length > 0) ||
    (config.resources.databases && Object.keys(config.resources.databases).length > 0) ||
    (config.resources.apps && Object.keys(config.resources.apps).length > 0)
  );

  if (hasResources) {
    yamlConfig.resources = {};
    
    if (config.resources!.llms && Object.keys(config.resources!.llms).length > 0) {
      yamlConfig.resources.llms = {};
      Object.entries(config.resources!.llms).forEach(([key, llm]) => {
        // Format fallbacks - convert ref: prefixed values to YAML aliases
        let formattedFallbacks: string[] | undefined;
        if (llm.fallbacks && llm.fallbacks.length > 0) {
          formattedFallbacks = llm.fallbacks.map(f => {
            if (typeof f === 'string' && f.startsWith('ref:')) {
              // Reference to another configured LLM - use YAML alias
              return createReference(f.slice(4));
            }
            return typeof f === 'string' ? f : f.name;
          });
        }
        
        yamlConfig.resources.llms[key] = {
          name: llm.name,
          ...(llm.description && { description: llm.description }),
          ...(llm.temperature !== undefined && { temperature: llm.temperature }),
          ...(llm.max_tokens !== undefined && { max_tokens: llm.max_tokens }),
          ...(llm.on_behalf_of_user !== undefined && { on_behalf_of_user: llm.on_behalf_of_user }),
          ...(llm.use_responses_api !== undefined && { use_responses_api: llm.use_responses_api }),
          ...(formattedFallbacks && formattedFallbacks.length > 0 && { fallbacks: formattedFallbacks }),
          ...formatResourceAuth(llm, `resources.llms.${key}`),
        };
      });
    }

    if (config.resources!.vector_stores && Object.keys(config.resources!.vector_stores).length > 0) {
      const definedVolumes = config.resources!.volumes || {};
      yamlConfig.resources.vector_stores = {};
      Object.entries(config.resources!.vector_stores).forEach(([key, vs]) => {
        
        // Format source_table with schema reference
        let sourceTable: any = undefined;
        if (vs.source_table) {
          const sourceTableSchema = formatSchemaReference(
            vs.source_table.schema, 
            definedSchemas, 
            `resources.vector_stores.${key}.source_table.schema`
          );
          sourceTable = {
            ...(sourceTableSchema && { schema: sourceTableSchema }),
            ...(vs.source_table.name && { name: vs.source_table.name }),
          };
        }
        
        // Format index with schema reference
        let index: any = undefined;
        if (vs.index && vs.index.name) {
          const indexSchema = formatSchemaReference(
            vs.index.schema, 
            definedSchemas, 
            `resources.vector_stores.${key}.index.schema`
          );
          index = {
            ...(indexSchema && { schema: indexSchema }),
            name: vs.index.name,
          };
        }
        
        // Format embedding_model - check for original reference
        let embeddingModel: any = undefined;
        if (vs.embedding_model) {
          const embeddingRef = findOriginalReference(`resources.vector_stores.${key}.embedding_model`, vs.embedding_model);
          if (embeddingRef) {
            embeddingModel = createReference(embeddingRef);
          } else {
            embeddingModel = vs.embedding_model;
          }
        }
        
        yamlConfig.resources.vector_stores[key] = {
          // Index is always included (required for both modes)
          ...(index && { index: index }),
          // Provisioning mode fields - only include if specified
          ...(sourceTable && { source_table: sourceTable }),
          ...(vs.embedding_source_column && { embedding_source_column: vs.embedding_source_column }),
          ...(embeddingModel && { embedding_model: embeddingModel }),
          ...(vs.endpoint && vs.endpoint.name && { endpoint: vs.endpoint }),
          // Optional fields for both modes
          ...(vs.primary_key && { primary_key: vs.primary_key }),
          ...(vs.columns && vs.columns.length > 0 && { columns: vs.columns }),
          ...(vs.doc_uri && { doc_uri: vs.doc_uri }),
          ...(vs.source_path && { source_path: formatVolumePath(vs.source_path, definedVolumes) }),
          ...(vs.checkpoint_path && { checkpoint_path: formatVolumePath(vs.checkpoint_path, definedVolumes) }),
          ...(vs.on_behalf_of_user !== undefined && { on_behalf_of_user: vs.on_behalf_of_user }),
          ...formatResourceAuth(vs, `resources.vector_stores.${key}`),
        };
      });
    }

    if (config.resources!.genie_rooms && Object.keys(config.resources!.genie_rooms).length > 0) {
      yamlConfig.resources.genie_rooms = {};
      Object.entries(config.resources!.genie_rooms).forEach(([key, room]) => {
        // Handle space_id which can be a string, variable reference, or VariableValue object
        let spaceIdValue: unknown = room.space_id;
        
        if (typeof room.space_id === 'string') {
          // String value - check if it's a variable reference (starts with *)
          if (safeStartsWith(room.space_id, '*')) {
            spaceIdValue = createReference(room.space_id.substring(1));
          }
        } else if (typeof room.space_id === 'object' && room.space_id !== null) {
          // VariableValue object - pass through as-is (env, secret, primitive)
          spaceIdValue = room.space_id;
        }
        
        yamlConfig.resources.genie_rooms[key] = {
          name: room.name,
          space_id: spaceIdValue,
          ...(room.description && { description: room.description }),
          ...(room.on_behalf_of_user !== undefined && { on_behalf_of_user: room.on_behalf_of_user }),
          ...formatResourceAuth(room, `resources.genie_rooms.${key}`),
        };
      });
    }

    if (config.resources!.tables && Object.keys(config.resources!.tables).length > 0) {
      yamlConfig.resources.tables = {};
      Object.entries(config.resources!.tables).forEach(([key, table]) => {
        const schemaRef = formatSchemaReference(table.schema, definedSchemas, `resources.tables.${key}.schema`);
        yamlConfig.resources.tables[key] = {
          ...(schemaRef && { schema: schemaRef }),
          ...(table.name && { name: table.name }),
          ...(table.on_behalf_of_user !== undefined && { on_behalf_of_user: table.on_behalf_of_user }),
          ...formatResourceAuth(table, `resources.tables.${key}`),
        };
      });
    }

    if (config.resources!.volumes && Object.keys(config.resources!.volumes).length > 0) {
      yamlConfig.resources.volumes = {};
      Object.entries(config.resources!.volumes).forEach(([key, volume]) => {
        const schemaRef = formatSchemaReference(volume.schema, definedSchemas, `resources.volumes.${key}.schema`);
        yamlConfig.resources.volumes[key] = {
          name: volume.name,
          ...(schemaRef && { schema: schemaRef }),
          ...(volume.on_behalf_of_user !== undefined && { on_behalf_of_user: volume.on_behalf_of_user }),
        };
      });
    }

    if (config.resources!.functions && Object.keys(config.resources!.functions).length > 0) {
      yamlConfig.resources.functions = {};
      Object.entries(config.resources!.functions).forEach(([key, func]) => {
        const schemaRef = formatSchemaReference(func.schema, definedSchemas, `resources.functions.${key}.schema`);
        yamlConfig.resources.functions[key] = {
          ...(schemaRef && { schema: schemaRef }),
          ...(func.name && { name: func.name }),
          ...(func.on_behalf_of_user !== undefined && { on_behalf_of_user: func.on_behalf_of_user }),
        };
      });
    }

    if (config.resources!.warehouses && Object.keys(config.resources!.warehouses).length > 0) {
      yamlConfig.resources.warehouses = {};
      Object.entries(config.resources!.warehouses).forEach(([key, warehouse]) => {
        let warehouseIdValue: unknown = warehouse.warehouse_id;

        if (typeof warehouse.warehouse_id === 'string') {
          if (safeStartsWith(warehouse.warehouse_id, '*')) {
            warehouseIdValue = createReference(warehouse.warehouse_id.substring(1));
          }
        } else if (typeof warehouse.warehouse_id === 'object' && warehouse.warehouse_id !== null) {
          warehouseIdValue = warehouse.warehouse_id;
        }
        
        yamlConfig.resources.warehouses[key] = {
          name: warehouse.name,
          warehouse_id: warehouseIdValue,
          ...(warehouse.description && { description: warehouse.description }),
          ...(warehouse.on_behalf_of_user !== undefined && { on_behalf_of_user: warehouse.on_behalf_of_user }),
          ...formatResourceAuth(warehouse, `resources.warehouses.${key}`),
        };
      });
    }

    if (config.resources!.connections && Object.keys(config.resources!.connections).length > 0) {
      yamlConfig.resources.connections = {};
      Object.entries(config.resources!.connections).forEach(([key, connection]) => {
        yamlConfig.resources.connections[key] = {
          name: connection.name,
          ...(connection.on_behalf_of_user !== undefined && { on_behalf_of_user: connection.on_behalf_of_user }),
          ...formatResourceAuth(connection, `resources.connections.${key}`),
        };
      });
    }

    if (config.resources!.databases && Object.keys(config.resources!.databases).length > 0) {
      yamlConfig.resources.databases = {};
      Object.entries(config.resources!.databases).forEach(([key, database]) => {
        yamlConfig.resources.databases[key] = formatDatabaseRef(database, `resources.databases.${key}`);
      });
    }

    if (config.resources!.apps && Object.keys(config.resources!.apps).length > 0) {
      yamlConfig.resources.apps = {};
      Object.entries(config.resources!.apps).forEach(([key, app]) => {
        // Note: URL is not included as it's dynamically retrieved at runtime from the workspace
        yamlConfig.resources.apps[key] = {
          name: app.name,
          ...(app.on_behalf_of_user !== undefined && { on_behalf_of_user: app.on_behalf_of_user }),
          ...formatResourceAuth(app, `resources.apps.${key}`),
        };
      });
    }
  }

  // Retrievers
  if (config.retrievers && Object.keys(config.retrievers).length > 0) {
    yamlConfig.retrievers = {};
    Object.entries(config.retrievers).forEach(([key, retriever]) => {
      // First check if vector_store was originally a reference in imported YAML
      let vectorStoreRef: string | undefined;
      const originalVsRef = findOriginalReference(`retrievers.${key}.vector_store`, retriever.vector_store);
      if (originalVsRef) {
        vectorStoreRef = createReference(originalVsRef);
      } else {
        // Try to find a matching vector store reference by matching properties
        const vectorStores = config.resources?.vector_stores || {};
        const matchedVsKey = Object.entries(vectorStores).find(
          ([, vs]) => 
            vs.embedding_source_column === retriever.vector_store?.embedding_source_column &&
            vs.source_table?.name === retriever.vector_store?.source_table?.name
        )?.[0];
        
        if (matchedVsKey) {
          vectorStoreRef = createReference(matchedVsKey);
        }
      }
      
      const retrieverConfig: Record<string, any> = {
        vector_store: vectorStoreRef || retriever.vector_store,
      };
      
      if (retriever.columns && retriever.columns.length > 0) {
        retrieverConfig.columns = retriever.columns;
      }
      
      if (retriever.search_parameters) {
        const searchParams: Record<string, any> = {
          num_results: retriever.search_parameters.num_results || 10,
          query_type: retriever.search_parameters.query_type || 'ANN',
        };
        // Only include filters if they have entries
        if (retriever.search_parameters.filters && Object.keys(retriever.search_parameters.filters).length > 0) {
          searchParams.filters = retriever.search_parameters.filters;
        }
        retrieverConfig.search_parameters = searchParams;
      }
      
      // Handle rerank configuration (FlashRank/Databricks only - no instruction_aware)
      if (retriever.rerank) {
        if (typeof retriever.rerank === 'boolean') {
          retrieverConfig.rerank = retriever.rerank;
        } else {
          const rerankConfig: Record<string, any> = {
            ...(retriever.rerank.model && { model: retriever.rerank.model }),
            ...(retriever.rerank.top_n !== undefined && { top_n: retriever.rerank.top_n }),
            ...(retriever.rerank.cache_dir && { cache_dir: retriever.rerank.cache_dir }),
            ...(retriever.rerank.columns && retriever.rerank.columns.length > 0 && { columns: retriever.rerank.columns }),
          };
          
          retrieverConfig.rerank = rerankConfig;
        }
      }

      // Handle instructed retrieval configuration (nested decomposition, rerank, router, verifier)
      // In dao-ai 0.1.24+, columns is required and is the single source of truth for schema context
      if (retriever.instructed) {
        const instructedConfig: Record<string, any> = {};
        
        // columns is required - always include it
        instructedConfig.columns = retriever.instructed.columns.map(col => ({
          name: col.name,
          ...(col.type && { type: col.type }),
          ...(col.operators && col.operators.length > 0 && { operators: col.operators }),
          ...(col.description && { description: col.description }),
        }));
        
        if (retriever.instructed.constraints && retriever.instructed.constraints.length > 0) {
          instructedConfig.constraints = retriever.instructed.constraints;
        }
        
        // Handle nested decomposition configuration
        if (retriever.instructed.decomposition) {
          const decompositionConfig: Record<string, any> = {};
          
          if (retriever.instructed.decomposition.model) {
            const modelRef = typeof retriever.instructed.decomposition.model === 'string'
              ? retriever.instructed.decomposition.model
              : retriever.instructed.decomposition.model?.name;
            if (modelRef) {
              const llmRef = findOriginalReference(`retrievers.${key}.instructed.decomposition.model`, retriever.instructed.decomposition.model);
              decompositionConfig.model = llmRef ? createReference(llmRef) : createReference(modelRef);
            }
          }
          
          if (retriever.instructed.decomposition.normalize_filter_case) {
            decompositionConfig.normalize_filter_case = retriever.instructed.decomposition.normalize_filter_case;
          }
          
          if (retriever.instructed.decomposition.max_subqueries !== undefined && retriever.instructed.decomposition.max_subqueries !== 3) {
            decompositionConfig.max_subqueries = retriever.instructed.decomposition.max_subqueries;
          }
          
          if (retriever.instructed.decomposition.rrf_k !== undefined && retriever.instructed.decomposition.rrf_k !== 60) {
            decompositionConfig.rrf_k = retriever.instructed.decomposition.rrf_k;
          }
          
          if (retriever.instructed.decomposition.examples && retriever.instructed.decomposition.examples.length > 0) {
            decompositionConfig.examples = retriever.instructed.decomposition.examples;
          }
          
          if (Object.keys(decompositionConfig).length > 0) {
            instructedConfig.decomposition = decompositionConfig;
          }
        }
        
        // Handle instruction-aware reranking (nested under instructed.rerank)
        if (retriever.instructed.rerank) {
          const iaConfig: Record<string, any> = {};
          if (retriever.instructed.rerank.model) {
            const modelRef = typeof retriever.instructed.rerank.model === 'string'
              ? retriever.instructed.rerank.model
              : retriever.instructed.rerank.model?.name;
            if (modelRef) {
              const llmRef = findOriginalReference(`retrievers.${key}.instructed.rerank.model`, retriever.instructed.rerank.model);
              iaConfig.model = llmRef ? createReference(llmRef) : createReference(modelRef);
            }
          }
          if (retriever.instructed.rerank.instructions) {
            iaConfig.instructions = retriever.instructed.rerank.instructions;
          }
          if (retriever.instructed.rerank.top_n !== undefined) {
            iaConfig.top_n = retriever.instructed.rerank.top_n;
          }
          if (Object.keys(iaConfig).length > 0) {
            instructedConfig.rerank = iaConfig;
          }
        }
        
        // Handle router configuration (nested under instructed.router)
        if (retriever.instructed.router) {
          const routerConfig: Record<string, any> = {};
          if (retriever.instructed.router.model) {
            const modelRef = typeof retriever.instructed.router.model === 'string' 
              ? retriever.instructed.router.model 
              : retriever.instructed.router.model?.name;
            if (modelRef) {
              const llmRef = findOriginalReference(`retrievers.${key}.instructed.router.model`, retriever.instructed.router.model);
              routerConfig.model = llmRef ? createReference(llmRef) : createReference(modelRef);
            }
          }
          if (retriever.instructed.router.default_mode) {
            routerConfig.default_mode = retriever.instructed.router.default_mode;
          }
          if (retriever.instructed.router.auto_bypass !== undefined) {
            routerConfig.auto_bypass = retriever.instructed.router.auto_bypass;
          }
          if (Object.keys(routerConfig).length > 0) {
            instructedConfig.router = routerConfig;
          }
        }
        
        // Handle verifier configuration (nested under instructed.verifier)
        if (retriever.instructed.verifier) {
          const verifierConfig: Record<string, any> = {};
          
          if (retriever.instructed.verifier.model) {
            const modelRef = typeof retriever.instructed.verifier.model === 'string'
              ? retriever.instructed.verifier.model
              : retriever.instructed.verifier.model?.name;
            if (modelRef) {
              const llmRef = findOriginalReference(`retrievers.${key}.instructed.verifier.model`, retriever.instructed.verifier.model);
              verifierConfig.model = llmRef ? createReference(llmRef) : createReference(modelRef);
            }
          }
          
          if (retriever.instructed.verifier.on_failure) {
            verifierConfig.on_failure = retriever.instructed.verifier.on_failure;
          }
          
          if (retriever.instructed.verifier.max_retries !== undefined) {
            verifierConfig.max_retries = retriever.instructed.verifier.max_retries;
          }
          
          if (Object.keys(verifierConfig).length > 0) {
            instructedConfig.verifier = verifierConfig;
          }
        }
        
        retrieverConfig.instructed = instructedConfig;
      }
      
      yamlConfig.retrievers[key] = retrieverConfig;
    });
  }

  // Tools
  if (config.tools && Object.keys(config.tools).length > 0) {
    const definedConnections = config.resources?.connections || {};
    const definedApps = config.resources?.apps || {};
    yamlConfig.tools = {};
    Object.entries(config.tools).forEach(([key, tool]) => {
      yamlConfig.tools[key] = {
        name: tool.name,
        function: formatToolFunction(tool.function, key, definedConnections, definedApps),
      };
    });
  }

  // Guardrails
  if (config.guardrails && Object.keys(config.guardrails).length > 0) {
    const definedLLMs = config.resources?.llms || {};
    yamlConfig.guardrails = {};
    Object.entries(config.guardrails).forEach(([key, guardrail]) => {
      yamlConfig.guardrails[key] = {
        name: guardrail.name,
        model: formatModelReference(guardrail.model, definedLLMs, `guardrails.${key}.model`),
        prompt: guardrail.prompt,
        ...(guardrail.num_retries !== undefined && { num_retries: guardrail.num_retries }),
        ...(guardrail.fail_open !== undefined && { fail_open: guardrail.fail_open }),
        ...(guardrail.max_context_length !== undefined && { max_context_length: guardrail.max_context_length }),
      };
    });
  }

  // Memory - Note: refName is only for UI anchor tracking, not included in output
  if (config.memory) {
    yamlConfig.memory = {};
    // Explicitly do NOT include refName - it's only for internal anchor tracking
    
    if (config.memory.checkpointer) {
      // Check if database was originally a reference
      let checkpointerDatabase: any = undefined;
      if (config.memory.checkpointer.database) {
        const dbRef = findOriginalReference('memory.checkpointer.database', config.memory.checkpointer.database);
        if (dbRef) {
          checkpointerDatabase = createReference(dbRef);
        } else {
          // Also check if it matches a defined database by instance_name
          const definedDatabases = config.resources?.databases || {};
          const matchingDbKey = Object.entries(definedDatabases).find(
            ([, db]) => (db as DatabaseModel).instance_name === config.memory?.checkpointer?.database?.instance_name
          )?.[0];
          if (matchingDbKey) {
            checkpointerDatabase = createReference(matchingDbKey);
          } else {
            checkpointerDatabase = formatDatabaseRef(config.memory.checkpointer.database, 'memory.checkpointer.database');
          }
        }
      }
      
      // NOTE: type field removed in dao-ai 0.1.2
      // Storage type is inferred: database provided → postgres, no database → memory
      yamlConfig.memory.checkpointer = {
        name: config.memory.checkpointer.name,
        ...(checkpointerDatabase && { database: checkpointerDatabase }),
      };
    }
    
    if (config.memory.store) {
      // Check if database was originally a reference
      let storeDatabase: any = undefined;
      if (config.memory.store.database) {
        const dbRef = findOriginalReference('memory.store.database', config.memory.store.database);
        if (dbRef) {
          storeDatabase = createReference(dbRef);
        } else {
          // Also check if it matches a defined database by instance_name
          const definedDatabases = config.resources?.databases || {};
          const matchingDbKey = Object.entries(definedDatabases).find(
            ([, db]) => (db as DatabaseModel).instance_name === config.memory?.store?.database?.instance_name
          )?.[0];
          if (matchingDbKey) {
            storeDatabase = createReference(matchingDbKey);
          } else {
            storeDatabase = formatDatabaseRef(config.memory.store.database, 'memory.store.database');
          }
        }
      }
      
      // Check if embedding_model was originally a reference
      let storeEmbeddingModel: any = undefined;
      if (config.memory.store.embedding_model) {
        const emRef = findOriginalReference('memory.store.embedding_model', config.memory.store.embedding_model);
        if (emRef) {
          storeEmbeddingModel = createReference(emRef);
        } else {
          // Also check if it matches a defined LLM by name
          const definedLLMs = config.resources?.llms || {};
          const matchingLlmKey = Object.entries(definedLLMs).find(
            ([, llm]) => (llm as any).name === (config.memory?.store?.embedding_model as any)?.name
          )?.[0];
          if (matchingLlmKey) {
            storeEmbeddingModel = createReference(matchingLlmKey);
          } else {
            storeEmbeddingModel = config.memory.store.embedding_model;
          }
        }
      }
      
      // NOTE: type field removed in dao-ai 0.1.2
      // Storage type is inferred: database provided → postgres, no database → memory
      yamlConfig.memory.store = {
        name: config.memory.store.name,
        ...(storeEmbeddingModel && { embedding_model: storeEmbeddingModel }),
        ...(config.memory.store.dims && { dims: config.memory.store.dims }),
        ...(storeDatabase && { database: storeDatabase }),
        ...(config.memory.store.namespace && { namespace: config.memory.store.namespace }),
      };
    }
    
    if (config.memory.extraction) {
      const ext = config.memory.extraction;
      const definedLLMs = config.resources?.llms || {};
      
      const extractionModel = ext.extraction_model
        ? formatModelReference(ext.extraction_model, definedLLMs, 'memory.extraction.extraction_model')
        : undefined;
      
      const queryModel = ext.query_model
        ? formatModelReference(ext.query_model, definedLLMs, 'memory.extraction.query_model')
        : undefined;
      
      yamlConfig.memory.extraction = {
        ...(ext.schemas && ext.schemas.length > 0 && { schemas: ext.schemas }),
        ...(ext.instructions && { instructions: ext.instructions }),
        ...(ext.auto_inject !== undefined && { auto_inject: ext.auto_inject }),
        ...(ext.auto_inject_limit !== undefined && { auto_inject_limit: ext.auto_inject_limit }),
        ...(ext.background_extraction !== undefined && { background_extraction: ext.background_extraction }),
        ...(extractionModel && { extraction_model: extractionModel }),
        ...(queryModel && { query_model: queryModel }),
      };
    }
  }

  // Prompts
  if (config.prompts && Object.keys(config.prompts).length > 0) {
    yamlConfig.prompts = {};
    Object.entries(config.prompts).forEach(([key, prompt]) => {
      // If alias is present, use alias (no version) - alias already points to a specific version
      // If no alias, use version (if available) to specify which version to use
      const hasAlias = prompt.alias && prompt.alias.trim() !== '';
      
      yamlConfig.prompts[key] = {
        name: prompt.name,
        ...(prompt.schema && { schema: formatSchemaReference(prompt.schema, definedSchemas, `prompts.${key}.schema`) }),
        ...(prompt.description && { description: prompt.description }),
        ...(prompt.default_template && { default_template: prompt.default_template }),
        ...(hasAlias && { alias: prompt.alias }),
        ...(!hasAlias && prompt.version !== undefined && { version: prompt.version }),
        ...(prompt.tags && Object.keys(prompt.tags).length > 0 && { tags: prompt.tags }),
        ...(prompt.auto_register !== undefined && { auto_register: prompt.auto_register }),
      };
    });
  }

  // Middleware
  if (config.middleware && Object.keys(config.middleware).length > 0) {
    yamlConfig.middleware = {};
    Object.entries(config.middleware).forEach(([key, mw]) => {
      // Process args, keeping arrays and objects as-is
      let processedArgs: Record<string, any> | undefined;
      if (mw.args && Object.keys(mw.args).length > 0) {
        processedArgs = {};
        Object.entries(mw.args).forEach(([argKey, argValue]) => {
          // If it's already an object or array, keep it as-is
          if (typeof argValue === 'object' && argValue !== null) {
            processedArgs![argKey] = argValue;
          } else if (typeof argValue === 'string') {
            // Try to parse as JSON for strings that look like JSON
            if ((argValue.startsWith('[') && argValue.endsWith(']')) || 
                (argValue.startsWith('{') && argValue.endsWith('}'))) {
              try {
                processedArgs![argKey] = JSON.parse(argValue);
              } catch {
                // Not valid JSON, keep as string
                processedArgs![argKey] = argValue;
              }
            } else {
              // Regular string, keep as-is
              processedArgs![argKey] = argValue;
            }
          } else {
            // Numbers, booleans, etc - keep as-is
            processedArgs![argKey] = argValue;
          }
        });
      }
      
      yamlConfig.middleware[key] = {
        name: mw.name,
        ...(processedArgs && Object.keys(processedArgs).length > 0 && { args: processedArgs }),
      };
    });
  }

  // Agents
  if (config.agents && Object.keys(config.agents).length > 0) {
    const definedLLMs = config.resources?.llms || {};
    const definedPrompts = config.prompts || {};
    const definedTools = config.tools || {};
    const definedGuardrails = config.guardrails || {};
    const definedMiddleware = config.middleware || {};
    yamlConfig.agents = {};
    Object.entries(config.agents).forEach(([key, agent]) => {
      // Format prompt - either inline string or reference to configured prompt
      let promptValue: any = agent.prompt;
      if (agent.prompt && typeof agent.prompt === 'object' && 'name' in agent.prompt) {
        // It's a PromptModel - check if it matches a configured prompt
        const promptModel = agent.prompt;
        const matchedPromptKey = Object.entries(definedPrompts).find(
          ([, p]) => p.name === promptModel.name
        )?.[0];
        if (matchedPromptKey) {
          promptValue = createReference(matchedPromptKey);
        }
      }
      
      // Format tools as references - tools should be referenced using *tool_key (YAML key, not name)
      // When the original anchor name differs from the key name, use the anchor name
      let toolsValue: string[] | undefined;
      if (agent.tools && agent.tools.length > 0) {
        toolsValue = agent.tools.map((tool, idx) => {
          // First check if this was originally a reference in imported YAML
          const originalRef = findOriginalReference(`agents.${key}.tools.${idx}`, tool);
          
          // Tools are stored as ToolModel objects - find the key by matching
          const toolObj = typeof tool === 'object' ? tool : null;
          const toolName = typeof tool === 'string' ? tool : tool.name;
          
          // Helper to get the correct reference name for a tool key
          // Uses the original anchor name if it differs from the key
          const getRefNameForKey = (toolKey: string): string => {
            const originalAnchor = getOriginalAnchorName(`tools.${toolKey}`);
            return originalAnchor || toolKey;
          };
          
          // If we found an original reference and it matches a defined tool's anchor, use it
          if (originalRef) {
            // Check if any defined tool has this as its original anchor name
            for (const [defKey] of Object.entries(definedTools)) {
              const anchorForKey = getOriginalAnchorName(`tools.${defKey}`);
              if (anchorForKey === originalRef || defKey === originalRef) {
                return createReference(originalRef);
              }
            }
          }
          
          // Strategy 1: Check if toolName is already a valid key in definedTools
          if (definedTools[toolName]) {
            return createReference(getRefNameForKey(toolName));
          }
          
          // Strategy 2: Find by deep comparison of the full tool object (most accurate)
          if (toolObj) {
            const matchedByObject = Object.entries(definedTools).find(
              ([, t]) => JSON.stringify(t) === JSON.stringify(toolObj)
            );
            if (matchedByObject) {
              return createReference(getRefNameForKey(matchedByObject[0]));
            }
          }
          
          // Strategy 3: Find the key in definedTools that matches this tool's name
          const matchedByName = Object.entries(definedTools).find(
            ([, t]) => t.name === toolName
          );
          if (matchedByName) {
            return createReference(getRefNameForKey(matchedByName[0]));
          }
          
          // Strategy 4: Partial object match - check if tool's function matches
          if (toolObj && toolObj.function) {
            const matchedByFunction = Object.entries(definedTools).find(
              ([, t]) => t.function && JSON.stringify(t.function) === JSON.stringify(toolObj.function)
            );
            if (matchedByFunction) {
              return createReference(getRefNameForKey(matchedByFunction[0]));
            }
          }
          
          // Fallback: The tool doesn't exist in definedTools - skip this reference
          // This happens when a tool was deleted but the agent still references it
          console.warn(`Could not find tool key for tool with name "${toolName}". Tool may have been deleted.`);
          return null; // Return null to filter out deleted tools
        }).filter((ref): ref is string => ref !== null);
      }
      
      // Format guardrails as references - guardrails should be referenced using *guardrail_key (YAML key)
      // When the original anchor name differs from the key name, use the anchor name
      let guardrailsValue: string[] | undefined;
      if (agent.guardrails && agent.guardrails.length > 0) {
        guardrailsValue = agent.guardrails.map((guardrail, idx) => {
          // First check if this was originally a reference in imported YAML
          const originalRef = findOriginalReference(`agents.${key}.guardrails.${idx}`, guardrail);
          
          // Guardrails are stored as GuardrailModel objects - find the key by matching
          const guardrailObj = typeof guardrail === 'object' ? guardrail : null;
          const guardrailName = typeof guardrail === 'string' ? guardrail : guardrail.name;
          
          // Helper to get the correct reference name for a guardrail key
          const getRefNameForKey = (guardrailKey: string): string => {
            const originalAnchor = getOriginalAnchorName(`guardrails.${guardrailKey}`);
            return originalAnchor || guardrailKey;
          };
          
          // If we found an original reference, try to use it
          if (originalRef) {
            for (const [defKey] of Object.entries(definedGuardrails)) {
              const anchorForKey = getOriginalAnchorName(`guardrails.${defKey}`);
              if (anchorForKey === originalRef || defKey === originalRef) {
                return createReference(originalRef);
              }
            }
          }
          
          // Strategy 1: Check if guardrailName is already a valid key in definedGuardrails
          if (definedGuardrails[guardrailName]) {
            return createReference(getRefNameForKey(guardrailName));
          }
          
          // Strategy 2: Find by deep comparison (most accurate)
          if (guardrailObj) {
            const matchedByObject = Object.entries(definedGuardrails).find(
              ([, g]) => JSON.stringify(g) === JSON.stringify(guardrailObj)
            );
            if (matchedByObject) {
              return createReference(getRefNameForKey(matchedByObject[0]));
            }
          }
          
          // Strategy 3: Find the key in definedGuardrails that matches this guardrail's name
          const matchedByName = Object.entries(definedGuardrails).find(
            ([, g]) => g.name === guardrailName
          );
          if (matchedByName) {
            return createReference(getRefNameForKey(matchedByName[0]));
          }
          
          // Fallback: The guardrail doesn't exist in definedGuardrails - skip this reference
          console.warn(`Could not find guardrail key for guardrail with name "${guardrailName}". Guardrail may have been deleted.`);
          return null;
        }).filter((ref): ref is string => ref !== null);
      }
      
      // Format middleware as references - middleware should be referenced using *middleware_key (YAML key)
      // When the original anchor name differs from the key name, use the anchor name
      let middlewareValue: string[] | undefined;
      if (agent.middleware && agent.middleware.length > 0) {
        middlewareValue = agent.middleware.map((mw, idx) => {
          // First check if this was originally a reference in imported YAML
          const originalRef = findOriginalReference(`agents.${key}.middleware.${idx}`, mw);
          
          // Middleware are stored as MiddlewareModel objects - find the key by matching name
          const mwObj = typeof mw === 'object' ? mw : null;
          const mwName = typeof mw === 'string' ? mw : mw.name;
          
          // Helper to get the correct reference name for a middleware key
          const getRefNameForKey = (mwKey: string): string => {
            const originalAnchor = getOriginalAnchorName(`middleware.${mwKey}`);
            return originalAnchor || mwKey;
          };
          
          // If we found an original reference, try to use it
          if (originalRef) {
            for (const [defKey] of Object.entries(definedMiddleware)) {
              const anchorForKey = getOriginalAnchorName(`middleware.${defKey}`);
              if (anchorForKey === originalRef || defKey === originalRef) {
                return createReference(originalRef);
              }
            }
          }
          
          // Strategy 1: Check if mwName is already a valid key in definedMiddleware
          if (definedMiddleware[mwName]) {
            return createReference(getRefNameForKey(mwName));
          }
          
          // Strategy 2: Find by deep comparison (most accurate)
          if (mwObj) {
            const matchedByObject = Object.entries(definedMiddleware).find(
              ([, m]) => JSON.stringify(m) === JSON.stringify(mwObj)
            );
            if (matchedByObject) {
              return createReference(getRefNameForKey(matchedByObject[0]));
            }
          }
          
          // Strategy 3: Find the key in definedMiddleware that matches this middleware's name
          const matchedByName = Object.entries(definedMiddleware).find(
            ([, m]) => m.name === mwName
          );
          if (matchedByName) {
            return createReference(getRefNameForKey(matchedByName[0]));
          }
          
          // Fallback: The middleware doesn't exist in definedMiddleware - skip this reference
          console.warn(`Could not find middleware key for middleware with name "${mwName}". Middleware may have been deleted.`);
          return null;
        }).filter((ref): ref is string => ref !== null);
      }
      
      // Format response_format
      let responseFormatValue: any = undefined;
      if (agent.response_format) {
        if (typeof agent.response_format === 'string') {
          // Simple mode: just the schema string
          responseFormatValue = agent.response_format;
        } else if (typeof agent.response_format === 'object') {
          // Advanced mode: ResponseFormatModel with response_schema and use_tool
          responseFormatValue = {
            ...(agent.response_format.response_schema && { response_schema: agent.response_format.response_schema }),
            ...(agent.response_format.use_tool !== null && agent.response_format.use_tool !== undefined && { use_tool: agent.response_format.use_tool }),
          };
        }
      }

      yamlConfig.agents[key] = {
        name: agent.name,
        model: formatModelReference(agent.model, definedLLMs, `agents.${key}.model`),
        ...(agent.description && { description: agent.description }),
        ...(toolsValue && toolsValue.length > 0 && { tools: toolsValue }),
        ...(guardrailsValue && guardrailsValue.length > 0 && { guardrails: guardrailsValue }),
        ...(middlewareValue && middlewareValue.length > 0 && { middleware: middlewareValue }),
        ...(promptValue && { prompt: promptValue }),
        ...(agent.handoff_prompt && { handoff_prompt: agent.handoff_prompt }),
        ...(responseFormatValue && { response_format: responseFormatValue }),
      };
    });
  }

  // App configuration - only include if it has meaningful content
  if (config.app && config.app.name && config.app.registered_model?.name) {
    // Format app.agents as references to defined agents - use YAML key (not name)
    const definedAgents = config.agents || {};
    let appAgentsValue: string[] | undefined;
    if (config.app.agents && config.app.agents.length > 0) {
      appAgentsValue = config.app.agents.map((agent, idx) => {
        // First check if this was originally a reference in imported YAML
        const originalRef = findOriginalReference(`app.agents.${idx}`, agent);
        if (originalRef && definedAgents[originalRef]) {
          return createReference(originalRef);
        }
        
        // Find the agent key by matching
        const agentObj = typeof agent === 'object' ? agent : null;
        const agentName = typeof agent === 'string' ? agent : agent.name;
        
        // Strategy 1: Check if agentName is already a valid key in definedAgents
        if (definedAgents[agentName]) {
          return createReference(agentName);
        }
        
        // Strategy 2: Find by deep comparison of the full agent object (most accurate)
        if (agentObj) {
          const matchedByObject = Object.entries(definedAgents).find(
            ([, a]) => JSON.stringify(a) === JSON.stringify(agentObj)
          );
          if (matchedByObject) {
            return createReference(matchedByObject[0]);
          }
        }
        
        // Strategy 3: Find the key in definedAgents that matches this agent's name
        const matchedByName = Object.entries(definedAgents).find(
          ([, a]) => a.name === agentName
        );
        if (matchedByName) {
          return createReference(matchedByName[0]);
        }
        
        // Strategy 4: Partial match - check if agent's model and description match
        if (agentObj && agentObj.model) {
          const matchedByModel = Object.entries(definedAgents).find(
            ([, a]) => a.model && a.name === agentName && 
              JSON.stringify(a.model) === JSON.stringify(agentObj.model)
          );
          if (matchedByModel) {
            return createReference(matchedByModel[0]);
          }
        }
        
        // Fallback: The agent doesn't exist in definedAgents - skip this reference
        console.warn(`Could not find agent key for agent with name "${agentName}". Agent may have been deleted.`);
        return null; // Return null to filter out deleted agents
      }).filter((ref): ref is string => ref !== null);
    }
    
    // Format registered_model with schema reference
    let registeredModel: any = { name: config.app.registered_model.name };
    if (config.app.registered_model.schema) {
      const regModelSchema = formatSchemaReference(
        config.app.registered_model.schema,
        definedSchemas,
        'app.registered_model.schema'
      );
      if (regModelSchema) {
        registeredModel.schema = regModelSchema;
      }
    }
    
    // Handle service_principal reference
    let appServicePrincipal: any = undefined;
    if (config.app.service_principal) {
      if (typeof config.app.service_principal === 'string') {
        // It's a reference string like "*my_sp"
        const spRef = config.app.service_principal.startsWith('*') 
          ? config.app.service_principal.slice(1) 
          : config.app.service_principal;
        appServicePrincipal = createReference(spRef);
      } else {
        // Inline service principal object
        appServicePrincipal = {
          client_id: formatCredential(config.app.service_principal.client_id),
          client_secret: formatCredential(config.app.service_principal.client_secret),
        };
      }
    }
    
    yamlConfig.app = {
      name: config.app.name,
      ...(config.app.alias && { alias: config.app.alias }),
      registered_model: registeredModel,
      ...(config.app.description && { description: config.app.description }),
      ...(config.app.log_level && { log_level: config.app.log_level }),
      ...(appServicePrincipal && { service_principal: appServicePrincipal }),
      ...(config.app.deployment_target && { deployment_target: config.app.deployment_target }),
      // Model Serving specific fields - only include if deployment_target is model_serving or not set (defaults to model_serving)
      ...((config.app.deployment_target === 'model_serving' || !config.app.deployment_target) && config.app.endpoint_name && { endpoint_name: config.app.endpoint_name }),
      ...((config.app.deployment_target === 'model_serving' || !config.app.deployment_target) && config.app.workload_size && { workload_size: config.app.workload_size }),
      ...((config.app.deployment_target === 'model_serving' || !config.app.deployment_target) && config.app.scale_to_zero !== undefined && { scale_to_zero: config.app.scale_to_zero }),
      ...(config.app.python_version && { python_version: config.app.python_version }),
      ...(config.app.budget_policy_id && { budget_policy_id: config.app.budget_policy_id }),
      ...(config.app.environment_vars && Object.keys(config.app.environment_vars).length > 0 && { 
        environment_vars: formatEnvironmentVars(config.app.environment_vars, config.variables || {}) 
      }),
      ...(config.app.tags && Object.keys(config.app.tags).length > 0 && { tags: config.app.tags }),
      ...(config.app.permissions && config.app.permissions.length > 0 && { permissions: config.app.permissions }),
      ...(config.app.initialization_hooks && config.app.initialization_hooks.length > 0 && { initialization_hooks: config.app.initialization_hooks }),
      ...(config.app.shutdown_hooks && config.app.shutdown_hooks.length > 0 && { shutdown_hooks: config.app.shutdown_hooks }),
      ...(config.app.input_example && { input_example: config.app.input_example }),
      ...(config.app.code_paths && config.app.code_paths.length > 0 && { code_paths: config.app.code_paths }),
      ...(config.app.pip_requirements && config.app.pip_requirements.length > 0 && { pip_requirements: config.app.pip_requirements }),
      ...(appAgentsValue && appAgentsValue.length > 0 && { agents: appAgentsValue }),
    };
    
    // Format orchestration separately to handle swarm handoffs properly
    if (config.app.orchestration) {
      const definedLLMs = config.resources?.llms || {};
      const definedTools = config.tools || {};
      const definedMiddleware = config.middleware || {};
      const definedAgents = config.agents || {};
      yamlConfig.app.orchestration = formatOrchestration(config.app.orchestration, definedLLMs, definedTools, definedMiddleware, definedAgents);
    }
    
    // Format chat_history
    if (config.app.chat_history) {
      const definedLLMs = config.resources?.llms || {};
      yamlConfig.app.chat_history = {
        model: formatModelReference(config.app.chat_history.model, definedLLMs, 'app.chat_history.model'),
        max_tokens: config.app.chat_history.max_tokens,
        ...(config.app.chat_history.max_tokens_before_summary && { 
          max_tokens_before_summary: config.app.chat_history.max_tokens_before_summary 
        }),
        ...(config.app.chat_history.max_messages_before_summary && { 
          max_messages_before_summary: config.app.chat_history.max_messages_before_summary 
        }),
      };
    }
  }

  // Generate YAML string
  let yamlString = yaml.dump(yamlConfig, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });

  // Add YAML anchors (&anchor_name) to resource definitions
  yamlString = addYamlAnchors(yamlString);
  
  // Convert reference markers to YAML aliases (*alias_name)
  yamlString = convertReferencesToAliases(yamlString);
  
  // Quote wildcard patterns in tool filters to prevent YAML alias interpretation
  yamlString = quoteWildcardPatterns(yamlString);

  // Ensure all operator values (e.g. <, <=, >, >=) are consistently double-quoted
  yamlString = quoteOperatorValues(yamlString);
  
  return yamlString;
}

export function downloadYAML(config: AppConfig, filename: string = 'model_config.yaml') {
  const yamlContent = generateYAML(config);
  const blob = new Blob([yamlContent], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

