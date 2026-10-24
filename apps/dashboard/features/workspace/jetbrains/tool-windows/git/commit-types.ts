
export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
  parents?: string[];
  refs?: string[];
}
