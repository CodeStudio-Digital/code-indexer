import { useEffect, useState } from 'react';
import { useConfirm, useNotify } from '../../../components/ui/dialog-provider.js';
import {
  fetchMcpServers,
  saveMcpServer,
  deleteMcpServer,
  testMcpServer,
  type AdminMcpServer,
  type McpServerTestResult,
} from '../mcp-servers-api.js';

export function useAdminMcpServers() {
  const confirm = useConfirm();
  const notify = useNotify();
  const [servers, setServers] = useState<AdminMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, McpServerTestResult>>({});

  const load = async () => {
    setLoading(true);
    try {
      setServers(await fetchMcpServers());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (s: Partial<AdminMcpServer> & { auth_token?: string | null }) => {
    const isExisting = !!servers.find((x) => x.id === s.id);
    try {
      await saveMcpServer(s, isExisting);
      await load();
    } catch (e) {
      await notify({
        title: 'Save failed',
        description: (e as Error).message,
        variant: 'destructive',
      });
    }
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: `Delete MCP server "${id}"?`,
      description: 'This removes the server configuration. Active sessions will not be affected until restarted.',
      variant: 'destructive',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await deleteMcpServer(id);
    await load();
  };

  const test = async (id: string) => {
    setTestResults((t) => ({ ...t, [id]: { ok: false, error: 'testing…' } }));
    const result = await testMcpServer(id);
    setTestResults((t) => ({ ...t, [id]: result }));
  };

  return { servers, loading, testResults, load, save, remove, test };
}
