import { ActiveSection } from '@/App';
import OverviewSection from '../sections/OverviewSection';
import { VariablesSection } from '../sections/VariablesSection';
import ServicePrincipalsSection from '../sections/ServicePrincipalsSection';
import SchemasSection from '../sections/SchemasSection';
import ResourcesSection from '../sections/ResourcesSection';
import RetrieversSection from '../sections/RetrieversSection';
import ToolsSection from '../sections/ToolsSection';
import GuardrailsSection from '../sections/GuardrailsSection';
import MiddlewareSection from '../sections/MiddlewareSection';
import MemorySection from '../sections/MemorySection';
import PromptsSection from '../sections/PromptsSection';
import AgentsSection from '../sections/AgentsSection';
import AppConfigSection from '../sections/AppConfigSection';
import EvaluationSection from '../sections/EvaluationSection';

interface ConfigPanelProps {
  activeSection: ActiveSection;
  onNavigate: (section: ActiveSection) => void;
}

export default function ConfigPanel({ activeSection, onNavigate }: ConfigPanelProps) {
  const renderSection = () => {
    switch (activeSection) {
      case 'overview':
        return <OverviewSection onNavigate={onNavigate} />;
      case 'variables':
        return <VariablesSection />;
      case 'service_principals':
        return <ServicePrincipalsSection />;
      case 'schemas':
        return <SchemasSection />;
      case 'resources':
        return <ResourcesSection />;
      case 'retrievers':
        return <RetrieversSection />;
      case 'tools':
        return <ToolsSection />;
      case 'guardrails':
        return <GuardrailsSection />;
      case 'middleware':
        return <MiddlewareSection />;
      case 'memory':
        return <MemorySection />;
      case 'prompts':
        return <PromptsSection />;
      case 'agents':
        return <AgentsSection />;
      case 'app':
        return <AppConfigSection />;
      case 'evaluation':
        return <EvaluationSection />;
      default:
        return null;
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-900/50">
      <div className="p-6 animate-fade-in">
        {renderSection()}
      </div>
    </div>
  );
}

