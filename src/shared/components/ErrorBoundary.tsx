import { Component, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
          <p className="text-2xl mb-2">⚠️</p>
          <p className="text-brown-dark font-semibold mb-1">Something went wrong</p>
          <p className="text-brown-muted text-sm mb-4">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-4 py-2 rounded-lg transition-colors"
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
