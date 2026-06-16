import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import commonPtBR from './locales/pt-BR/common.json';
import adminPtBR from './locales/pt-BR/admin.json';
import projectsPtBR from './locales/pt-BR/projects.json';
import chatPtBR from './locales/pt-BR/chat.json';
import agentsPtBR from './locales/pt-BR/agents.json';
import costsPtBR from './locales/pt-BR/costs.json';
import searchPtBR from './locales/pt-BR/search.json';
import telemetryPtBR from './locales/pt-BR/telemetry.json';
import docsPtBR from './locales/pt-BR/docs.json';
import designSystemsPtBR from './locales/pt-BR/designSystems.json';
import workspacePtBR from './locales/pt-BR/workspace.json';
import pluginsPtBR from './locales/pt-BR/plugins.json';
import settingsPtBR from './locales/pt-BR/settings.json';

import commonEn from './locales/en/common.json';
import adminEn from './locales/en/admin.json';
import projectsEn from './locales/en/projects.json';
import chatEn from './locales/en/chat.json';
import agentsEn from './locales/en/agents.json';
import costsEn from './locales/en/costs.json';
import searchEn from './locales/en/search.json';
import telemetryEn from './locales/en/telemetry.json';
import docsEn from './locales/en/docs.json';
import designSystemsEn from './locales/en/designSystems.json';
import workspaceEn from './locales/en/workspace.json';
import pluginsEn from './locales/en/plugins.json';
import settingsEn from './locales/en/settings.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'pt-BR': {
        common: commonPtBR,
        admin: adminPtBR,
        projects: projectsPtBR,
        chat: chatPtBR,
        agents: agentsPtBR,
        costs: costsPtBR,
        search: searchPtBR,
        telemetry: telemetryPtBR,
        docs: docsPtBR,
        designSystems: designSystemsPtBR,
        workspace: workspacePtBR,
        plugins: pluginsPtBR,
        settings: settingsPtBR,
      },
      en: {
        common: commonEn,
        admin: adminEn,
        projects: projectsEn,
        chat: chatEn,
        agents: agentsEn,
        costs: costsEn,
        search: searchEn,
        telemetry: telemetryEn,
        docs: docsEn,
        designSystems: designSystemsEn,
        workspace: workspaceEn,
        plugins: pluginsEn,
        settings: settingsEn,
      },
    },
    fallbackLng: 'pt-BR',
    defaultNS: 'common',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18n-lang',
    },
  });

export default i18n;
