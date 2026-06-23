import { describe, it, expect } from 'vitest';
import { mapLspConfigSection, languageLevelForServer, initOptionsForServer } from '../lsp-config-map.js';

describe('lsp-config-map', () => {
  describe('languageLevelForServer', () => {
    it('mapeia serverId → chave de linguagem', () => {
      expect(languageLevelForServer('intelephense', { php: '8.2' })).toBe('8.2');
      expect(languageLevelForServer('pyright', { python: '3.11' })).toBe('3.11');
      expect(languageLevelForServer('intelephense', { python: '3.11' })).toBeUndefined();
      expect(languageLevelForServer('vscode-langservers', { php: '8.2' })).toBeUndefined();
      expect(languageLevelForServer('desconhecido', { php: '8.2' })).toBeUndefined();
    });
  });

  describe('mapLspConfigSection — intelephense', () => {
    it('seção intelephense (ou null) → environment.phpVersion (SÓ a versão, sem config de completion)', () => {
      const expected = { environment: { phpVersion: '8.2' } };
      expect(mapLspConfigSection('intelephense', 'intelephense', { php: '8.2' })).toEqual(expected);
      expect(mapLspConfigSection('intelephense', null, { php: '8.2' })).toEqual(expected);
    });
    it('outra seção → null', () => {
      expect(mapLspConfigSection('intelephense', 'python', { php: '8.2' })).toBeNull();
    });
    it('sem versão setada → null (server usa defaults completos — não silenciar a completion)', () => {
      expect(mapLspConfigSection('intelephense', 'intelephense', {})).toBeNull();
    });
  });

  describe('mapLspConfigSection — pyright', () => {
    it('seção python → analysis.pythonVersion', () => {
      expect(mapLspConfigSection('pyright', 'python', { python: '3.10' })).toEqual({
        analysis: { pythonVersion: '3.10' },
      });
    });
    it('seção python.analysis → pythonVersion', () => {
      expect(mapLspConfigSection('pyright', 'python.analysis', { python: '3.10' })).toEqual({
        pythonVersion: '3.10',
      });
    });
    it('sem versão → null', () => {
      expect(mapLspConfigSection('pyright', 'python.analysis', {})).toBeNull();
    });
    it('seção não reconhecida → null', () => {
      expect(mapLspConfigSection('pyright', 'editor', { python: '3.10' })).toBeNull();
    });
  });

  it('server desconhecido → null', () => {
    expect(mapLspConfigSection('vscode-langservers', 'css', { php: '8.2', python: '3.10' })).toBeNull();
  });

  describe('initOptionsForServer', () => {
    it('intelephense com versão → environment.phpVersion', () => {
      expect(initOptionsForServer('intelephense', '8.1')).toEqual({ environment: { phpVersion: '8.1' } });
    });
    it('pyright → undefined (vai só por workspace/configuration)', () => {
      expect(initOptionsForServer('pyright', '3.11')).toBeUndefined();
    });
    it('sem versão → undefined', () => {
      expect(initOptionsForServer('intelephense', undefined)).toBeUndefined();
    });
  });
});
