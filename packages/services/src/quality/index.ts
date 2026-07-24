export {
  openAiCompatibleChat,
  parseRetryAfter,
  type ChatMessage,
  type ChatCallResult,
  type ChatCallOptions,
} from './llm-chat.js';

export { anthropicChat } from './llm-chat-anthropic.js';
export { geminiChat } from './llm-chat-gemini.js';
export { pickChatFn, type ChatFn } from './chat-dispatcher.js';

export {
  withChatRetry,
  isRetryableChatResult,
  errorKindFromChatResult,
  type ChatRetryOptions,
  type ChatErrorKind,
} from './chat-retry.js';

export {
  callChatWithFailover,
  type FailoverOptions,
  type FailoverResult,
} from './binding-failover.js';

export {
  bindingProblem,
  callConfiguredChat,
  coderProviderChat,
  friendlyProviderError,
  type BindingProblem,
} from './binding-chat.js';

export {
  completionCompatibility,
  completionBindingRevision,
  makeCompletionProbeStamp,
  type CompletionCompatibility,
  type CompletionProbeStamp,
  type CompletionSuitability,
} from './completion-compatibility.js';
