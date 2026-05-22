/**
 * AddSourceDialog — modal that adds a new source to a collection.
 *
 * Two tabs:
 *   - URL: paste URL + crawl knobs (max_pages, max_depth, same_origin).
 *          Default is "Apenas a URL informada" (crawl disabled) — opt in
 *          explicitly to walk the site.
 *   - PDF: drag-drop or click to choose a single .pdf (≤50MB).
 *
 * On submit, opens an inline `IndexProgressStream` panel and posts to
 * /api/docs/collections/:id/sources/{pdf|url} with `Accept: text/event-stream`.
 */
import { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FileText, Globe, Plus, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { Switch } from '../../components/ui/switch.js';
import {
  indexPdfStream,
  indexUrlStream,
  type DocCollection,
} from './docs-api.js';
import { IndexProgressStream } from './IndexProgressStream.js';

function Label(
  { htmlFor, children, className = '' }: {
    htmlFor?: string;
    children: React.ReactNode;
    className?: string;
  },
) {
  return (
    <label
      htmlFor={htmlFor}
      className={`text-sm font-medium leading-none ${className}`}
    >
      {children}
    </label>
  );
}

interface Props {
  collection: DocCollection;
  onAdded: () => void | Promise<void>;
}

const PDF_MAX_BYTES = 50 * 1024 * 1024;

export function AddSourceDialog({ collection, onAdded }: Props) {
  const { t } = useTranslation('docs');
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState<{ kind: 'pdf' | 'url' } | null>(null);

  // URL form state
  const [url, setUrl] = useState('');
  const [crawlEnabled, setCrawlEnabled] = useState(false);
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(2);
  const [sameOrigin, setSameOrigin] = useState(true);
  // Substring URL must contain (e.g. "/6000.3/Documentation/Manual/").
  // Empty = off. The server treats whitespace-only as off.
  const [requiredPath, setRequiredPath] = useState('');
  // When on, the crawler runs an LLM on the seed page to surface URLs
  // the static HTML parser missed (JS-rendered nav trees, data
  // attributes, embedded JSON page maps). 1 LLM call per source.
  const [llmExtractLinks, setLlmExtractLinks] = useState(false);
  // When on, the crawler bypasses the EscalatingFetcher heuristic and
  // renders every page via Chromium (ChromeService/Playwright). Required
  // for docs whose nav is JS-only (Unity ScriptReference, etc.) — the
  // body has plenty of content so `spa_shell`/`body_too_short` signals
  // don't fire. Available regardless of crawlEnabled — even a single
  // page can need browser rendering.
  const [forceBrowser, setForceBrowser] = useState(false);

  // PDF form state
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfTitle, setPdfTitle] = useState('');
  const [pdfError, setPdfError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function reset() {
    setUrl('');
    setCrawlEnabled(false);
    setMaxPages(50);
    setMaxDepth(2);
    setSameOrigin(true);
    setRequiredPath('');
    setLlmExtractLinks(false);
    setPdfFile(null);
    setPdfTitle('');
    setPdfError(null);
    setRunning(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      // Don't allow closing while ingestion is mid-stream — the user can
      // hit the dialog X again after `done` lands.
      if (running) return;
      reset();
    }
    setOpen(next);
  }

  function onPdfChosen(file: File | null) {
    setPdfError(null);
    if (!file) {
      setPdfFile(null);
      return;
    }
    if (file.size > PDF_MAX_BYTES) {
      setPdfError(t('addSource.pdfTooLarge', { size: (file.size / 1e6).toFixed(1) }));
      setPdfFile(null);
      return;
    }
    setPdfFile(file);
    if (!pdfTitle) setPdfTitle(file.name.replace(/\.pdf$/i, ''));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0] ?? null;
    if (file && !file.name.toLowerCase().endsWith('.pdf')) {
      setPdfError(t('addSource.pdfOnly'));
      return;
    }
    onPdfChosen(file);
  }

  async function onSubmitUrl() {
    if (!url.trim()) return;
    setRunning({ kind: 'url' });
  }

  async function onSubmitPdf() {
    if (!pdfFile) return;
    setRunning({ kind: 'pdf' });
  }

  async function onStreamClosed() {
    setRunning(null);
    await onAdded();
    setOpen(false);
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-3 w-3 mr-1" /> {t('addSource.button')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('addSource.title', { collection: collection.name })}</DialogTitle>
          <DialogDescription>
            {t('addSource.description')}
          </DialogDescription>
        </DialogHeader>

        {!running && (
          <Tabs defaultValue="url">
            <TabsList>
              <TabsTrigger value="url">
                <Globe className="h-3 w-3 mr-1" /> {t('addSource.tabsUrl')}
              </TabsTrigger>
              <TabsTrigger value="pdf">
                <FileText className="h-3 w-3 mr-1" /> {t('addSource.tabsPdf')}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-3 mt-3">
              <div className="space-y-1.5">
                <Label htmlFor="docs-url">{t('addSource.urlLabel')}</Label>
                <Input
                  id="docs-url"
                  type="url"
                  placeholder={t('addSource.urlPlaceholder')}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label className="block">{t('addSource.crawlEnabled')}</Label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('addSource.crawlEnabledHelp')}
                    </p>
                  </div>
                  <Switch checked={crawlEnabled} onCheckedChange={setCrawlEnabled} />
                </div>

                {crawlEnabled && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="docs-max-pages">{t('addSource.maxPages')}</Label>
                      <Input
                        id="docs-max-pages"
                        type="number"
                        min={1}
                        max={1000}
                        value={maxPages}
                        onChange={(e) => setMaxPages(Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="docs-max-depth">{t('addSource.maxDepth')}</Label>
                      <Input
                        id="docs-max-depth"
                        type="number"
                        min={0}
                        max={8}
                        value={maxDepth}
                        onChange={(e) => setMaxDepth(Number(e.target.value))}
                      />
                    </div>
                    <div className="col-span-2 flex items-center justify-between">
                      <Label htmlFor="docs-same-origin" className="text-xs text-muted-foreground">
                        {t('addSource.sameOrigin')}
                      </Label>
                      <Switch
                        id="docs-same-origin"
                        checked={sameOrigin}
                        onCheckedChange={setSameOrigin}
                      />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <Label htmlFor="docs-required-path">{t('addSource.requiredPath')}</Label>
                      <Input
                        id="docs-required-path"
                        type="text"
                        placeholder={t('addSource.requiredPathPlaceholder')}
                        value={requiredPath}
                        onChange={(e) => setRequiredPath(e.target.value)}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {t('addSource.requiredPathHelp')}
                      </p>
                    </div>
                    <div className="col-span-2 flex items-start justify-between gap-3 pt-1">
                      <div className="flex-1">
                        <Label htmlFor="docs-llm-extract-links" className="block">
                          {t('addSource.llmExtractLinks')}
                        </Label>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          <Trans
                            t={t}
                            i18nKey="addSource.llmExtractLinksHelp"
                            components={{ code: <code /> }}
                          />
                        </p>
                      </div>
                      <Switch
                        id="docs-llm-extract-links"
                        checked={llmExtractLinks}
                        onCheckedChange={setLlmExtractLinks}
                      />
                    </div>
                  </div>
                )}

                {/*
                  Force-browser toggle — OUTSIDE the `crawlEnabled` block.
                  Even a single-page index benefits when the nav is JS-only
                  (Unity ScriptReference seed page, sites with SPA shell that
                  still has body content). Persisted to `doc_sources.crawl_force_browser`
                  so re-index inherits the choice.
                */}
                <div className="flex items-start justify-between gap-3 border-t pt-3">
                  <div className="flex-1">
                    <Label htmlFor="docs-force-browser" className="block">
                      {t('addSource.forceBrowser')}
                    </Label>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      <Trans
                        t={t}
                        i18nKey="addSource.forceBrowserHelp"
                        components={{ code: <code /> }}
                      />
                    </p>
                  </div>
                  <Switch
                    id="docs-force-browser"
                    checked={forceBrowser}
                    onCheckedChange={setForceBrowser}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  {t('addSource.cancel')}
                </Button>
                <Button onClick={() => void onSubmitUrl()} disabled={!url.trim()}>
                  {t('addSource.submit')}
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="pdf" className="space-y-3 mt-3">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-md border-2 border-dashed p-8 text-center cursor-pointer hover:bg-muted/30 transition-colors"
              >
                <Upload className="h-6 w-6 mx-auto text-muted-foreground" />
                <div className="text-sm font-medium mt-2">
                  {pdfFile ? pdfFile.name : t('addSource.pdfDropzone')}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('addSource.pdfDropzoneHint')}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => onPdfChosen(e.target.files?.[0] ?? null)}
                />
              </div>
              {pdfError && <div className="text-xs text-destructive">{pdfError}</div>}
              {pdfFile && (
                <div className="space-y-1.5">
                  <Label htmlFor="docs-pdf-title">{t('addSource.pdfTitle')}</Label>
                  <Input
                    id="docs-pdf-title"
                    value={pdfTitle}
                    onChange={(e) => setPdfTitle(e.target.value)}
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  {t('addSource.cancel')}
                </Button>
                <Button onClick={() => void onSubmitPdf()} disabled={!pdfFile}>
                  {t('addSource.submit')}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        )}

        {running?.kind === 'url' && (
          <IndexProgressStream
            start={(cb) =>
              indexUrlStream(
                collection.id,
                {
                  url: url.trim(),
                  crawl: {
                    enabled: crawlEnabled,
                    max_pages: crawlEnabled ? maxPages : 1,
                    max_depth: crawlEnabled ? maxDepth : 0,
                    same_origin: sameOrigin,
                    required_path: requiredPath.trim() || undefined,
                    llm_extract_links: llmExtractLinks || undefined,
                    force_browser: forceBrowser || undefined,
                  },
                },
                cb,
              )
            }
            onClose={onStreamClosed}
          />
        )}

        {running?.kind === 'pdf' && pdfFile && (
          <IndexProgressStream
            start={(cb) => indexPdfStream(collection.id, pdfFile, cb, pdfTitle.trim() || undefined)}
            onClose={onStreamClosed}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
