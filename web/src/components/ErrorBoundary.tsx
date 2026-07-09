import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches a render-time throw anywhere below it and shows a minimal recovery UI
 * instead of unmounting the whole tree to a blank page. Reloading is the recovery: the
 * app rehydrates its route and run history from storage, so a reload lands the user
 * back where they were rather than at a dead end.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the crash for diagnostics; the UI stays a calm recovery prompt.
    console.error('The interview app hit a render error.', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-error" role="alert">
          <h1 className="title-xl" style={{ fontSize: 'clamp(30px,4vw,44px)' }}>
            Something went wrong.
          </h1>
          <p>The scene hit an unexpected error. Reloading picks up where you left off.</p>
          <button className="deliver" type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
