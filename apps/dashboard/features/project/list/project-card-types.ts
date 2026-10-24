
export interface ProjectCardData {
  id: number;
  name: string;
  root_path: string;
  description?: string | null;
  group_name?: string | null;
  file_count: number;
  symbol_count: number;
  last_indexed: string | null;
}
