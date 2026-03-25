import { 
  Database, 
  Wrench, 
  Shield, 
  Bot, 
  Settings,
  CheckCircle2,
  Circle,
  Key,
  HardDrive,
  Package,
  FileText,
  LayoutDashboard,
  Search,
  UserCheck,
  Layers,
  FlaskConical
} from 'lucide-react';
import { clsx } from 'clsx';
import { ActiveSection } from '@/App';
import { AppConfig } from '@/types/dao-ai-types';
import { useYamlScrollStore } from '@/stores/yamlScrollStore';

interface SidebarProps {
  activeSection: ActiveSection;
  onSectionChange: (section: ActiveSection) => void;
  config: AppConfig;
}

interface NavItem {
  id: ActiveSection;
  label: string;
  icon: React.ElementType;
  description: string;
  required?: boolean;
}

const navItems: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, description: 'Getting started' },
  { id: 'variables', label: 'Variables', icon: Key, description: 'Config variables' },
  { id: 'service_principals', label: 'Service Principals', icon: UserCheck, description: 'OAuth credentials' },
  { id: 'schemas', label: 'Schemas', icon: Database, description: 'Unity Catalog schemas', required: true },
  { id: 'resources', label: 'Resources', icon: Package, description: 'Databricks resources', required: true },
  { id: 'retrievers', label: 'Retrievers', icon: Search, description: 'Vector search retrievers' },
  { id: 'tools', label: 'Tools', icon: Wrench, description: 'Agent tools' },
  { id: 'guardrails', label: 'Guardrails', icon: Shield, description: 'Safety checks' },
  { id: 'middleware', label: 'Middleware', icon: Layers, description: 'Agent middleware' },
  { id: 'memory', label: 'Memory', icon: HardDrive, description: 'Persistence & storage' },
  { id: 'prompts', label: 'Prompts', icon: FileText, description: 'MLflow prompts' },
  { id: 'agents', label: 'Agents', icon: Bot, description: 'AI agents', required: true },
  { id: 'app', label: 'Application', icon: Settings, description: 'App settings & orchestration', required: true },
  { id: 'evaluation', label: 'Evaluation', icon: FlaskConical, description: 'Offline evaluation' },
];

export default function Sidebar({ activeSection, onSectionChange, config }: SidebarProps) {
  const { scrollToSection } = useYamlScrollStore();
  
  const handleSectionClick = (section: ActiveSection) => {
    onSectionChange(section);
    // Scroll YAML preview to the section (skip 'overview' as it has no YAML section)
    if (section !== 'overview') {
      scrollToSection(section);
    }
  };

  const getItemCount = (section: ActiveSection): number => {
    switch (section) {
      case 'overview':
        return 0; // Overview doesn't have a count
      case 'variables':
        return Object.keys(config.variables || {}).length;
      case 'service_principals':
        return Object.keys(config.service_principals || {}).length;
      case 'schemas':
        return Object.keys(config.schemas || {}).length;
      case 'resources':
        // Count all resource types including LLMs
        return (
          Object.keys(config.resources?.llms || {}).length +
          Object.keys(config.resources?.genie_rooms || {}).length +
          Object.keys(config.resources?.tables || {}).length +
          Object.keys(config.resources?.volumes || {}).length +
          Object.keys(config.resources?.functions || {}).length +
          Object.keys(config.resources?.warehouses || {}).length +
          Object.keys(config.resources?.connections || {}).length
        );
      case 'retrievers':
        return Object.keys(config.retrievers || {}).length;
      case 'tools':
        return Object.keys(config.tools || {}).length;
      case 'guardrails':
        return Object.keys(config.guardrails || {}).length;
      case 'middleware':
        return Object.keys(config.middleware || {}).length;
      case 'memory':
        return (config.memory?.checkpointer ? 1 : 0) + (config.memory?.store ? 1 : 0);
      case 'prompts':
        return Object.keys(config.prompts || {}).length;
      case 'agents':
        return Object.keys(config.agents || {}).length;
      case 'app':
        return config.app?.name ? 1 : 0;
      case 'evaluation':
        return config.evaluation ? 1 : 0;
      default:
        return 0;
    }
  };

  const isComplete = (section: ActiveSection): boolean => {
    const count = getItemCount(section);
    const item = navItems.find(i => i.id === section);
    if (item?.required) {
      return count > 0;
    }
    return true;
  };

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col min-h-0">
      {/* Scrollable navigation section */}
      <div className="flex-1 overflow-y-auto min-h-0 p-4">
        <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
          Configuration
        </h2>
        <nav className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const count = getItemCount(item.id);
            const complete = isComplete(item.id);
            const isActive = activeSection === item.id;

            return (
              <button
                key={item.id}
                onClick={() => handleSectionClick(item.id)}
                className={clsx(
                  'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-all duration-200',
                  isActive
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'
                )}
              >
                <div className="flex items-center space-x-3">
                  <Icon className={clsx('w-5 h-5', isActive ? 'text-blue-400' : 'text-slate-500')} />
                  <div>
                    <span className="text-sm font-medium">{item.label}</span>
                    <p className="text-xs text-slate-500">{item.description}</p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {count > 0 && (
                    <span className={clsx(
                      'px-1.5 py-0.5 text-xs rounded',
                      isActive ? 'bg-blue-500/30 text-blue-300' : 'bg-slate-700 text-slate-400'
                    )}>
                      {count}
                    </span>
                  )}
                  {item.required && (
                    complete ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <Circle className="w-4 h-4 text-amber-500" />
                    )
                  )}
                </div>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Status Summary - fixed at bottom */}
      <div className="flex-shrink-0 p-4 border-t border-slate-800">
        <div className="bg-slate-800/50 rounded-lg p-3">
          <h3 className="text-xs font-semibold text-slate-400 mb-2">Configuration Status</h3>
          <div className="space-y-1.5">
            {navItems.filter(i => i.required).map((item) => {
              const complete = isComplete(item.id);
              return (
                <div key={item.id} className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">{item.label}</span>
                  <span className={complete ? 'text-emerald-400' : 'text-amber-400'}>
                    {complete ? '✓ Ready' : '○ Required'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}

