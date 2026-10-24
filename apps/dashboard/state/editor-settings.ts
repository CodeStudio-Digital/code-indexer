import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_EDITOR_SETTINGS,
  mergeEditorSettings,
  type EditorSettings,
  type EditorSettingsOverride,
} from '@mcp/shared/editor-settings.js';
import type { Project } from '@mcp/api-bus/projects.js';
import { apiCall } from '../lib/api-client.js';

type Scope = 'global' | 'project';
type SettingsKey = Exclude<keyof EditorSettings, 'version'>;

interface ConfigResult { settings: EditorSettingsOverride; sources: string[] }
interface EditorSettingsState {
  global: EditorSettingsOverride;
  projects: Record<number, EditorSettingsOverride>;
  hydrated: Record<number, boolean>;
  configs: Record<string, ConfigResult>;
  setField: (scope: Scope, projectId: number, key: SettingsKey, value: EditorSettings[SettingsKey]) => Promise<void>;
  resetField: (scope: Scope, projectId: number, key: SettingsKey) => Promise<void>;
  hydrateProject: (projectId: number) => Promise<void>;
  resolveConfig: (projectId: number, file: string) => Promise<void>;
}

const configKey = (projectId: number, file: string) => `${projectId}:${file}`;
const inflightHydration = new Map<number, Promise<void>>();
const inflightConfig = new Map<string, Promise<void>>();
const EMPTY_OVERRIDE = Object.freeze({}) as EditorSettingsOverride;

export const useEditorSettingsStore = create<EditorSettingsState>()(
  persist(
    (set, get) => ({
      global: {},
      projects: {},
      hydrated: {},
      configs: {},
      setField: async (scope, projectId, key, value) => {
        if (scope === 'global') {
          set((state) => ({ global: { ...state.global, [key]: value, version: 1 } }));
          return;
        }
        const previous = get().projects[projectId] ?? {};
        const next = { ...previous, [key]: value, version: 1 } as EditorSettingsOverride;
        set((state) => ({ projects: { ...state.projects, [projectId]: next } }));
        try {
          const project = await apiCall('projects.update', { id: projectId, editor_settings: next }) as Project;
          set((state) => ({ projects: { ...state.projects, [projectId]: project.editor_settings ?? next } }));
        } catch (error) {
          set((state) => ({ projects: { ...state.projects, [projectId]: previous } }));
          throw error;
        }
      },
      resetField: async (scope, projectId, key) => {
        if (scope === 'global') {
          set((state) => {
            const next = { ...state.global };
            delete next[key];
            return { global: next };
          });
          return;
        }
        const previous = get().projects[projectId] ?? {};
        const next = { ...previous };
        delete next[key];
        set((state) => ({ projects: { ...state.projects, [projectId]: next } }));
        try { await apiCall('projects.update', { id: projectId, editor_settings: next }); }
        catch (error) {
          set((state) => ({ projects: { ...state.projects, [projectId]: previous } }));
          throw error;
        }
      },
      hydrateProject: async (projectId) => {
        if (get().hydrated[projectId]) return;
        const pending = inflightHydration.get(projectId);
        if (pending) return pending;
        const request = (async () => {
          const project = await apiCall('projects.get', { id: projectId }) as Project;
          set((state) => ({
            projects: { ...state.projects, [projectId]: project.editor_settings ?? {} },
            hydrated: { ...state.hydrated, [projectId]: true },
          }));
        })().finally(() => inflightHydration.delete(projectId));
        inflightHydration.set(projectId, request);
        return request;
      },
      resolveConfig: async (projectId, file) => {
        const key = configKey(projectId, file);
        const pending = inflightConfig.get(key);
        if (pending) return pending;
        const request = (async () => {
          const result = await apiCall<ConfigResult>('editor.resolveConfig', { projectId, file });
          set((state) => ({ configs: { ...state.configs, [key]: result } }));
        })().finally(() => inflightConfig.delete(key));
        inflightConfig.set(key, request);
        return request;
      },
    }),
    {
      name: 'mcp-ide:editor-settings',
      version: 1,
      partialize: (state) => ({ global: state.global }) as EditorSettingsState,
    },
  ),
);

export function resolveSettingsLayers(
  global: EditorSettingsOverride,
  project: EditorSettingsOverride,
  config: EditorSettingsOverride,
): EditorSettings {
  const withoutConfig = mergeEditorSettings(global, project);
  return withoutConfig.respectEditorConfig ? mergeEditorSettings(global, project, config) : withoutConfig;
}

export function getEffectiveEditorSettings(projectId: number, file: string): EditorSettings {
  const state = useEditorSettingsStore.getState();
  return resolveSettingsLayers(
    state.global,
    state.projects[projectId] ?? {},
    state.configs[configKey(projectId, file)]?.settings ?? {},
  );
}

export function useEffectiveEditorSettings(projectId: number, file: string): { settings: EditorSettings; sources: string[] } {
  const global = useEditorSettingsStore((state) => state.global);
  const project = useEditorSettingsStore((state) => state.projects[projectId] ?? EMPTY_OVERRIDE);
  const config = useEditorSettingsStore((state) => state.configs[configKey(projectId, file)]);
  const hydrateProject = useEditorSettingsStore((state) => state.hydrateProject);
  const resolveConfig = useEditorSettingsStore((state) => state.resolveConfig);
  useEffect(() => { void hydrateProject(projectId); }, [hydrateProject, projectId]);
  useEffect(() => { void resolveConfig(projectId, file); }, [file, projectId, resolveConfig]);
  return useMemo(() => ({
    settings: resolveSettingsLayers(global, project, config?.settings ?? {}),
    sources: config?.sources ?? [],
  }), [config, global, project]);
}
