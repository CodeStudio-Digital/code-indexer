# Keymap & Editor Actions - Current State

## Registered Commands (project-commands.ts)

### Navigate Category (7 commands)
- navigate.searchEverywhere: Shift Shift / Ctrl+T
- navigate.file: Ctrl+Shift+N / Ctrl+P
- navigate.symbol: Ctrl+N / Ctrl+Shift+O (desktop only)
- navigate.textSearch: Ctrl+Shift+F / Ctrl+Shift+F
- navigate.commands: Ctrl+Shift+A / Ctrl+Shift+P
- navigate.recentFiles: Ctrl+E / Ctrl+E
- navigate.fileStructure: Ctrl+F12 / Ctrl+Shift+O
- navigate.line: Ctrl+G / Ctrl+G

### File Category (3 commands)
- file.save: Ctrl+S / Ctrl+S
- file.saveAll: Ctrl+Shift+S / Ctrl+Shift+S
- file.closeTab: Ctrl+F4 / Ctrl+W (desktop only)

### View Category (7 commands)
- view.toggleTerminal: Alt+F12 / Ctrl+J
- view.toggleProjectTree: Alt+1 / Ctrl+B
- view.toggleChat: Alt+2 / Ctrl+Alt+B
- view.keymapSettings: Ctrl+Alt+S / Ctrl+K Ctrl+S
- view.splitEditorRight: (no default keys)
- view.splitEditorDown: (no default keys)
- view.unsplitEditor: (no default keys)

## Editor-Level Keybindings (monaco-keymap.ts - IntelliJ preset only)

Implemented as addKeybindingRules:
- Ctrl+D: editor.action.copyLinesDownAction (duplicate line)
- Ctrl+Shift+D: editor.action.addSelectionToNextFindMatch (kept for VS Code compat)
- Ctrl+Y: editor.action.deleteLines
- Alt+Shift+Up: editor.action.moveLinesUpAction
- Alt+Shift+Down: editor.action.moveLinesDownAction
- Ctrl+Alt+L: editor.action.formatDocument
- Ctrl+W: editor.action.smartSelect.expand
- Ctrl+Shift+W: editor.action.smartSelect.shrink
- Ctrl+B: editor.action.revealDefinition
- Alt+F7: editor.action.goToReferences
- Shift+F6: editor.action.rename

## Monaco Editor Actions (registered via addAction in MonacoMount)

### Chat Actions
- mcp.addSelectionToChat: Ctrl+I (keybinding added)
- mcp.addFileToChat: (no binding, context menu only)

### Run Actions
- mcp.runFile: Shift+F10

## Missing IntelliJ Classic Actions (NOT IMPLEMENTED)

Critical missing (frequently used):
1. Toggle Line Comment: Ctrl+/ (no implementation)
2. Toggle Block Comment: Ctrl+Shift+/ (no implementation)
3. Navigate Back: Ctrl+Alt+Left (not found)
4. Navigate Forward: Ctrl+Alt+Right (not found)
5. Goto Declaration with Popup: Ctrl+Shift+I (not found)
6. Optimize Imports: Ctrl+Alt+O (not found)
7. Reformat Selection: Ctrl+Alt+L only works on whole doc (not selection)
8. Parameter Info: Ctrl+P (conflicts with navigate.file in VS Code preset)
9. Quick Doc Lookup: Ctrl+Q (not found)
10. Quick Fix: Alt+Enter (not found)
11. Surround with: Ctrl+Alt+T (not found)
12. Join Lines: Ctrl+Shift+J (not found)
13. Select Next Occurrence: Alt+J (not found)
14. Duplicate Line: Ctrl+D (EXISTS - good)
15. Delete Line: Ctrl+Y (EXISTS - good, but conflicts with redo)
16. Move Statement Up/Down: Ctrl+Shift+Up/Down (implemented as line move, not statement)
17. Expand/Shrink Selection: Ctrl+W/Ctrl+Shift+W (EXISTS - good)
18. File Structure Popup: Ctrl+F12 (EXISTS - good)
19. Recent Files: Ctrl+E (EXISTS - good)
20. Save All: Ctrl+Shift+S (EXISTS - good)

## Language Configuration (setLanguageConfiguration)

NO setLanguageConfiguration calls found in codebase.
This means:
- lineComment / blockComment configuration NOT set for any language
- Monaco falls back to defaults (which differ by language)
- Bracket matching NOT explicitly configured
- Auto-closing pairs NOT explicitly set
- Folding regions NOT configured
- onEnterRules for /** continuation NOT implemented

### PHP Language
- enrichedPhp() provides custom Monarch tokenizer
- Semantic tokens via LSP (intelephense Premium)
- No setLanguageConfiguration - missing explicit comment configuration

### Other Languages
- All use Monaco's built-in defaults
- No explicit bracket/folding/indentation rules
