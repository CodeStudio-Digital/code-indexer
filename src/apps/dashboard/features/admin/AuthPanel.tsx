import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { ApiTokensPanel } from './ApiTokensPanel.js';
import { OAuthClientsPanel } from './OAuthClientsPanel.js';
import { AuditLogPanel } from './AuditLogPanel.js';

/**
 * Container for authentication-related admin surfaces:
 * API tokens · OAuth clients · Audit log.
 */
export function AuthPanel() {
  const { t } = useTranslation('admin');
  return (
    <Tabs defaultValue="api-tokens" className="space-y-4">
      <TabsList>
        <TabsTrigger value="api-tokens">{t('auth.tabs.apiTokens')}</TabsTrigger>
        <TabsTrigger value="oauth-clients">{t('auth.tabs.oauthClients')}</TabsTrigger>
        <TabsTrigger value="audit-log">{t('auth.tabs.auditLog')}</TabsTrigger>
      </TabsList>
      <TabsContent value="api-tokens"><ApiTokensPanel /></TabsContent>
      <TabsContent value="oauth-clients"><OAuthClientsPanel /></TabsContent>
      <TabsContent value="audit-log"><AuditLogPanel /></TabsContent>
    </Tabs>
  );
}
