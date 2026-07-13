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
import { FileText, Folder, Globe, Loader2, Plus, Upload } from 'lucide-react';
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
import { Textarea } from '../../components/ui/textarea.js';
import {
  indexFolderStream,
  dryRunFolder,
  indexPdfStream,
  indexUrlStream,
  type DocCollection,
  type DocType,
  type DocFolderPreview,
} from './docs-api.js';
import { DocTypeSelect } from './DocTypeSelect.js';
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
  const [running, setRunning] = useState<{ kind: 'pdf' | 'url' | 'folder' } | null>(null);
  /**
   * Sinalizado pelo `IndexProgressStream.onFinished` quando a stream
   * concluiu (done OU error). Distinto de `running`: o painel ainda
   * aparece (com summary final), mas o operador já pode fechar via X
   * do Dialog OU via "Fechar" interno — ambos convergem em
   * `onStreamClosed`. Sem essa flag, o X ficava bloqueado pra sempre
   * porque `running` só virava `null` no clique do botão interno.
   */
  const [streamFinished, setStreamFinished] = useState(false);

  // Documentation type (migration 149). Shared across all three tabs — the
  // operator tags the WHOLE source. Default 'mixed' never limits to API refs.
  const [docType, setDocType] = useState<DocType>('mixed');

  // URL form state
  const [url, setUrl] = useState('');
  const [crawlEnabled, setCrawlEnabled] = useState(false);
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(2);
  const [sameOrigin, setSameOrigin] = useState(true);
  // Substring(s) the URL must contain — 1 path por linha (PR 13). Vazio
  // = off. Server lê como newline-separated e dá OR (URL passa se contém
  // QUALQUER linha). Caso de uso típico: indexar Manual + ScriptReference
  // da mesma versão Unity em UMA source só. Backward compat: single-line
  // continua válido (vira lista de 1 elemento).
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
  // Hybrid mode: Chromium only on the seed (depth=0) so the JS-rendered
  // nav is captured once, then plain HTTP for every discovered leaf.
  // Most cost-effective option for Unity-ScriptReference-style sites.
  // Mutually exclusive with `forceBrowser` (force_browser wins per
  // crawler.ts policy); the UI greys this out when forceBrowser is on
  // so the priority is visible.
  const [browserSeedOnly, setBrowserSeedOnly] = useState(false);

  // PDF form state
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfTitle, setPdfTitle] = useState('');
  const [pdfError, setPdfError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Folder form state (migration 103). Absolute path obrigatório;
  // include/exclude globs com defaults sensíveis; bypass_relevance_gate
  // default TRUE (docs locais geralmente curados — operador opta-IN
  // pelo switch avançado se quiser rodar o gate em pastas mistas).
  const [folderPath, setFolderPath] = useState('');
  const [folderTitle, setFolderTitle] = useState('');
  const [folderIncludeGlob, setFolderIncludeGlob] = useState(
    '**/*.{html,htm,md,markdown,pdf,txt}',
  );
  const [folderExcludeGlob, setFolderExcludeGlob] = useState(
    '**/{node_modules,.git,dist,build,.next,target,vendor,.cache}/**',
  );
  // PR 11: default 5000→50000. Unity 6000.3 ScriptReference tem ~5-8k
  // arquivos; .NET 8 reference tem ~30k; defaults grandes evitam o user
  // ter que mexer no Avançado pra cobrir cenários comuns. Hard cap
  // server-side é 500.000 (input `max` reflete isso).
  const [folderMaxFiles, setFolderMaxFiles] = useState(50000);
  const [folderBypassGate, setFolderBypassGate] = useState(true);
  const [folderEnrichmentMode, setFolderEnrichmentMode] = useState<'selective' | 'all' | 'off'>('selective');
  const [folderPerformanceProfile, setFolderPerformanceProfile] = useState<'economy' | 'balanced' | 'maximum' | 'custom'>('balanced');
  const [folderWorkerCount, setFolderWorkerCount] = useState(6);
  const [folderAdvancedOpen, setFolderAdvancedOpen] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderPreview, setFolderPreview] = useState<DocFolderPreview | null>(null);
  const [folderPreviewing, setFolderPreviewing] = useState(false);

  function reset() {
    setDocType('mixed');
    setFolderEnrichmentMode('selective');
    setFolderPerformanceProfile('balanced');
    setFolderWorkerCount(6);
    setFolderPreview(null);
    setUrl('');
    setCrawlEnabled(false);
    setMaxPages(50);
    setMaxDepth(2);
    setSameOrigin(true);
    setRequiredPath('');
    setLlmExtractLinks(false);
    // Render-mode flags — both were missing from reset() before this
    // PR (carry-over bug from when force_browser was added). Now that
    // there are two toggles, the leak was visible: reopening the modal
    // after a previous run would keep the prior selections checked.
    setForceBrowser(false);
    setBrowserSeedOnly(false);
    setPdfFile(null);
    setPdfTitle('');
    setPdfError(null);
    // Folder form
    setFolderPath('');
    setFolderTitle('');
    setFolderIncludeGlob('**/*.{html,htm,md,markdown,pdf,txt}');
    setFolderExcludeGlob('**/{node_modules,.git,dist,build,.next,target,vendor,.cache}/**');
    setFolderMaxFiles(50000);
    setFolderBypassGate(true);
    setFolderAdvancedOpen(false);
    setFolderError(null);
    setRunning(null);
    setStreamFinished(false);
  }

  async function previewFolder() {
    if (!folderPath.trim()) return;
    setFolderPreviewing(true);
    setFolderError(null);
    try {
      setFolderPreview(await dryRunFolder({
        path: folderPath.trim(),
        doc_type: docType,
        enrichment_mode: folderEnrichmentMode,
        folder: {
          include_glob: folderIncludeGlob.trim() || undefined,
          exclude_glob: folderExcludeGlob.trim() || undefined,
          max_files: folderMaxFiles,
          bypass_relevance_gate: folderBypassGate,
          performance_profile: folderPerformanceProfile,
          worker_count: folderPerformanceProfile === 'custom' ? folderWorkerCount : undefined,
        },
      }));
    } catch (error) {
      setFolderError((error as Error).message);
    } finally {
      setFolderPreviewing(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      if (streamFinished) {
        void onStreamClosed();
        return;
      }
      // Mid-stream: fechar é permitido — a indexação roda server-side
      // (não está atrelada a esta conexão), então dispensar o painel
      // só esconde o progresso; o run continua em segundo plano. Antes
      // o X ficava bloqueado até a stream concluir. Refaz a lista pra
      // que a source em andamento já apareça enquanto indexa.
      if (running) void onAdded();
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

  async function onSubmitFolder() {
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setFolderError(null);
    setRunning({ kind: 'folder' });
  }

  async function onStreamClosed() {
    setRunning(null);
    setStreamFinished(false);
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
          <div className="space-y-4">
            <DocTypeSelect value={docType} onChange={setDocType} />

            <Tabs defaultValue="url">
            <TabsList>
              <TabsTrigger value="url">
                <Globe className="h-3 w-3 mr-1" /> {t('addSource.tabsUrl')}
              </TabsTrigger>
              <TabsTrigger value="pdf">
                <FileText className="h-3 w-3 mr-1" /> {t('addSource.tabsPdf')}
              </TabsTrigger>
              <TabsTrigger value="folder">
                <Folder className="h-3 w-3 mr-1" /> {t('addSource.tabsFolder')}
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
                      <Textarea
                        id="docs-required-path"
                        rows={3}
                        placeholder={t('addSource.requiredPathPlaceholder')}
                        value={requiredPath}
                        onChange={(e) => setRequiredPath(e.target.value)}
                        className="font-mono text-xs"
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
                  Render-mode toggles — OUTSIDE the `crawlEnabled` block.
                  Even a single-page index benefits when the nav is JS-only
                  (Unity ScriptReference seed page, sites with SPA shell that
                  still has body content). Two flags:
                    * forceBrowser     → Chromium every page (expensive).
                    * browserSeedOnly  → Chromium just on the seed, plain
                                          HTTP for leaves (sweet spot for
                                          Unity-style nav).
                  Both persist in doc_sources so re-index inherits.
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
                    onCheckedChange={(v) => {
                      setForceBrowser(v);
                      // Mutually exclusive with the seed-only mode — turning
                      // force_browser on subsumes seed-only.
                      if (v) setBrowserSeedOnly(false);
                    }}
                  />
                </div>

                <div className="flex items-start justify-between gap-3 pt-1">
                  <div className="flex-1">
                    <Label htmlFor="docs-browser-seed-only" className="block">
                      {t('addSource.browserSeedOnly')}
                    </Label>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      <Trans
                        t={t}
                        i18nKey="addSource.browserSeedOnlyHelp"
                        components={{ code: <code /> }}
                      />
                    </p>
                  </div>
                  <Switch
                    id="docs-browser-seed-only"
                    checked={browserSeedOnly}
                    disabled={forceBrowser}
                    onCheckedChange={setBrowserSeedOnly}
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

            {/*
              Folder tab (migration 103). Path absoluto no FS do servidor —
              o backend valida no POST e retorna 400 estruturado se algo
              estiver errado. Bloco "Avançado" colapsável esconde glob/
              max_files/bypass_gate por padrão pra UX limpa.
            */}
            <TabsContent value="folder" className="space-y-3 mt-3">
              <div className="space-y-1.5">
                <Label htmlFor="docs-folder-path">{t('addSource.folderPath')}</Label>
                <Input
                  id="docs-folder-path"
                  type="text"
                  placeholder={t('addSource.folderPathPlaceholder')}
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t('addSource.folderPathHelp')}
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="docs-folder-title">{t('addSource.folderTitle')}</Label>
                <Input
                  id="docs-folder-title"
                  type="text"
                  placeholder={t('addSource.folderTitlePlaceholder')}
                  value={folderTitle}
                  onChange={(e) => setFolderTitle(e.target.value)}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <button
                  type="button"
                  className="w-full text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => setFolderAdvancedOpen((v) => !v)}
                >
                  {folderAdvancedOpen ? '▾' : '▸'} {t('addSource.folderAdvanced')}
                </button>

                {folderAdvancedOpen && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="docs-folder-include">{t('addSource.folderIncludeGlob')}</Label>
                      <Input
                        id="docs-folder-include"
                        type="text"
                        value={folderIncludeGlob}
                        onChange={(e) => setFolderIncludeGlob(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="docs-folder-exclude">{t('addSource.folderExcludeGlob')}</Label>
                      <Input
                        id="docs-folder-exclude"
                        type="text"
                        value={folderExcludeGlob}
                        onChange={(e) => setFolderExcludeGlob(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="docs-folder-max-files">{t('addSource.folderMaxFiles')}</Label>
                      <Input
                        id="docs-folder-max-files"
                        type="number"
                        min={1}
                        max={500000}
                        value={folderMaxFiles}
                        onChange={(e) => setFolderMaxFiles(Number(e.target.value))}
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {t('addSource.folderMaxFilesHelp')}
                      </p>
                    </div>
                    <div className="flex items-start justify-between gap-3 pt-1">
                      <div className="flex-1">
                        <Label htmlFor="docs-folder-bypass-gate" className="block">
                          {t('addSource.folderBypassGate')}
                        </Label>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t('addSource.folderBypassGateHelp')}
                        </p>
                      </div>
                      <Switch
                        id="docs-folder-bypass-gate"
                        checked={folderBypassGate}
                        onCheckedChange={setFolderBypassGate}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="docs-folder-performance">{t('addSource.performanceProfile')}</Label>
                      <select
                        id="docs-folder-performance"
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                        value={folderPerformanceProfile}
                        onChange={(event) => setFolderPerformanceProfile(event.target.value as typeof folderPerformanceProfile)}
                      >
                        <option value="economy">{t('addSource.performanceProfiles.economy')}</option>
                        <option value="balanced">{t('addSource.performanceProfiles.balanced')}</option>
                        <option value="maximum">{t('addSource.performanceProfiles.maximum')}</option>
                        <option value="custom">{t('addSource.performanceProfiles.custom')}</option>
                      </select>
                      {folderPerformanceProfile === 'custom' && (
                        <Input
                          type="number"
                          min={1}
                          max={16}
                          value={folderWorkerCount}
                          onChange={(event) => setFolderWorkerCount(Number(event.target.value))}
                        />
                      )}
                      <p className="text-[11px] text-muted-foreground">{t('addSource.performanceProfileHelp')}</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="docs-folder-enrichment">{t('addSource.enrichmentMode')}</Label>
                      <select
                        id="docs-folder-enrichment"
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                        value={folderEnrichmentMode}
                        onChange={(event) => setFolderEnrichmentMode(event.target.value as 'selective' | 'all' | 'off')}
                      >
                        <option value="selective">{t('addSource.enrichmentModes.selective')}</option>
                        <option value="all">{t('addSource.enrichmentModes.all')}</option>
                        <option value="off">{t('addSource.enrichmentModes.off')}</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground">{t('addSource.enrichmentModeHelp')}</p>
                    </div>
                  </div>
                )}
              </div>

              {folderError && <div className="text-xs text-destructive">{folderError}</div>}

              {folderPreview && (
                <div className="rounded-md border bg-muted/20 p-3 text-xs grid grid-cols-2 gap-1">
                  <span>{t('addSource.previewExtractor')}</span><strong>{folderPreview.extractor}</strong>
                  <span>{t('addSource.previewFiles')}</span><strong>{folderPreview.files_to_process}/{folderPreview.files_found}</strong>
                  <span>{t('addSource.previewChunks')}</span><strong>~{folderPreview.estimated_chunks}</strong>
                  <span>{t('addSource.previewDocType')}</span><strong>{folderPreview.detected_doc_type}</strong>
                  <span>{t('addSource.previewLlmCalls')}</span><strong>{folderPreview.estimated_llm_calls}</strong>
                  <span>{t('addSource.previewWorkers')}</span><strong>{folderPreview.configured_workers}/{folderPreview.available_workers}</strong>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => void previewFolder()} disabled={!folderPath.trim() || folderPreviewing}>
                  {folderPreviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : t('addSource.preview')}
                </Button>
                <Button variant="ghost" onClick={() => handleOpenChange(false)}>
                  {t('addSource.cancel')}
                </Button>
                <Button
                  onClick={() => void onSubmitFolder()}
                  disabled={!folderPath.trim()}
                >
                  {t('addSource.submit')}
                </Button>
              </div>
            </TabsContent>
            </Tabs>
          </div>
        )}

        {running?.kind === 'url' && (
          <IndexProgressStream
            start={(cb) =>
              indexUrlStream(
                collection.id,
                {
                  url: url.trim(),
                  doc_type: docType,
                  crawl: {
                    enabled: crawlEnabled,
                    max_pages: crawlEnabled ? maxPages : 1,
                    max_depth: crawlEnabled ? maxDepth : 0,
                    same_origin: sameOrigin,
                    required_path: requiredPath.trim() || undefined,
                    llm_extract_links: llmExtractLinks || undefined,
                    force_browser: forceBrowser || undefined,
                    browser_seed_only: browserSeedOnly || undefined,
                  },
                },
                cb,
              )
            }
            onClose={onStreamClosed}
            onFinished={() => setStreamFinished(true)}
          />
        )}

        {running?.kind === 'pdf' && pdfFile && (
          <IndexProgressStream
            start={(cb) => indexPdfStream(collection.id, pdfFile, cb, pdfTitle.trim() || undefined, docType)}
            onClose={onStreamClosed}
            onFinished={() => setStreamFinished(true)}
          />
        )}

        {running?.kind === 'folder' && (
          <IndexProgressStream
            start={(cb) =>
              indexFolderStream(
                collection.id,
                {
                  path: folderPath.trim(),
                  title: folderTitle.trim() || undefined,
                  doc_type: docType,
                  enrichment_mode: folderEnrichmentMode,
                  folder: {
                    include_glob: folderIncludeGlob.trim() || undefined,
                    exclude_glob: folderExcludeGlob.trim() || undefined,
                    max_files: folderMaxFiles,
                    bypass_relevance_gate: folderBypassGate,
                    performance_profile: folderPerformanceProfile,
                    worker_count: folderPerformanceProfile === 'custom' ? folderWorkerCount : undefined,
                  },
                },
                cb,
              )
            }
            onClose={onStreamClosed}
            onFinished={() => setStreamFinished(true)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
