import type { Command } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDB } from '../helpers.js';

export function register(program: Command): void {
  const projects = program.command('projects').description('Manage projects');

  projects
    .command('list')
    .alias('ls')
    .description('List all projects')
    .action(() => {
      const db = getDB();
      const list = db.listProjects();
      if (list.length === 0) {
        console.log('No projects registered.');
      } else {
        console.log(`${'Name'.padEnd(30)} ${'Path'.padEnd(50)} ${'Files'.padStart(6)} ${'Last Indexed'.padEnd(20)}`);
        console.log('-'.repeat(110));
        for (const p of list) {
          console.log(`${p.name.padEnd(30)} ${p.root_path.padEnd(50)} ${String(p.file_count).padStart(6)} ${p.last_indexed ?? 'Never'}`);
        }
      }
      db.close();
    });

  projects
    .command('add <name> <path>')
    .description('Add a new project')
    .option('-d, --description <desc>', 'Project description')
    .action((name: string, path: string, opts: { description?: string }) => {
      const db = getDB();
      const project = db.createProject(name, resolve(path), opts.description);
      console.log(`Project "${project.name}" created (id: ${project.id})`);
      db.close();
    });

  projects
    .command('remove <name>')
    .description('Remove a project')
    .action((name: string) => {
      const db = getDB();
      const project = db.getProjectByName(name);
      if (!project) { console.error(`Project "${name}" not found.`); process.exit(1); }
      db.deleteProject(project.id);
      console.log(`Project "${name}" removed.`);
      db.close();
    });

  projects
    .command('edit <name>')
    .description('Edit project metadata (name, description, root path)')
    .option('--new-name <name>', 'New project name')
    .option('-d, --description <desc>', 'New description')
    .option('--path <path>', 'New root path (pasta do código)')
    .action((name: string, opts: { newName?: string; description?: string; path?: string }) => {
      const db = getDB();
      const project = db.getProjectByName(name);
      if (!project) { console.error(`Project "${name}" not found.`); db.close(); process.exit(1); }

      const updates: { name?: string; description?: string; root_path?: string } = {};

      if (opts.newName !== undefined) {
        const newName = opts.newName.trim();
        if (!newName) { console.error('--new-name cannot be empty'); db.close(); process.exit(1); }
        const existing = db.getProjectByName(newName);
        if (existing && existing.id !== project.id) {
          console.error(`Project name "${newName}" already in use.`); db.close(); process.exit(1);
        }
        updates.name = newName;
      }

      if (opts.description !== undefined) {
        updates.description = opts.description;
      }

      if (opts.path !== undefined) {
        const absPath = resolve(opts.path);
        if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
          console.error(`Path "${absPath}" is not an existing directory.`); db.close(); process.exit(1);
        }
        const existing = db.getProjectByPath(absPath);
        if (existing && existing.id !== project.id) {
          console.error(`Path "${absPath}" already used by another project.`); db.close(); process.exit(1);
        }
        updates.root_path = absPath;
      }

      if (Object.keys(updates).length === 0) {
        console.log('Nothing to update. Pass --new-name, --description, or --path.');
        db.close();
        return;
      }

      db.updateProject(project.id, updates);
      const updated = db.getProject(project.id)!;
      console.log(`Project "${updated.name}" updated.`);
      console.log(`  Path: ${updated.root_path}`);
      console.log(`  Description: ${updated.description ?? '-'}`);
      db.close();
    });

  projects
    .command('info <name>')
    .description('Show project info')
    .action((name: string) => {
      const db = getDB();
      const project = db.getProjectByName(name);
      if (!project) { console.error(`Project "${name}" not found.`); process.exit(1); }
      const stats = db.getStats(project.id);
      console.log(`Name: ${project.name}`);
      console.log(`Path: ${project.root_path}`);
      console.log(`Description: ${project.description ?? '-'}`);
      console.log(`Provider: ${project.provider ?? 'auto'} | Model: ${project.model ?? 'auto'}`);
      console.log(`Files: ${stats.file_count} | Symbols: ${stats.symbol_count} | Lines: ${stats.total_lines}`);
      console.log(`Languages: ${Object.entries(stats.languages).map(([l, c]) => `${l}(${c})`).join(', ')}`);
      console.log(`Last Indexed: ${stats.last_indexed ?? 'Never'} | Runs: ${stats.run_count}`);
      db.close();
    });
}
