/**
 * Last-resort React error boundary (ARCHITECTURE.md §12). Catches render-time
 * throws after mount and shows a readable, copyable report instead of React's
 * blank unmount. Plain DOM + inline styles on purpose — it must render even
 * when Fluent or the theme layer is the thing that broke.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[GRETTA] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          boxSizing: 'border-box',
          height: '100%',
          overflow: 'auto',
          padding: 16,
          font: '13px/1.5 -apple-system, "Segoe UI", sans-serif',
          background: '#fef2f2',
          color: '#7f1d1d',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>GRETTA hit an error</div>
        <div>{error.message}</div>
        <pre
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: '#fff',
            border: '1px solid #fecaca',
            borderRadius: 4,
            padding: 8,
            margin: '12px 0',
            fontSize: 11,
            maxHeight: '45%',
            overflow: 'auto',
          }}
        >
          {error.stack ?? '(no stack trace available)'}
        </pre>
        <div style={{ marginBottom: 12 }}>
          Copy the details above when reporting this, then try reloading the pane.
        </div>
        <button
          type="button"
          onClick={() => {
            location.reload();
          }}
          style={{
            padding: '6px 14px',
            border: '1px solid #7f1d1d',
            borderRadius: 4,
            background: '#fff',
            color: '#7f1d1d',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          Reload pane
        </button>
      </div>
    );
  }
}
