import { useRef, useEffect, useState } from 'react';
import embed, { VisualizationSpec, Result } from 'vega-embed';
import { BarChart3, AlertCircle } from 'lucide-react';

interface VegaLiteChartProps {
  spec: VisualizationSpec;
}

export default function VegaLiteChart({ spec }: VegaLiteChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    setError(null);

    if (resultRef.current) {
      resultRef.current.finalize();
      resultRef.current = null;
    }

    embed(containerRef.current, spec, {
      actions: { export: true, source: false, compiled: false, editor: false },
      renderer: 'svg',
      theme: 'dark',
    })
      .then((result) => {
        resultRef.current = result;
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to render chart');
      });

    return () => {
      if (resultRef.current) {
        resultRef.current.finalize();
        resultRef.current = null;
      }
    };
  }, [spec]);

  if (error) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-red-950/20 border border-red-800/50 rounded-lg text-xs text-red-300">
        <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
        <span>Chart rendering failed: {error}</span>
      </div>
    );
  }

  return (
    <div className="mt-2 w-full border border-slate-700 rounded-lg overflow-hidden bg-slate-900/50">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-700/50 bg-slate-800/30">
        <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[10px] text-slate-400 font-medium">Visualization</span>
      </div>
      <div ref={containerRef} className="w-full p-2" />
    </div>
  );
}
