import { Component, ReactNode } from 'react'
import { openFeedback } from '../../features/feedback/feedbackBus'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      const message = this.state.error.message
      return (
        <div className="min-h-[60vh] flex flex-col items-center justify-center px-4 text-center">
          <p className="text-2xl mb-2">⚠️</p>
          <p className="text-brown-dark font-semibold mb-1">Something went wrong</p>
          <p className="text-brown-muted text-sm mb-4">{message}</p>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="text-sm bg-brown-btn hover:bg-brown-btn-hover text-white px-4 py-2 rounded-lg transition-colors"
            >
              Try again
            </button>
            {/* 表单挂在 Sidebar 里,不在本 boundary 之内,所以这里崩了也打得开 */}
            <button
              onClick={() => openFeedback({ category: 'system', errorMessage: message })}
              className="text-sm border border-[#8B6344] text-brown-dark hover:bg-[#F5F0E8] px-4 py-2 rounded-lg transition-colors"
            >
              Report this problem
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
