export interface DBFile {
  id: number;
  path: string;
  language: string;
  line_count: number;
}

export interface Dependency {
  import_path: string;
  dep_type: string;
  target_file_path: string | null;
}
export interface Dependent {
  source_file_path: string;
  import_path: string;
}
export interface CircularDep {
  file_a: string;
  file_b: string;
}
