/** Hosted API docs — list the user's published, shareable API documentation. */
import { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { api, ApiError, type HostedDoc } from '../lib/api.js';
import { Alert, Badge, Button, Card, CardContent, Spinner } from '../lib/ui.js';

export function ApisPage() {
  const [docs, setDocs] = useState<HostedDoc[] | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.docsList();
        setDocs(r.docs);
        setBaseUrl(r.baseUrl);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not load API docs.');
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">API docs</h1>
        <p className="text-sm text-muted-foreground">Hosted, shareable API documentation.</p>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      {!docs ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : docs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No published docs yet. Publish a collection's docs from the desktop app.
        </p>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {docs.map((doc) => (
              <div key={doc.id} className="flex items-start gap-3 p-4">
                <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{doc.title}</span>
                    {doc.visibility === 'public' ? (
                      <Badge tone="success">Public</Badge>
                    ) : (
                      <Badge tone="muted">Unlisted</Badge>
                    )}
                  </div>
                  {doc.description ? (
                    <div className="truncate text-xs text-muted-foreground">{doc.description}</div>
                  ) : null}
                  {doc.operationCount != null ? (
                    <div className="text-xs text-muted-foreground">{doc.operationCount} operations</div>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`${baseUrl}/d/${doc.slug}`, '_blank', 'noopener,noreferrer')}
                >
                  Open
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
