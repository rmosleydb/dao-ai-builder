import { useState, ChangeEvent } from 'react';
import { FlaskConical, Plus, Trash2, X, Save } from 'lucide-react';
import { useConfigStore } from '@/stores/configStore';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import Textarea from '../ui/Textarea';
import Card from '../ui/Card';
import { GuidelineModel, EvaluationModel, VariableValue } from '@/types/dao-ai-types';

function getVariableDisplayValue(value: VariableValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as unknown as Record<string, unknown>;
    if ('value' in obj) return String(obj.value);
    if ('env' in obj && obj.default_value !== undefined) return String(obj.default_value);
    if ('env' in obj) return `$${obj.env}`;
    if ('scope' in obj && 'secret' in obj) return `{{secrets/${obj.scope}/${obj.secret}}}`;
  }
  return '';
}

export default function EvaluationSection() {
  const { config, updateConfig } = useConfigStore();
  const schemas = config.schemas || {};
  const llms = config.resources?.llms || {};
  const evaluation = config.evaluation;

  const [enableEvaluation, setEnableEvaluation] = useState(!!evaluation);

  const [modelKey, setModelKey] = useState<string>(() => {
    if (evaluation?.model) {
      const modelName = typeof evaluation.model === 'string' ? evaluation.model : evaluation.model.name;
      const matched = Object.entries(llms).find(([, llm]) => llm.name === modelName);
      return matched ? matched[0] : '';
    }
    return '';
  });

  const [tableSchemaKey, setTableSchemaKey] = useState<string>(() => {
    if (evaluation?.table?.schema) {
      const t = evaluation.table.schema;
      const catDisplay = getVariableDisplayValue(t.catalog_name);
      const schDisplay = getVariableDisplayValue(t.schema_name);
      const matched = Object.entries(schemas).find(([, s]) =>
        getVariableDisplayValue(s.catalog_name) === catDisplay &&
        getVariableDisplayValue(s.schema_name) === schDisplay
      );
      return matched ? matched[0] : '';
    }
    return '';
  });

  const [tableName, setTableName] = useState(evaluation?.table?.name || 'evaluation');
  const [numEvals, setNumEvals] = useState(evaluation?.num_evals || 25);
  const [replace, setReplace] = useState(evaluation?.replace || false);
  const [agentDescription, setAgentDescription] = useState(evaluation?.agent_description || '');
  const [questionGuidelines, setQuestionGuidelines] = useState(evaluation?.question_guidelines || '');
  const [customInputsJson, setCustomInputsJson] = useState(
    evaluation?.custom_inputs ? JSON.stringify(evaluation.custom_inputs, null, 2) : ''
  );

  const [guidelines, setGuidelines] = useState<GuidelineModel[]>(evaluation?.guidelines || []);
  const [newGuidelineName, setNewGuidelineName] = useState('');
  const [newGuidelineText, setNewGuidelineText] = useState('');

  const llmOptions = Object.entries(llms).map(([key, llm]) => ({
    value: key,
    label: `${key} (${llm.name})`,
  }));

  const schemaOptions = Object.entries(schemas).map(([key, s]) => ({
    value: key,
    label: `${key} (${getVariableDisplayValue(s.catalog_name)}.${getVariableDisplayValue(s.schema_name)})`,
  }));

  const handleSave = () => {
    if (!enableEvaluation) {
      updateConfig({ evaluation: undefined });
      return;
    }

    if (!modelKey || !llms[modelKey]) return;

    let customInputs: Record<string, any> | undefined;
    if (customInputsJson.trim()) {
      try {
        customInputs = JSON.parse(customInputsJson);
      } catch {
        alert('Invalid JSON for custom inputs');
        return;
      }
    }

    const evalConfig: EvaluationModel = {
      model: llms[modelKey],
      table: {
        ...(tableSchemaKey && schemas[tableSchemaKey] && { schema: schemas[tableSchemaKey] }),
        name: tableName,
      },
      num_evals: numEvals,
      ...(replace && { replace }),
      ...(agentDescription && { agent_description: agentDescription }),
      ...(questionGuidelines && { question_guidelines: questionGuidelines }),
      ...(customInputs && { custom_inputs: customInputs }),
      ...(guidelines.length > 0 && { guidelines }),
    };

    updateConfig({ evaluation: evalConfig });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Evaluation</h2>
          <p className="text-slate-400 mt-1">
            Configure offline evaluation using MLflow GenAI scorers and a judge model
          </p>
        </div>
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={enableEvaluation}
            onChange={(e) => setEnableEvaluation(e.target.checked)}
            className="rounded border-slate-600 text-violet-500 focus:ring-violet-500 focus:ring-offset-slate-900"
          />
          <span className="text-sm text-slate-400">Enable</span>
        </label>
      </div>

      {!enableEvaluation ? (
        <Card className="text-center py-12">
          <FlaskConical className="w-12 h-12 mx-auto text-slate-600 mb-4" />
          <h3 className="text-lg font-medium text-slate-300 mb-2">Evaluation not configured</h3>
          <p className="text-slate-500 mb-4">
            Enable evaluation to run offline quality assessments with MLflow GenAI scorers.
          </p>
        </Card>
      ) : (
        <>
          {/* Core Settings */}
          <Card className="space-y-4">
            <h3 className="font-medium text-white">Core Settings</h3>

            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Judge Model"
                value={modelKey}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setModelKey(e.target.value)}
                options={[{ value: '', label: 'Select an LLM...' }, ...llmOptions]}
                hint="LLM for evaluation scoring"
                required
              />
              <Input
                label="Number of Evaluations"
                type="number"
                min={1}
                value={numEvals}
                onChange={(e) => setNumEvals(parseInt(e.target.value) || 25)}
                hint="Number of synthetic evaluation examples to generate"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Select
                label="Table Schema"
                value={tableSchemaKey}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => setTableSchemaKey(e.target.value)}
                options={[{ value: '', label: 'Select a schema...' }, ...schemaOptions]}
                hint="Unity Catalog schema for the evaluation table"
              />
              <Input
                label="Table Name"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                hint="Name of the evaluation dataset table"
                placeholder="e.g., evaluation"
              />
            </div>

            <div className="p-3 bg-slate-800/30 rounded-lg border border-slate-700/50">
              <label className="flex items-center space-x-3 text-sm text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-700 text-purple-500 focus:ring-purple-500"
                />
                <div>
                  <span className="font-medium">Replace Existing Data</span>
                  <p className="text-xs text-slate-500 mt-0.5">
                    When enabled, drop and recreate the evaluation table and dataset on each run
                  </p>
                </div>
              </label>
            </div>
          </Card>

          {/* Agent Description & Question Guidelines */}
          <Card className="space-y-4">
            <h3 className="font-medium text-white">Generation Context</h3>

            <Textarea
              label="Agent Description"
              value={agentDescription}
              onChange={(e) => setAgentDescription(e.target.value)}
              rows={4}
              placeholder="Describe what your agent does, its capabilities, and target audience..."
              hint="Used to generate relevant synthetic evaluation questions"
            />

            <Textarea
              label="Question Guidelines"
              value={questionGuidelines}
              onChange={(e) => setQuestionGuidelines(e.target.value)}
              rows={6}
              placeholder="Provide personas, example questions, and generation guidelines..."
              hint="Instructions for generating diverse and realistic evaluation questions"
            />
          </Card>

          {/* Custom Inputs */}
          <Card className="space-y-4">
            <h3 className="font-medium text-white">Custom Inputs</h3>
            <p className="text-sm text-slate-400">
              Additional inputs passed to the agent during evaluation (e.g., configurable session data)
            </p>
            <Textarea
              value={customInputsJson}
              onChange={(e) => setCustomInputsJson(e.target.value)}
              rows={4}
              placeholder='{"configurable": {"user_id": "eval_user"}, "session": {}}'
              hint="JSON object with custom inputs for evaluation runs"
            />
          </Card>

          {/* Guidelines */}
          <Card className="space-y-4">
            <h3 className="font-medium text-white">Evaluation Guidelines</h3>
            <p className="text-sm text-slate-400">
              Named sets of evaluation criteria for scoring agent responses
            </p>

            {guidelines.map((guideline, gIdx) => (
              <div key={gIdx} className="p-3 bg-slate-800/50 rounded-lg border border-slate-700 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-blue-400">{guideline.name}</span>
                  <button
                    type="button"
                    onClick={() => setGuidelines(guidelines.filter((_, i) => i !== gIdx))}
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
                          const updated = [...guidelines];
                          updated[gIdx] = {
                            ...updated[gIdx],
                            guidelines: updated[gIdx].guidelines.filter((_, i) => i !== tIdx),
                          };
                          setGuidelines(updated);
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
                        const updated = [...guidelines];
                        updated[gIdx] = {
                          ...updated[gIdx],
                          guidelines: [...updated[gIdx].guidelines, newGuidelineText],
                        };
                        setGuidelines(updated);
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
                    setGuidelines([...guidelines, { name: newGuidelineName, guidelines: [] }]);
                    setNewGuidelineName('');
                  }
                }}
                disabled={!newGuidelineName}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add Set
              </Button>
            </div>
          </Card>

          {/* Save */}
          <div className="flex justify-end">
            <Button onClick={handleSave} size="lg" disabled={!modelKey}>
              <Save className="w-4 h-4" />
              Save Evaluation
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
