import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { render, screen } from '@testing-library/react';
import type { GenerationStats } from '../../../types/domain';
import { OllamaError } from '../../../types/errors';
import { useStreamStore } from '../stream.store';
import { ResponseView } from './ResponseView';

const initial = useStreamStore.getState();
beforeEach(() => {
  useStreamStore.setState(initial, true);
});

const stats: GenerationStats = {
  totalDurationMs: 2500,
  evalCount: 10,
  promptEvalCount: 4,
  tokensPerSecond: 4,
};

const renderView = (): void => {
  render(
    <FluentProvider theme={webLightTheme}>
      <ResponseView />
    </FluentProvider>,
  );
};

describe('ResponseView', () => {
  it('shows the empty state while idle', () => {
    renderView();
    expect(screen.getByText('Ready when you are')).toBeInTheDocument();
  });

  it('renders streamed text', () => {
    useStreamStore.getState().start({ model: 'm', promptId: null });
    useStreamStore.getState().appendToken('Hello\nworld');
    renderView();
    expect(screen.getByText(/Hello/)).toBeInTheDocument();
    expect(screen.getByText('Generating…')).toBeInTheDocument();
  });

  it('marks cancelled runs and keeps the partial text', () => {
    useStreamStore.getState().start({ model: 'm', promptId: null });
    useStreamStore.getState().appendToken('partial answer');
    useStreamStore.getState().cancel();
    renderView();
    expect(screen.getByText('Stopped — partial result kept.')).toBeInTheDocument();
    expect(screen.getByText('partial answer')).toBeInTheDocument();
  });

  it('announces completion (with stats) in the live region', () => {
    useStreamStore.getState().start({ model: 'm', promptId: null });
    useStreamStore.getState().appendToken('done text');
    useStreamStore.getState().complete(stats);
    renderView();
    expect(screen.getByRole('status')).toHaveTextContent('Response complete — 10 tokens.');
    expect(screen.getByText(/10 tokens · 4 tok\/s/)).toBeInTheDocument();
  });

  it('shows the error banner and keeps the partial text on failure', () => {
    useStreamStore.getState().start({ model: 'm', promptId: null });
    useStreamStore.getState().appendToken('half a thought');
    useStreamStore.getState().fail(new OllamaError('timeout', 'Ollama took too long.'));
    renderView();
    expect(screen.getByText('Generation failed')).toBeInTheDocument();
    expect(screen.getByText('Ollama took too long.')).toBeInTheDocument();
    expect(screen.getByText('half a thought')).toBeInTheDocument();
  });
});
