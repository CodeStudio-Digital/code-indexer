import * as http from 'http';

export interface SearchResult {
  type: 'file' | 'symbol';
  score: number;
  data: {
    id: number;
    path?: string;
    name?: string;
    summary?: string;
    kind?: string;
    project_id: number;
  };
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface Project {
  id: number;
  name: string;
  root_path: string;
  last_indexed: string | null;
}

export interface IndexRunResponse {
  run_id: number;
}

export class ApiClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.get<Project[]>('/api/projects');
      return true;
    } catch {
      return false;
    }
  }

  async listProjects(): Promise<Project[]> {
    const res = await this.get<{ projects: Project[] }>('/api/projects');
    return res.projects;
  }

  async findProjectByPath(rootPath: string): Promise<Project | undefined> {
    const projects = await this.listProjects();
    return projects.find((p) => p.root_path === rootPath);
  }

  async createProject(rootPath: string, name: string): Promise<Project> {
    return this.post<Project>('/api/projects', { root_path: rootPath, name });
  }

  async indexProject(projectId: number, provider: string, model: string): Promise<IndexRunResponse> {
    return this.post<IndexRunResponse>(`/api/projects/${projectId}/index`, { provider, model });
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const res = await this.get<SearchResponse>(`/api/search?${params}`);
    return res.results ?? [];
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const options: http.RequestOptions = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Request timeout')); });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}
