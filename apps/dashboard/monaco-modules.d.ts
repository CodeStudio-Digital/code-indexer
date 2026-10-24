declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { initialize(overrides?: Record<string, unknown>): unknown };
}

declare module 'monaco-editor/esm/vs/basic-languages/php/php.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/java/java.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/python/python.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/rust/rust.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/go/go.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/kotlin/kotlin.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/swift/swift.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/basic-languages/dart/dart.js' {
  export const language: import('monaco-editor').languages.IMonarchLanguage;
  export const conf: import('monaco-editor').languages.LanguageConfiguration;
}

declare module 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js' {
  export function compile(languageId: string, language: import('monaco-editor').languages.IMonarchLanguage): { start: string; tokenizer: Record<string, unknown> };
}
