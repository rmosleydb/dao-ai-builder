import { useState, useCallback } from 'react';
import { useConfigStore } from './stores/configStore';
import Sidebar from './components/layout/Sidebar';
import ConfigPanel from './components/layout/ConfigPanel';
import PreviewPanel from './components/layout/PreviewPanel';
import Header from './components/layout/Header';
import NotificationBar from './components/ui/NotificationBar';
import ResizableDivider from './components/ui/ResizableDivider';

export type ActiveSection = 'overview' | 'variables' | 'service_principals' | 'schemas' | 'resources' | 'retrievers' | 'tools' | 'guardrails' | 'middleware' | 'memory' | 'prompts' | 'agents' | 'app' | 'evaluation';

// Min/max widths for panels
const MIN_PREVIEW_WIDTH = 300;
const MAX_PREVIEW_WIDTH = 800;
const DEFAULT_PREVIEW_WIDTH = 500;

function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('overview');
  const [showPreview, setShowPreview] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(DEFAULT_PREVIEW_WIDTH);
  const { config } = useConfigStore();

  // Handle resizing - negative delta = shrink preview (expand config)
  const handlePreviewResize = useCallback((delta: number) => {
    setPreviewWidth(prev => {
      const newWidth = prev - delta; // Invert: dragging right shrinks preview
      return Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, newWidth));
    });
  }, []);

  return (
    <div className="h-screen flex flex-col bg-slate-900">
      <Header 
        showPreview={showPreview} 
        onTogglePreview={() => setShowPreview(!showPreview)} 
      />
      
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Navigation */}
        <Sidebar 
          activeSection={activeSection} 
          onSectionChange={setActiveSection}
          config={config}
        />
        
        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Config Panel */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <ConfigPanel activeSection={activeSection} onNavigate={setActiveSection} />
          </div>
          
          {/* Resizable Divider */}
          {showPreview && (
            <ResizableDivider onResize={handlePreviewResize} />
          )}
          
          {/* Preview Panel */}
          {showPreview && (
            <div 
              className="overflow-hidden flex-shrink-0"
              style={{ width: previewWidth }}
            >
              <PreviewPanel />
            </div>
          )}
        </div>
      </div>
      
      {/* Notification Bar for inline messages */}
      <NotificationBar />
    </div>
  );
}

export default App;
