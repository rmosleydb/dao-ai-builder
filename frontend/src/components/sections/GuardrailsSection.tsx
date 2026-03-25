import { useState, ChangeEvent } from 'react';
import { Plus, Trash2, Shield, Sparkles, Loader2, Pencil } from 'lucide-react';
import { useConfigStore } from '@/stores/configStore';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Textarea from '../ui/Textarea';
import Card from '../ui/Card';
import Modal from '../ui/Modal';
import Badge from '../ui/Badge';
import { normalizeRefNameWhileTyping } from '@/utils/name-utils';
import { safeDelete } from '@/utils/safe-delete';
import { useYamlScrollStore } from '@/stores/yamlScrollStore';
import { GuardrailMode } from '@/types/dao-ai-types';

async function generateGuardrailPromptWithAI(params: {
  context?: string;
  guardrail_name?: string;
  evaluation_criteria?: string[];
  existing_prompt?: string;
}): Promise<string> {
  const response = await fetch('/api/ai/generate-guardrail-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to generate guardrail prompt');
  }
  
  const data = await response.json();
  return data.prompt;
}

const COMMON_CRITERIA = [
  { value: 'accuracy', label: 'Accuracy' },
  { value: 'completeness', label: 'Completeness' },
  { value: 'clarity', label: 'Clarity' },
  { value: 'helpfulness', label: 'Helpfulness' },
  { value: 'safety', label: 'Safety' },
  { value: 'relevance', label: 'Relevance' },
  { value: 'tone', label: 'Professional Tone' },
  { value: 'no_hallucination', label: 'No Hallucination' },
  { value: 'pii_protection', label: 'PII Protection' },
  { value: 'bias_free', label: 'Bias-Free' },
];

const DEFAULT_GUARDRAIL_PROMPT = `You are an expert judge evaluating AI responses. Your task is to critique the AI assistant's latest response in the conversation below.

Evaluate the response based on these criteria:
1. Accuracy - Is the information correct and factual?
2. Completeness - Does it fully address the user's query?
3. Clarity - Is the explanation clear and well-structured?
4. Helpfulness - Does it provide actionable and useful information?
5. Safety - Does it avoid harmful or inappropriate content?

If the response meets ALL criteria satisfactorily, set pass to True.

If you find ANY issues with the response, do NOT set pass to True. Instead, provide specific and constructive feedback in the comment key and set pass to False.

### Inputs:
{inputs}

### Response:
{outputs}`;

const APPLY_TO_OPTIONS = [
  { value: 'both', label: 'Both (input + output)' },
  { value: 'input', label: 'Input only' },
  { value: 'output', label: 'Output only' },
];

function detectGuardrailMode(guardrail: { scorer?: string; model?: any; prompt?: string }): GuardrailMode {
  if (guardrail.scorer) return 'scorer';
  return 'llm_judge';
}

export default function GuardrailsSection() {
  const { config, addGuardrail, updateGuardrail, removeGuardrail } = useConfigStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [guardrailMode, setGuardrailMode] = useState<GuardrailMode>('llm_judge');
  const [formData, setFormData] = useState({
    refName: '',
    name: '',
    // LLM Judge fields
    modelKey: '',
    prompt: DEFAULT_GUARDRAIL_PROMPT,
    // Scorer fields
    scorer: '',
    scorerArgs: '' as string,
    hub: '',
    // Common fields
    numRetries: '3',
    failOnError: false,
    maxContextLength: '8000',
    applyTo: 'both' as 'input' | 'output' | 'both',
  });
  const [refNameManuallyEdited, setRefNameManuallyEdited] = useState(false);
  
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [aiContext, setAiContext] = useState('');
  const [showAiInput, setShowAiInput] = useState(false);
  const [selectedCriteria, setSelectedCriteria] = useState<string[]>(['accuracy', 'completeness', 'clarity', 'helpfulness', 'safety']);
  const [customCriterion, setCustomCriterion] = useState('');

  const handleGeneratePrompt = async (improveExisting = false) => {
    setIsGeneratingPrompt(true);
    try {
      const prompt = await generateGuardrailPromptWithAI({
        context: aiContext || undefined,
        guardrail_name: formData.name || undefined,
        evaluation_criteria: selectedCriteria.length > 0 ? selectedCriteria : undefined,
        existing_prompt: improveExisting ? formData.prompt : undefined,
      });
      
      setFormData({ ...formData, prompt });
      setShowAiInput(false);
      setAiContext('');
    } catch (error) {
      console.error('Failed to generate guardrail prompt:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate guardrail prompt');
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  const addCustomCriterion = () => {
    if (customCriterion && !selectedCriteria.includes(customCriterion)) {
      setSelectedCriteria([...selectedCriteria, customCriterion]);
      setCustomCriterion('');
    }
  };

  const guardrails = config.guardrails || {};
  const llms = config.resources?.llms || {};

  const resetForm = () => {
    setFormData({
      refName: '',
      name: '',
      modelKey: '',
      prompt: DEFAULT_GUARDRAIL_PROMPT,
      scorer: '',
      scorerArgs: '',
      hub: '',
      numRetries: '3',
      failOnError: false,
      maxContextLength: '8000',
      applyTo: 'both',
    });
    setEditingKey(null);
    setGuardrailMode('llm_judge');
    setShowAiInput(false);
    setAiContext('');
    setSelectedCriteria(['accuracy', 'completeness', 'clarity', 'helpfulness', 'safety']);
    setRefNameManuallyEdited(false);
  };

  const { scrollToAsset } = useYamlScrollStore();

  const handleEdit = (key: string, guardrail: { name: string; model?: any; prompt?: string; scorer?: string; scorer_args?: Record<string, any>; hub?: string; num_retries?: number; fail_on_error?: boolean; max_context_length?: number; apply_to?: 'input' | 'output' | 'both' }) => {
    scrollToAsset(key);
    setEditingKey(key);
    setRefNameManuallyEdited(true);
    
    const mode = detectGuardrailMode(guardrail);
    setGuardrailMode(mode);
    
    let llmKey = '';
    if (mode === 'llm_judge' && guardrail.model) {
      const modelName = typeof guardrail.model === 'string' ? guardrail.model : guardrail.model.name;
      llmKey = Object.entries(llms).find(([, llm]) => llm.name === modelName)?.[0] || '';
    }
    
    setFormData({
      refName: key,
      name: guardrail.name,
      modelKey: llmKey,
      prompt: guardrail.prompt || DEFAULT_GUARDRAIL_PROMPT,
      scorer: guardrail.scorer || '',
      scorerArgs: guardrail.scorer_args ? JSON.stringify(guardrail.scorer_args, null, 2) : '',
      hub: guardrail.hub || '',
      numRetries: String(guardrail.num_retries ?? 3),
      failOnError: guardrail.fail_on_error === true,
      maxContextLength: String(guardrail.max_context_length ?? 8000),
      applyTo: guardrail.apply_to || 'both',
    });
    
    setIsModalOpen(true);
  };

  const llmOptions = Object.entries(llms).map(([key, llm]) => ({
    value: key,
    label: `${key} (${llm.name})`,
  }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.refName.trim() || !formData.name.trim()) return;
    
    if (guardrailMode === 'llm_judge') {
      if (!formData.modelKey || !llms[formData.modelKey]) return;
      
      const guardrailConfig = {
        name: formData.name,
        model: llms[formData.modelKey],
        prompt: formData.prompt,
        num_retries: parseInt(formData.numRetries),
        fail_on_error: formData.failOnError,
        max_context_length: parseInt(formData.maxContextLength),
        apply_to: formData.applyTo as 'input' | 'output' | 'both',
      };
      
      const refName = formData.refName.trim();
      if (editingKey && editingKey !== refName) {
        removeGuardrail(editingKey);
        addGuardrail(refName, guardrailConfig);
      } else if (editingKey) {
        updateGuardrail(refName, guardrailConfig);
      } else {
        addGuardrail(refName, guardrailConfig);
      }
    } else {
      if (!formData.scorer.trim()) return;
      
      let scorerArgs: Record<string, any> | undefined;
      if (formData.scorerArgs.trim()) {
        try {
          scorerArgs = JSON.parse(formData.scorerArgs);
        } catch {
          alert('Invalid JSON for scorer arguments');
          return;
        }
      }
      
      const guardrailConfig = {
        name: formData.name,
        scorer: formData.scorer,
        ...(scorerArgs && Object.keys(scorerArgs).length > 0 && { scorer_args: scorerArgs }),
        ...(formData.hub && { hub: formData.hub }),
        num_retries: parseInt(formData.numRetries),
        fail_on_error: formData.failOnError,
        max_context_length: parseInt(formData.maxContextLength),
        apply_to: formData.applyTo as 'input' | 'output' | 'both',
      };
      
      const refName = formData.refName.trim();
      if (editingKey && editingKey !== refName) {
        removeGuardrail(editingKey);
        addGuardrail(refName, guardrailConfig);
      } else if (editingKey) {
        updateGuardrail(refName, guardrailConfig);
      } else {
        addGuardrail(refName, guardrailConfig);
      }
    }
    
    resetForm();
    setIsModalOpen(false);
  };

  const getGuardrailSummary = (guardrail: { name: string; model?: any; prompt?: string; scorer?: string; apply_to?: string }) => {
    if (guardrail.scorer) {
      const shortScorer = guardrail.scorer.split('.').pop() || guardrail.scorer;
      return { type: 'Scorer', detail: shortScorer };
    }
    const modelName = typeof guardrail.model === 'string' ? guardrail.model : guardrail.model?.name || 'Unknown';
    return { type: 'LLM Judge', detail: modelName };
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Guardrails</h2>
          <p className="text-slate-400 mt-1">
            Configure safety checks and quality controls for agent responses
          </p>
        </div>
        <Button onClick={() => setIsModalOpen(true)}>
          <Plus className="w-4 h-4" />
          Add Guardrail
        </Button>
      </div>

      {Object.keys(guardrails).length === 0 ? (
        <Card className="text-center py-12">
          <Shield className="w-12 h-12 mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-medium text-slate-300 mb-2">No guardrails configured</h3>
          <p className="text-slate-500 mb-4">
            Guardrails help ensure agent responses are safe, accurate, and helpful.
          </p>
          <Button onClick={() => setIsModalOpen(true)}>
            <Plus className="w-4 h-4" />
            Add Your First Guardrail
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4">
          {Object.entries(guardrails).map(([key, guardrail]) => {
            const summary = getGuardrailSummary(guardrail);
            return (
              <Card 
                key={key} 
                variant="interactive" 
                className="group cursor-pointer"
                onClick={() => handleEdit(key, guardrail)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start space-x-4">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
                      <Shield className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="font-medium text-white">{key}</h3>
                      {key !== guardrail.name && (
                        <p className="text-xs text-slate-500">name: {guardrail.name}</p>
                      )}
                      <p className="text-sm text-slate-400">
                        {summary.type}: {summary.detail}
                      </p>
                      {guardrail.prompt && (
                        <p className="text-xs text-slate-500 mt-2 line-clamp-2 font-mono">
                          {guardrail.prompt.substring(0, 100)}...
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <Badge variant={guardrail.scorer ? 'info' : 'success'}>
                      {summary.type}
                    </Badge>
                    {guardrail.apply_to && guardrail.apply_to !== 'both' && (
                      <Badge variant="default">{guardrail.apply_to}</Badge>
                    )}
                    <Badge variant="success">retries: {guardrail.num_retries ?? 3}</Badge>
                    <Badge variant={guardrail.fail_on_error ? 'warning' : 'info'}>
                      fail on error: {guardrail.fail_on_error ? 'yes' : 'no'}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleEdit(key, guardrail);
                      }}
                      title="Edit guardrail"
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        safeDelete('Guardrail', key, () => removeGuardrail(key));
                      }}
                      title="Delete guardrail"
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

      <Modal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          resetForm();
        }}
        title={editingKey ? 'Edit Guardrail' : 'Add Guardrail'}
        description={editingKey ? 'Modify the guardrail configuration' : 'Configure a safety check for agent responses'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Mode Toggle */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-300">Guardrail Type</label>
            <div className="inline-flex rounded-lg bg-slate-900/50 p-0.5">
              <button
                type="button"
                onClick={() => setGuardrailMode('llm_judge')}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                  guardrailMode === 'llm_judge'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                }`}
              >
                LLM Judge
              </button>
              <button
                type="button"
                onClick={() => setGuardrailMode('scorer')}
                className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all duration-150 ${
                  guardrailMode === 'scorer'
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                    : 'text-slate-400 border border-transparent hover:text-slate-300'
                }`}
              >
                MLflow Scorer
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {guardrailMode === 'llm_judge'
                ? 'Use an LLM to judge responses with a custom evaluation prompt'
                : 'Use an MLflow Scorer class (e.g., DetectPII, ToxicLanguage) or guardrails-ai hub validator'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Reference Name"
              placeholder="e.g., llm_judge_guardrail"
              value={formData.refName}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const newRefName = normalizeRefNameWhileTyping(e.target.value);
                setFormData({ 
                  ...formData, 
                  refName: newRefName,
                  name: !refNameManuallyEdited && formData.name === formData.refName ? newRefName : formData.name,
                });
                setRefNameManuallyEdited(true);
              }}
              hint="YAML key (spaces become underscores)"
              required
            />
            <Input
              label="Guardrail Name"
              placeholder="e.g., llm_judge"
              value={formData.name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, name: e.target.value })}
              hint="The name property inside the guardrail config"
              required
            />
          </div>

          {guardrailMode === 'llm_judge' ? (
            <>
              {llmOptions.length === 0 && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-amber-400 text-sm">
                  You need to add an LLM first before creating an LLM Judge guardrail.
                </div>
              )}
              
              <Select
                label="Judge LLM"
                options={llmOptions}
                value={formData.modelKey}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, modelKey: e.target.value })}
                placeholder="Select an LLM..."
                required
              />

              {/* Evaluation Prompt with AI Assistant */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-slate-300">Evaluation Prompt</label>
                </div>
                
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowAiInput(!showAiInput)}
                    className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg font-medium bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-300 border border-purple-500/30 hover:from-purple-500/30 hover:to-pink-500/30 transition-all"
                    disabled={isGeneratingPrompt}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>AI Assistant</span>
                  </button>
                  {formData.prompt && formData.prompt !== DEFAULT_GUARDRAIL_PROMPT && (
                    <button
                      type="button"
                      onClick={() => handleGeneratePrompt(true)}
                      className="flex items-center space-x-1.5 px-3 py-1.5 text-xs rounded-lg font-medium bg-gradient-to-r from-purple-500/20 to-pink-500/20 text-purple-300 border border-purple-500/30 hover:from-purple-500/30 hover:to-pink-500/30 transition-all"
                      disabled={isGeneratingPrompt}
                    >
                      {isGeneratingPrompt ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>Improve Prompt</span>
                    </button>
                  )}
                </div>
                
                {showAiInput && (
                  <div className="p-3 bg-gradient-to-r from-purple-500/10 to-pink-500/10 rounded-lg border border-purple-500/30 space-y-3">
                    <div className="flex items-center space-x-2">
                      <Sparkles className="w-4 h-4 text-purple-400" />
                      <span className="text-sm font-medium text-purple-300">Generate Guardrail Prompt with AI</span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Describe what this guardrail should evaluate and I'll generate an optimized evaluation prompt.
                    </p>
                    <Textarea
                      value={aiContext}
                      onChange={(e) => setAiContext(e.target.value)}
                      rows={2}
                      placeholder="e.g., This guardrail should check that responses don't contain harmful content and are factually accurate for a retail customer service agent..."
                    />
                    
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-slate-400">Evaluation Criteria</label>
                      <p className="text-xs text-slate-500">
                        Select what aspects the guardrail should evaluate
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {COMMON_CRITERIA.map(criterion => (
                          <button
                            key={criterion.value}
                            type="button"
                            onClick={() => {
                              if (selectedCriteria.includes(criterion.value)) {
                                setSelectedCriteria(selectedCriteria.filter(c => c !== criterion.value));
                              } else {
                                setSelectedCriteria([...selectedCriteria, criterion.value]);
                              }
                            }}
                            className={`px-2 py-1 text-xs rounded-md transition-all ${
                              selectedCriteria.includes(criterion.value)
                                ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/50'
                                : 'bg-slate-800 text-slate-400 border border-slate-700 hover:border-slate-600'
                            }`}
                          >
                            {criterion.label}
                          </button>
                        ))}
                      </div>
                      {selectedCriteria.filter(c => !COMMON_CRITERIA.map(cc => cc.value).includes(c)).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {selectedCriteria.filter(c => !COMMON_CRITERIA.map(cc => cc.value).includes(c)).map(criterion => (
                            <span
                              key={criterion}
                              className="px-2 py-1 text-xs rounded-md bg-blue-500/30 text-blue-300 border border-blue-500/50 flex items-center space-x-1"
                            >
                              <span>{criterion}</span>
                              <button
                                type="button"
                                onClick={() => setSelectedCriteria(selectedCriteria.filter(c => c !== criterion))}
                                className="hover:text-red-300"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center space-x-2">
                        <input
                          type="text"
                          value={customCriterion}
                          onChange={(e) => setCustomCriterion(e.target.value.replace(/[^a-z0-9_\s]/gi, '').toLowerCase())}
                          placeholder="Add custom criterion..."
                          className="flex-1 px-2 py-1 text-xs bg-slate-800 border border-slate-700 rounded-md text-slate-300 placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomCriterion(); } }}
                        />
                        <button
                          type="button"
                          onClick={addCustomCriterion}
                          disabled={!customCriterion}
                          className="px-2 py-1 text-xs bg-slate-700 text-slate-300 rounded-md hover:bg-slate-600 disabled:opacity-50"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                    
                    <div className="flex justify-end space-x-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => { setShowAiInput(false); setAiContext(''); }}
                        disabled={isGeneratingPrompt}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => handleGeneratePrompt(false)}
                        disabled={isGeneratingPrompt || (selectedCriteria.length === 0 && !aiContext)}
                        className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
                      >
                        {isGeneratingPrompt ? (
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
                  value={formData.prompt}
                  onChange={(e) => setFormData({ ...formData, prompt: e.target.value })}
                  rows={12}
                  hint="Use {inputs} and {outputs} placeholders for conversation context"
                  required
                />
              </div>
            </>
          ) : (
            <>
              {/* Scorer mode fields */}
              <Input
                label="Scorer Class"
                placeholder="e.g., mlflow.genai.scorers.guardrails.DetectPII"
                value={formData.scorer}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, scorer: e.target.value })}
                hint="Fully qualified name of an MLflow Scorer class"
                required
              />

              <Textarea
                label="Scorer Arguments (JSON)"
                value={formData.scorerArgs}
                onChange={(e) => setFormData({ ...formData, scorerArgs: e.target.value })}
                rows={3}
                placeholder='e.g., {"pii_entities": ["CREDIT_CARD", "SSN"]}'
                hint="Optional keyword arguments passed to the scorer constructor"
              />

              <Input
                label="Guardrails Hub URI"
                placeholder="e.g., hub://guardrails/toxic_language"
                value={formData.hub}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setFormData({ ...formData, hub: e.target.value })}
                hint="Optional guardrails-ai hub URI for auto-installing the scorer validator"
              />
            </>
          )}

          {/* Common fields */}
          <Select
            label="Apply To"
            options={APPLY_TO_OPTIONS}
            value={formData.applyTo}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setFormData({ ...formData, applyTo: e.target.value as 'input' | 'output' | 'both' })}
            hint="When to run: before model (input), after model (output), or both"
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Number of Retries"
              type="number"
              min="0"
              max="10"
              value={formData.numRetries}
              onChange={(e) => setFormData({ ...formData, numRetries: e.target.value })}
              hint="How many times to retry if evaluation fails"
            />
            <Input
              label="Max Context Length"
              type="number"
              min="0"
              value={formData.maxContextLength}
              onChange={(e) => setFormData({ ...formData, maxContextLength: e.target.value })}
              hint="Max character length for extracted tool context (default: 8000)"
            />
          </div>

          <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
            <label className="flex items-center space-x-3 text-sm text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={formData.failOnError}
                onChange={(e) => setFormData({ ...formData, failOnError: e.target.checked })}
                className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500"
              />
              <div>
                <span className="font-medium">Fail on Error</span>
                <p className="text-xs text-slate-500 mt-0.5">
                  When enabled, block responses if the guardrail evaluation itself errors. When disabled (default), let responses through on evaluation errors.
                </p>
              </div>
            </label>
          </div>

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="secondary" type="button" onClick={() => {
              setIsModalOpen(false);
              resetForm();
            }}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={guardrailMode === 'llm_judge' ? llmOptions.length === 0 : !formData.scorer.trim()}
            >
              {editingKey ? 'Save Changes' : 'Add Guardrail'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
